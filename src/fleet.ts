/*
 * 原始需求（2026-10-24）：多开 runner 的统一管理——发现、启动、关闭、按日志实时分析最近动作成败，
 * 并把全量快照推给 UI。本模块是无托盘依赖的领域编排器（可无头测试）。
 *
 * 正交意图：
 * 1. 实例注册表：配置实例 ∪ 磁盘发现实例，autoStart 持久化。
 * 2. 进程面：受控 spawn/stop（supervisor）与外部 Runner.Listener 进程对账（pgrep/lsof）。
 * 3. 日志面：_diag/Runner_*.log 跟随 → parseConsoleLine 事件 → currentJob/lastResult 状态机 + 日志环。
 * 4. 快照发射：变更去抖后全量推送（seq 单调递增）。
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { DirTail } from "./tailer.ts";
import { normalizeLine, parseConsoleLine, stripDiagPrefix } from "./logparse.ts";
import {
  discoverRunnerDirs,
  findListenerProcesses,
  instanceIdOf,
  pidIdentity,
  readRunnerMeta,
  type RunnerMeta,
} from "./discover.ts";
import {
  pidExists,
  startRunner,
  stopProcessGroup,
  type SpawnedRunner,
} from "./supervisor.ts";
import { loadConfig, saveConfig, upsertInstance } from "./config.ts";
import { registerRunner, type RegisterRequest } from "./register.ts";
import {
  listPackages,
  fetchLatestReleaseInfo,
  downloadPackage,
  type DownloadState,
} from "./packages.ts";
import { ARCH, PLATFORM, isAbsolutePath } from "./platform.ts";
import type {
  CurrentJob,
  FleetTask,
  InstanceView,
  ProcessState,
  Snapshot,
  ToolConfig,
} from "./types.ts";

const LOG_RING_MAX = 400;
const DEDUP_MAX = 2400;
const TICK_MS = 2000;
const DEBOUNCE_MS = 200;

export interface BootOptions {
  /** 启动时自动拉起 autoStart 实例；--dry-run/--smoke 等验证模式必须传 false（保持无副作用）。 */
  autoStart?: boolean;
  /** 允许写回 config.json；验证模式传 false（只读）。 */
  persist?: boolean;
}

interface Rt {
  id: string;
  dir: string;
  meta: RunnerMeta | null;
  processState: ProcessState;
  external: boolean;
  autoStart: boolean;
  pid: number | null;
  child: SpawnedRunner | null;
  currentJob: CurrentJob | null;
  lastResult: InstanceView["lastResult"];
  lastError: string | null;
  log: string[];
  /** 日志绝对追加计数（环绕挤出也计数），供增量推送对位。 */
  logTotal: number;
  seen: Set<string>;
  tail: DirTail | null;
  stoppingUntilMs: number;
}

export type SnapshotListener = (snapshot: Snapshot) => void;

export class Fleet {
  #rts = new Map<string, Rt>();
  #config: ToolConfig | null = null;
  #listeners = new Set<SnapshotListener>();
  #seq = 0;
  #dirty = false;
  #debounceTimer: NodeJS.Timeout | null = null;
  #tickTimer: NodeJS.Timeout | null = null;
  #task: FleetTask = { kind: "none", status: "ok", message: null };
  #ticking = false;
  #persist = true;
  #download: DownloadState | null = null;
  #downloading = false;

  async boot(options: BootOptions = {}): Promise<void> {
    this.#persist = options.persist ?? true;
    this.#config = await loadConfig();
    await this.#syncInstances();
    // 先同步对账一轮：外部进程归位后，autoStart 才不会与已在跑的实例打架。
    await this.#tick();
    this.#tickTimer = setInterval(() => void this.#tick(), TICK_MS);
    this.#tickTimer.unref?.();
    if (options.autoStart ?? true) {
      // autoStart：配置了自启且未在跑的受管实例
      for (const rt of this.#rts.values()) {
        if (rt.autoStart && rt.meta?.configured && rt.processState === "stopped") {
          void this.start(rt.id);
        }
      }
    }
  }

