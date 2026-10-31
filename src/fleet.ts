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

import { basename, dirname, join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
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
import { registerRunner, unregisterRunner, validateNewRunner, type RegisterRequest } from "./register.ts";
import { authorizeRunners, githubClientId } from "./github-auth.ts";
import { parseRunnerTarget } from "./github-target.ts";
import {
  listPackages,
  PackageDownload,
  type DownloadState,
} from "./packages.ts";
import { ARCH, PLATFORM, isAbsolutePath, registerSpawn } from "./platform.ts";
import type { RunnerPackageSelection } from "./runner-package.ts";
import type {
  CurrentJob,
  FleetTask,
  InstanceView,
  ProcessState,
  Snapshot,
  ToolConfig,
  AuthorizationState,
  BatchRegistrationRequest,
  RegistrationBatchState,
  RunnerOperationRequest,
  RunnerOperationState,
} from "./types.ts";

const LOG_RING_MAX = 400;
const DEDUP_MAX = 2400;
const TICK_MS = 2000;
const DEBOUNCE_MS = 200;

async function canonicalRegistrationPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const existing = await realpath(absolute).catch(() => null);
  if (existing) return existing.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  const parent = dirname(absolute);
  if (parent === absolute) return absolute.toLowerCase();
  return `${await canonicalRegistrationPath(parent)}/${basename(absolute).toLowerCase()}`;
}