  onSnapshot(listener: SnapshotListener): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  snapshot(): Snapshot {
    this.#seq += 1;
    return {
      seq: this.#seq,
      now: new Date().toISOString(),
      platform: PLATFORM,
      arch: ARCH,
      instances: [...this.#rts.values()]
        .map((rt) => this.#view(rt))
        .sort((a, b) => a.name.localeCompare(b.name)),
      task: this.#task,
      packages: this.#packages,
      download: this.#download,
    };
  }

  #packages: Snapshot["packages"] = [];

  /** 刷新包清单（下载目录 ∪ 导入清单），变更时推送。 */
  async #refreshPackages(): Promise<void> {
    try {
      const before = JSON.stringify(this.#packages);
      const stale: string[] = [];
      this.#packages = await listPackages(this.#config?.importedPackages ?? []);
      const paths = new Set(this.#packages.map((p) => p.path));
      for (const imported of this.#config?.importedPackages ?? []) {
        if (!paths.has(imported)) stale.push(imported);
      }
      if (stale.length > 0 && this.#config) {
        // 导入的包文件已被删除：从清单登记中移除（下载缓存目录里的由 listPackages 自行过滤）。
        this.#config.importedPackages = (this.#config.importedPackages ?? []).filter(
          (p) => !stale.includes(p),
        );
        if (this.#persist) await saveConfig(this.#config);
      }
      if (JSON.stringify(this.#packages) !== before) this.#emitSoon();
    } catch {
      /* 清单刷新失败不拖垮 tick */
    }
  }

  /** 下载 actions/runner 最新平台的包（进度写入 snapshot.download，完成后刷新清单）。 */
  async downloadLatest(): Promise<void> {
    if (this.#downloading) return;
    this.#downloading = true;
    this.#download = { status: "running", pct: 0, message: "查询最新 release…" };
    this.#emitSoon();
    try {
      const release = await fetchLatestReleaseInfo();
      this.#download = { status: "running", pct: 0, message: `下载 ${release.assetName}` };
      this.#emitSoon();
      const dest = await downloadPackage(release, (pct) => {
        this.#download = { status: "running", pct, message: `下载 ${release.assetName}` };
        this.#emitSoon();
      });
      this.#download = { status: "ok", pct: 100, message: `已下载 ${dest}` };
      await this.#refreshPackages();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#download = { status: "error", pct: 0, message };
    } finally {
      this.#downloading = false;
      this.#emitSoon();
      // 成功态停留一段时间后清除
      setTimeout(() => {
        if (this.#download && this.#download.status !== "running") {
          this.#download = null;
          this.#emitSoon();
        }
      }, 8000).unref?.();
    }
  }

  /** 通过系统文件选择对话框导入本地包路径（登记进 config，不复制）。 */
  async importPackage(path: string): Promise<void> {
    if (!this.#config || !isAbsolutePath(path)) return;
    if (!this.#config.importedPackages.includes(path)) {
      this.#config.importedPackages = [...this.#config.importedPackages, path];
      if (this.#persist) await saveConfig(this.#config);
    }
    await this.#refreshPackages();
  }

  /** 页面加载完成后的主动重推（对齐 hello）。 */
  ping(): void {
    this.#emit();
  }

  view(id: string): InstanceView | null {
    const rt = this.#rts.get(id);
    return rt ? this.#view(rt) : null;
  }

  async start(id: string): Promise<void> {
    const rt = this.#rts.get(id);
    if (!rt) return;
    if (rt.processState === "running" || rt.processState === "starting") return;
    if (!rt.meta?.configured) {
      rt.lastError = "实例尚未注册（目录缺 .runner），先走注册表单";
      this.#emit();
      return;
    }
    rt.lastError = null;
    let spawnError: Error | null = null;
    const spawned = startRunner(
      rt.dir,
      (stream, line) => this.#onManagedLine(rt, stream, line),
      (err) => {
        spawnError = err;
      },
    );
    if (!spawned) {
      rt.lastError = "无法启动 runner（检查 run.sh / Runner.Listener.exe 是否存在且有执行权限）";
      this.#emit();
      return;
    }
    rt.child = spawned;
    rt.pid = spawned.pid;
    rt.external = false;
    rt.processState = "starting";
    // spawn 失败只发 error+close 不发 exit——必须用 close 收尾（exit 的超集）。
    spawned.child.on("close", (code, signal) => {
      if (rt.child?.pid !== spawned.pid) return;
      rt.child = null;
      rt.pid = null;
      rt.processState = "stopped";
      rt.currentJob = null;
      const graceful = signal === "SIGTERM" || code === 0;
      rt.lastError = spawnError
        ? `启动失败：${spawnError.message}`
        : graceful
          ? null
          : `进程退出 code=${code} signal=${signal ?? "none"}（详见日志）`;
      this.#emitSoon();
    });
    this.#emitSoon();
  }

  async stop(id: string): Promise<void> {
    const rt = this.#rts.get(id);
    if (!rt) return;
    if (rt.processState !== "running" && rt.processState !== "starting") return;
    if (rt.pid == null) return;
    rt.processState = "stopping";
    rt.stoppingUntilMs = Date.now() + 15_000;
    this.#emit();
    const pid = rt.pid;
    const wasExternal = rt.external;
    if (wasExternal) {
      // pid 复用防护：终止前核对该 pid 的身份（cwd/可执行路径）仍是本实例目录。
      const identity = await pidIdentity(pid);
      const rtDirReal = await realpath(rt.dir).catch(() => rt.dir);
      const same = (a: string | null, b: string): boolean => {
        if (a === null) return false;
        if (PLATFORM === "win32") return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
        return a === b || a === rtDirReal;
      };
      if (identity === null) {
        if (pidExists(pid) !== "dead") {
          // 读不到身份（可能是 root 属主），但进程还活着：继续尝试，失败会以 EPERM 暴露。
        } else {
          rt.pid = null;
          rt.external = false;
          rt.processState = "stopped";
          rt.currentJob = null;
          this.#emit();
          return;
        }
      } else if (!same(identity, rt.dir)) {
        rt.lastError = "停止已取消：该 pid 已不属于本实例（等待重新对账）";
        rt.pid = null;
        rt.external = false;
        rt.processState = "stopped";
        this.#emit();
        return;
      }
    }
    const ok = await stopProcessGroup(pid, wasExternal ? 6000 : 8000);
    if (wasExternal) {
      // 外部进程：无 child 事件，需手动收尾。
      rt.external = false;
      rt.pid = null;
      rt.processState = ok ? "stopped" : "running";
      if (!ok) rt.lastError = "停止失败：进程无响应或无权限（可能由 sudo 启动）";
      rt.currentJob = null;
    }
    this.#emit();
  }

  async setAutoStart(id: string, value: boolean): Promise<void> {
    const rt = this.#rts.get(id);
    if (!rt || !this.#config) return;
    rt.autoStart = value;
    this.#config = upsertInstance(this.#config, {
      id: rt.id,
      dir: rt.dir,
      autoStart: value,
    });
    await saveConfig(this.#config);
    this.#emitSoon();
  }

  async register(req: RegisterRequest): Promise<void> {
    if (this.#task.kind === "register" && this.#task.status === "running") return;
    this.#task = { kind: "register", status: "running", message: null };
    this.#emit();
    const existing = this.#rts.get(instanceIdOf(req.dir));
    const result = await registerRunner(req, this.#config?.searchDirs ?? [], (line) => {
      this.#task = { kind: "register", status: "running", message: line };
      if (existing) this.#pushLog(existing, line);
      this.#emitSoon();
    });
    if (result.ok) {
      const id = instanceIdOf(result.runnerDir);
      const rt = this.#ensureRt(result.runnerDir, true);
      rt.meta = await readRunnerMeta(result.runnerDir);
      if (this.#config) {
        this.#config = upsertInstance(this.#config, {
          id,
          dir: result.runnerDir,
          autoStart: false,
        });
        await saveConfig(this.#config);
      }
      this.#task = { kind: "register", status: "ok", message: `${rt.meta.agentName ?? id} 注册成功` };
      await this.start(id);
    } else {
      this.#task = { kind: "register", status: "error", message: result.error };
    }
    this.#emit();
  }

  async destroy(): Promise<void> {
    if (this.#tickTimer) clearInterval(this.#tickTimer);
    this.#tickTimer = null;
    for (const rt of this.#rts.values()) rt.tail?.stop();
    // 受管 runner 以 detached 拉起：工具退出后继续存活（与"终端里跑"等价），下次启动自动重连。
  }

  // ---------- 内部 ----------

  #ensureRt(dir: string, create: boolean): Rt {
    const id = instanceIdOf(dir);
    let rt = this.#rts.get(id);
    if (!rt && create) {
      rt = {
        id,
        dir,
        meta: null,
        processState: "stopped",
        external: false,
        autoStart: false,
        pid: null,
        child: null,
        currentJob: null,
        lastResult: null,
        lastError: null,
        log: [],
        logTotal: 0,
        seen: new Set(),
        tail: null,
        stoppingUntilMs: 0,
      };
      this.#rts.set(id, rt);
    }
    return rt!;
  }

  async #syncInstances(): Promise<void> {
    const config = this.#config;
    if (!config) return;
    const discovered = await discoverRunnerDirs(config.searchDirs);
    const dirs = new Set<string>([...discovered, ...config.instances.map((i) => i.dir)]);
    let changed = false;
    for (const dir of dirs) {
      try {
        const rt = this.#ensureRt(dir, true);
        rt.meta = await readRunnerMeta(dir);
        const cfgAuto = config.instances.find((i) => i.dir === dir || i.id === rt.id);
        rt.autoStart = cfgAuto?.autoStart ?? false;
        if (!cfgAuto && this.#persist) {
          config.instances = upsertInstance(config, { id: rt.id, dir, autoStart: false }).instances;
          changed = true;
        }
        if (!rt.tail) {
          rt.tail = new DirTail(join(dir, "_diag"), "Runner_");
          rt.tail.start((lines) => this.#onDiagLines(rt, lines));
        }
      } catch {
        /* 单个坏目录跳过，不拖垮整体同步 */
      }
    }
    if (changed && this.#persist) await saveConfig(config);
  }

  #onDiagLines(rt: Rt, lines: string[]): void {
    for (const line of lines) {
      const event = parseConsoleLine(line);
      if (event) this.#applyJobEvent(rt, event);
      // 归一化后再入环：diag 形态与 stdout 形态的同一事件归并为一行，去重才能命中。
      this.#pushLog(rt, normalizeLine(line) ?? stripDiagPrefix(line));
    }
    this.#emitSoon();
  }

  #onManagedLine(rt: Rt, stream: "stdout" | "stderr", line: string): void {
    // 受管实例：stdout 即时回显；作业状态仍以 diag 为权威（归一化后去重避免双计）。
    const event = parseConsoleLine(line);
    if (!event) {
      this.#pushLog(rt, (stream === "stderr" ? "[stderr] " : "") + line);
      this.#emitSoon();
    }
    if (rt.processState === "starting") {
      rt.processState = "running";
      this.#emitSoon();
    }
  }

  #applyJobEvent(
    rt: Rt,
    event: ReturnType<typeof parseConsoleLine>,
  ): void {
    if (!event) return;
    if (event.kind === "job-start") {
      rt.currentJob = { job: event.job!, startedAt: event.at };
    } else if (event.kind === "job-end") {
      const startedAtMs = rt.currentJob ? Date.parse(rt.currentJob.startedAt) : NaN;
      rt.lastResult = {
        job: event.job!,
        outcome: event.outcome!,
        at: event.at,
        durationMs:
          Number.isFinite(startedAtMs) ? Math.max(0, Date.parse(event.at) - startedAtMs) : 0,
      };
      rt.currentJob = null;
    } else {
      rt.currentJob = null;
    }
  }

  #pushLog(rt: Rt, line: string): void {
    // 整行做 key（config.sh 长输出常同前缀不同尾，截断 key 会误判重复丢行）。
    if (rt.seen.has(line)) return;
    rt.seen.add(line);
    if (rt.seen.size > DEDUP_MAX) {
      // 重新收缩：保留最近的（Set 迭代序=插入序）。
      rt.seen = new Set([...rt.seen].slice(-DEDUP_MAX / 2));
    }
    rt.log.push(line);
    rt.logTotal += 1;
    if (rt.log.length > LOG_RING_MAX) rt.log.splice(0, rt.log.length - LOG_RING_MAX);
  }

  async #tick(): Promise<void> {
    try {
      await this.#syncInstances();
      await this.#reconcileExternal();
      await this.#refreshPackages();
    } catch {
      /* 轮询容错 */
    }
  }

  async #reconcileExternal(): Promise<void> {
    const listeners = await findListenerProcesses();
    const cwdByPid = listeners;
    // win32 身份（ExecutablePath 推导）与实例目录的大小写/分隔符可能不一致，归一后对账。
    const norm = (p: string): string =>
      PLATFORM === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p;
    const dirsRunning = new Set([...cwdByPid.values()].map(norm));
    for (const rt of this.#rts.values()) {
      if (rt.stoppingUntilMs > Date.now()) continue;
      if (rt.child) continue; // 受管：child 事件负责
      // 双侧 realpath 归一（/var ↔ /private/var 等 symlink 差异）。
      const rtDir = norm(await realpath(rt.dir).catch(() => rt.dir));
      const externalPid =
        [...cwdByPid.entries()].find(([, cwd]) => norm(cwd) === rtDir)?.[0] ?? null;
      if (externalPid !== null) {
        if (rt.processState !== "running" || rt.external !== true) {
          rt.processState = "running";
          rt.external = true;
          rt.pid = externalPid;
          rt.lastError = null;
          this.#emitSoon();
        }
      } else if (rt.external && rt.processState === "running" && !dirsRunning.has(rtDir)) {
        rt.processState = "stopped";
        rt.external = false;
        rt.pid = null;
        rt.currentJob = null;
        this.#emitSoon();
      }
    }
  }

  #view(rt: Rt): InstanceView {
    return {
      id: rt.id,
      dir: rt.dir,
      name: rt.meta?.agentName ?? rt.id,
      agentId: rt.meta?.agentId ?? null,
      orgUrl: rt.meta?.gitHubUrl ?? null,
      workFolder: rt.meta?.workFolder ?? null,
      configured: rt.meta?.configured ?? false,
      processState: rt.processState,
      external: rt.external,
      autoStart: rt.autoStart,
      pid: rt.pid,
      currentJob: rt.currentJob,
      lastResult: rt.lastResult,
      lastError: rt.lastError,
      log: rt.log,
      logTotal: rt.logTotal,
    };
  }

  #emit(): void {
    const snap = this.snapshot();
    for (const listener of this.#listeners) listener(snap);
  }

  #emitSoon(): void {
    this.#dirty = true;
    if (this.#debounceTimer) return;
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      if (!this.#dirty) return;
      this.#dirty = false;
      this.#emit();
    }, DEBOUNCE_MS);
    this.#debounceTimer.unref?.();
  }
}