function pathsOverlap(first: string, second: string): boolean {
  return first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}

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
  #downloadJob: PackageDownload | null = null;
  #downloadPromise: Promise<void> | null = null;
  #downloadClearTimer: NodeJS.Timeout | null = null;
  #authorization: AuthorizationState | null = null;
  #registrationBatch: RegistrationBatchState | null = null;
  #authController: AbortController | null = null;
  #runnerOperation: RunnerOperationState | null = null;
  #operationId: string | null = null;

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

  /** 宿主侧选择器（ext-dialog）失败的可见反馈：写进 task 通道，UI 以 toast 呈现。
   *  此前只 console.error——受限环境（无 GUI 会话/osascript 被禁）下用户点按钮毫无响应。 */
  reportPickerFailure(what: string, err: unknown, hint?: string): void {
    const detail = err instanceof Error ? err.message : String(err);
    this.#task = {
      kind: "register",
      status: "error",
      message: hint ? `${what}失败：${detail}。${hint}` : `${what}失败：${detail}`,
    };
    this.#emit();
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
      authorization: this.#authorization ? { ...this.#authorization } : null,
      registrationBatch: this.#registrationBatch ? structuredClone(this.#registrationBatch) : null,
      runnerOperation: this.#runnerOperation ? { ...this.#runnerOperation } : null,
      registrationDefaults: {
        parentDir: join(homedir(), "actions-runners"),
        name: hostname().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "runner",
        clientId: githubClientId(),
      },
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
  downloadLatest(sourceTemplate = "", selection?: RunnerPackageSelection): Promise<void> {
    if (this.#downloadPromise) return this.#downloadPromise;
    if (this.#downloadClearTimer) clearTimeout(this.#downloadClearTimer);
    const job = new PackageDownload((state) => {
      this.#download = state;
      this.#emitSoon();
    }, sourceTemplate, selection);
    this.#downloadJob = job;
    this.#downloadPromise = (async () => {
      try {
        if (await job.run()) await this.#refreshPackages();
      } finally {
        this.#downloadJob = null;
        this.#downloadPromise = null;
        this.#emitSoon();
        if (this.#download?.status === "ok") {
          this.#downloadClearTimer = setTimeout(() => {
            this.#downloadClearTimer = null;
            this.#download = null;
            this.#emitSoon();
          }, 8000);
          this.#downloadClearTimer.unref?.();
        }
      }
    })();
    return this.#downloadPromise;
  }

  pauseDownload(): void { this.#downloadJob?.pause(); }
  resumeDownload(): void { this.#downloadJob?.resume(); }
  cancelDownload(): void { this.#downloadJob?.cancel(); }

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
    if (this.#operationId === id) return;
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
      const graceful = rt.processState === "stopping" || signal === "SIGTERM" || code === 0;
      rt.child = null;
      rt.pid = null;
      rt.processState = "stopped";
      rt.currentJob = null;
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
    } else if (!ok && rt.child?.pid === pid && rt.processState === "stopping") {
      rt.processState = "running";
      rt.stoppingUntilMs = 0;
      rt.lastError = "停止失败：进程无响应或无权限（可能由 sudo 启动）";
    }
    this.#emit();
  }

  async setAutoStart(id: string, value: boolean): Promise<void> {
    if (this.#operationId === id) return;
    const rt = this.#rts.get(id);
    if (!rt || !this.#config) return;
    rt.autoStart = value;
    this.#config = upsertInstance(this.#config, {
      ...this.#config.instances.find((item) => item.id === id),
      id: rt.id,
      dir: rt.dir,
      autoStart: value,
    });
    await saveConfig(this.#config);
    this.#emitSoon();
  }

  async register(req: RegisterRequest): Promise<void> {
    if (this.#task.status === "running" || this.#operationId !== null) { req.token = ""; return; }
    this.#registrationBatch = null;
    this.#authorization = null;
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

  cancelAuthorization(): void {
    if (this.#authorization?.status === "registering") return;
    this.#authController?.abort();
  }

  async registerBatch(input: BatchRegistrationRequest): Promise<void> {
    if (this.#task.status === "running" || this.#operationId !== null) {
      input.token = "";
      return;
    }
    this.#task = { kind: "register", status: "running", message: "检查配置与目录…" };
    this.#authorization = null;
    this.#registrationBatch = { requestId: input.requestId, credentialsCleared: false, items: [] };
    const controller = new AbortController();
    this.#authController = controller;
    let tokens: string[] = [];
    this.#emit();
    try {
      if (!Array.isArray(input.runners) || input.runners.length < 1 || input.runners.length > 10) {
        throw new Error("每批可创建 1–10 个 runner");
      }
      if (input.method !== "github" && input.method !== "token") throw new Error("请选择授权方式");
      const target = parseRunnerTarget(input.targetUrl);
      const requests = input.runners.map((runner) => ({
        ...runner,
        dir: runner.dir.trim(),
        name: runner.name.trim(),
        workFolder: runner.workFolder.trim(),
        token: "",
        orgUrl: target.url,
        packagePath: input.packagePath,
      }));
      const names = new Set<string>();
      const paths: { path: string; owner: string }[] = [];
      for (const req of requests) {
        if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(req.name)) throw new Error("实例名称仅支持字母、数字、短横线、下划线和点，且不能以点开头");
        if (names.has(req.name.toLowerCase())) throw new Error(`实例名称重复：${req.name}`);
        names.add(req.name.toLowerCase());
        for (const path of [req.dir, req.workFolder]) {
          const canonical = await canonicalRegistrationPath(path);
          if (paths.some((used) => used.path === canonical || (used.owner !== req.name && pathsOverlap(used.path, canonical)))) {
            throw new Error("每个 runner 必须使用独立且不与其他实例嵌套的实例目录和 Work 目录");
          }
          paths.push({ path: canonical, owner: req.name });
        }
        for (const rt of this.#rts.values()) {
          if (rt.meta?.gitHubUrl?.replace(/\/$/, "").toLowerCase() === target.url.toLowerCase() && rt.meta.agentName?.toLowerCase() === req.name.toLowerCase()) {
            throw new Error(`已有同名 runner：${req.name}，请更换名称`);
          }
          const work = rt.meta?.workFolder;
          for (const existing of [rt.dir, ...(work ? [isAbsolutePath(work) ? work : join(rt.dir, work)] : [])]) {
            const canonical = await canonicalRegistrationPath(existing);
            if (paths.filter((path) => path.owner === req.name).some((path) => pathsOverlap(path.path, canonical))) {
              throw new Error(`目录与 ${rt.meta?.agentName ?? rt.id} 使用的目录重叠，请选择独立目录`);
            }
          }
        }
        await validateNewRunner(req, this.#config?.searchDirs ?? []);
      }
      this.#registrationBatch.items = requests.map((req) => ({ name: req.name, dir: req.dir, status: "pending", message: "等待注册" }));
      if (input.method === "github") {
        this.#authorization = { status: "requesting", message: "正在申请设备验证码…" };
        this.#emit();
        tokens = await authorizeRunners({
          clientId: input.clientId.trim() || githubClientId(),
          targetUrl: target.url,
          count: requests.length,
          signal: controller.signal,
          onCode: (code) => {
            this.#authorization = { status: "waiting", ...code, message: "请在手机或浏览器上确认授权" };
            this.#emit();
          },
          onAuthorized: () => {
            this.#authorization = { status: "exchanging", message: "授权成功，正在申请本批 runner 注册 Token…" };
            this.#emit();
          },
        });
        controller.signal.throwIfAborted();
        this.#authorization = { status: "registering", message: "账号访问凭据已从本次会话释放，正在注册 runner" };
      } else {
        if (!input.token.trim()) throw new Error("请填写 runner 注册 Token，而不是 PAT 或账号访问 Token");
        tokens = requests.map(() => input.token.trim());
      }
      input.token = "";
      this.#emit();
      for (const [index, req] of requests.entries()) {
        const item = this.#registrationBatch.items[index]!;
        item.status = "registering";
        item.message = "解包并配置…";
        req.token = tokens[index]!;
        tokens[index] = "";
        this.#emit();
        try {
          const result = await registerRunner(req, this.#config?.searchDirs ?? [], (message) => {
            item.message = message;
            this.#task.message = `${index + 1}/${requests.length} · ${req.name}：${message}`;
            this.#emitSoon();
          });
          if (!result.ok) throw new Error(result.error ?? "注册失败");
          const rt = this.#ensureRt(result.runnerDir, true);
          rt.meta = await readRunnerMeta(result.runnerDir);
          if (this.#config && this.#persist) {
            this.#config = upsertInstance(this.#config, { id: rt.id, dir: rt.dir, autoStart: false });
            await saveConfig(this.#config);
          }
          await this.start(rt.id);
          item.status = "ok";
          item.message = rt.lastError ? `已注册；启动失败，请从实例卡片重试：${rt.lastError}` : "已注册并启动";
        } catch (error) {
          item.status = "error";
          item.message = error instanceof Error ? error.message : "注册失败，请检查目录和网络后重试";
        } finally {
          req.token = "";
          this.#emit();
        }
      }
      const failed = this.#registrationBatch.items.filter((item) => item.status === "error").length;
      this.#task = { kind: "register", status: failed ? "error" : "ok", message: `${requests.length - failed}/${requests.length} 个 runner 注册成功${failed ? `，${failed} 个失败；成功项不受影响` : ""}` };
      if (this.#authorization) this.#authorization = { status: "cleared", message: "本机临时凭据已清理；GitHub 上的应用授权仍保留" };
    } catch (error) {
      const message = controller.signal.aborted ? "授权已取消，本机临时凭据已清理" : error instanceof Error ? error.message : "注册失败，请稍后重试";
      this.#authorization = { status: controller.signal.aborted ? "cancelled" : "error", message };
      this.#task = { kind: "register", status: "error", message };
      for (const item of this.#registrationBatch.items) {
        if (item.status === "pending") {
          item.status = "error";
          item.message = controller.signal.aborted ? "已取消，未创建" : "未创建，请修正授权或配置后重试";
        }
      }
    } finally {
      input.token = "";
      tokens.fill("");
      this.#registrationBatch.credentialsCleared = true;
      this.#authController = null;
      this.#emit();
    }
  }

  async operateRunner(input: RunnerOperationRequest): Promise<void> {
    if (this.#task.status === "running" || this.#operationId !== null) { input.token = ""; return; }
    const removing = input.action === "unregister";
    const title = removing ? "注销" : "重新注册";
    const controller = new AbortController();
    this.#authController = controller;
    this.#operationId = input.id;
    this.#authorization = null;
    this.#runnerOperation = { requestId: input.requestId, id: input.id, action: input.action, status: "running", message: "检查实例…" };
    this.#task = { kind: input.action, status: "running", message: `正在${title}…` };
    let token = "";
    let registration: RegisterRequest | null = null;
    let removed = false;
    this.#emit();
    const progress = (message: string) => {
      this.#runnerOperation!.message = message;
      this.#task.message = message;
      this.#emitSoon();
    };
    try {
      while (this.#ticking) await delay(25, undefined, { signal: controller.signal });
      if (input.action !== "unregister" && input.action !== "reregister") throw new Error("不支持的 runner 操作");
      if (input.method !== "github" && input.method !== "token") throw new Error("请选择授权方式");
      if (!this.#persist || !this.#config) throw new Error("只读模式不能注销或重新注册");
      const rt = this.#rts.get(input.id);
      if (!rt?.meta) throw new Error("实例不存在，请刷新后重试");
      if (rt.currentJob) throw new Error("实例正在执行作业，请等待完成后再操作");
      if (rt.external) throw new Error("请先停止外部终端或系统服务中的 runner，再操作");
      if (rt.processState === "starting" || rt.processState === "stopping") throw new Error("实例正在切换状态，请稍后重试");
      const saved = this.#config.instances.find((item) => item.id === rt.id)?.unregistered;
      if (removing && !rt.meta.configured) throw new Error("实例未注册，无需注销");
      if (!removing && (rt.meta.configured || !saved)) throw new Error("仅支持重新注册本工具保留的已注销实例");
      const entry = registerSpawn(rt.dir);
      const entryPath = isAbsolutePath(entry.file) ? entry.file : resolve(rt.dir, entry.file);
      if (!existsSync(entryPath)) throw new Error("安装文件已缺失，请重新下载分发包并添加实例；工作文件可继续保留");
      const target = parseRunnerTarget(rt.meta.gitHubUrl ?? "");
      const originalDir = await realpath(rt.dir);
      const originalAgentId = rt.meta.agentId;
      const workFolder = rt.meta.workFolder ? resolve(rt.dir, rt.meta.workFolder) : "";
      if (!workFolder) throw new Error("实例缺少工作目录配置，请先检查 .runner");
      const retained = { name: rt.meta.agentName ?? rt.id, targetUrl: target.url, workFolder };
      if (input.method === "github") {
        this.#authorization = { status: "requesting", message: "正在申请设备验证码…" };
        this.#emit();
        const tokens = await authorizeRunners({
          clientId: githubClientId(), targetUrl: target.url, count: 1,
          purpose: removing ? "remove" : "register", signal: controller.signal,
          onCode: (code) => {
            this.#authorization = { status: "waiting", ...code, message: `请确认${title}授权` };
            this.#emit();
          },
          onAuthorized: () => {
            this.#authorization = { status: "exchanging", message: `正在申请${title} Token…` };
            this.#emit();
          },
        });
        token = tokens[0] ?? "";
        tokens.fill("");
      } else {
        token = input.token.trim();
      }
      input.token = "";
      if (!token) throw new Error(`缺少 runner ${removing ? "注销" : "注册"} Token（不是 PAT）`);
      controller.signal.throwIfAborted();
      if (rt.currentJob) throw new Error("授权期间实例开始执行作业，请等待完成后重试");
      if (rt.external || await realpath(rt.dir) !== originalDir) throw new Error("授权期间实例状态或目录发生变化，请重新检查后重试");
      const currentMeta = await readRunnerMeta(rt.dir);
      if (removing && (!currentMeta.configured || currentMeta.agentId !== originalAgentId || currentMeta.gitHubUrl !== rt.meta.gitHubUrl)) {
        throw new Error("授权期间 runner 注册配置发生变化，请刷新后重试");
      }
      if (!removing && currentMeta.configured) throw new Error("目录已被其他进程注册，请刷新后重试");
      this.#authorization = { status: "registering", message: `临时账号凭据已释放，正在${title}` };
      this.#emit();
      if (removing) {
        progress("正在停止 runner…");
        await this.stop(rt.id);
        const deadline = Date.now() + 12_000;
        while (rt.pid !== null && Date.now() < deadline) await delay(100);
        const processes = await findListenerProcesses();
        const runnerDir = await realpath(rt.dir);
        const normalize = (path: string) => PLATFORM === "win32" ? path.replace(/\\/g, "/").toLowerCase() : path;
        if (rt.pid !== null || [...processes.values()].some((path) => normalize(path) === normalize(runnerDir))) {
          throw new Error("runner 尚未完全停止，请先停止系统服务或外部进程后重试");
        }
        await unregisterRunner(rt.dir, token, progress);
        removed = true;
        rt.meta = { ...rt.meta, configured: false, agentId: null };
        rt.processState = "stopped";
        rt.pid = null;
        rt.child = null;
        rt.autoStart = false;
        rt.lastError = null;
        this.#config = upsertInstance(this.#config, { id: rt.id, dir: rt.dir, autoStart: false, unregistered: retained });
      } else {
        registration = { dir: rt.dir, name: retained.name, orgUrl: target.url, workFolder, token, labels: "", packagePath: null, reusePackage: true };
        const result = await registerRunner(registration, [], progress);
        if (!result.ok) throw new Error(result.error ?? "重新注册失败");
        rt.meta = await readRunnerMeta(rt.dir);
        if (!rt.meta.configured) throw new Error("重新注册后未找到有效配置");
        rt.lastError = null;
        this.#config = upsertInstance(this.#config, { id: rt.id, dir: rt.dir, autoStart: false });
      }
      await saveConfig(this.#config);
      this.#runnerOperation.status = "ok";
      this.#runnerOperation.message = removing ? "已从 GitHub 注销；本地安装包、工作文件和日志已保留" : "已重新注册；工作文件保持不变，可点击启动";
      this.#task = { kind: input.action, status: "ok", message: this.#runnerOperation.message };
      this.#authorization = { status: "cleared", message: "本次临时凭据已清理" };
    } catch (error) {
      const message = controller.signal.aborted ? "授权已取消，未执行注销或重新注册" : error instanceof Error ? error.message : String(error);
      const detail = removed ? `GitHub 已注销，但保存本机记录失败：${message}` : message;
      this.#runnerOperation.status = "error";
      this.#runnerOperation.message = detail;
      this.#task = { kind: input.action, status: "error", message: detail };
      this.#authorization = { status: controller.signal.aborted ? "cancelled" : "error", message: detail };
    } finally {
      token = "";
      input.token = "";
      if (registration) registration.token = "";
      this.#authController = null;
      this.#operationId = null;
      this.#emit();
    }
  }

  async destroy(): Promise<void> {
    this.#authController?.abort();
    this.#downloadJob?.cancel();
    await this.#downloadPromise;
    if (this.#downloadClearTimer) clearTimeout(this.#downloadClearTimer);
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = null;
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
        if (this.#operationId === instanceIdOf(dir)) continue;
        const rt = this.#ensureRt(dir, true);
        const meta = await readRunnerMeta(dir);
        if (this.#operationId === rt.id) continue;
        rt.meta = meta;
        const cfgAuto = config.instances.find((i) => i.dir === dir || i.id === rt.id);
        if (!rt.meta.configured && cfgAuto?.unregistered) {
          rt.meta = { ...rt.meta, agentName: cfgAuto.unregistered.name, gitHubUrl: cfgAuto.unregistered.targetUrl, workFolder: cfgAuto.unregistered.workFolder };
        }
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
    if (this.#ticking || this.#operationId !== null) return;
    this.#ticking = true;
    try {
      await this.#syncInstances();
      await this.#reconcileExternal();
      await this.#refreshPackages();
    } catch {
      /* 轮询容错 */
    } finally {
      this.#ticking = false;
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
      workFolder: rt.meta?.workFolder ? resolve(rt.dir, rt.meta.workFolder) : null,
      configured: rt.meta?.configured ?? false,
      unregistered: !rt.meta?.configured && Boolean(this.#config?.instances.find((item) => item.id === rt.id)?.unregistered),
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
