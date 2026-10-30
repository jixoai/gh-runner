/*
 * 原始需求（2026-10-24）：界面要实时地响应和显示——宿主把 Fleet 快照推给 appMode 窗口，
 * 页面命令经 IPC 回流；断线（页面重载）通过 hello/ack 协议自动重新对齐。
 *
 * 正交意图：
 * 1. appMode 主窗口的创建与恢复式显隐（createWebviewWindow 一次性声明，show()/focus() 复用）。
 * 2. 推送协议：summary（实例状态，剔除日志）与 log 增量分通道 evaluate 注入 window.__rfSink；
 *    单次 evaluate 体积控制在 KB 级（实测 ~100KB 全量快照在 WKWebView 路径静默失败）。
 *    【激活事故 2026-10-27 实证】对隐藏窗口 evaluate 会把它重新显示并抢焦点——这是
 *    "一有动静窗口就闪出来"的唯一根因（drainIpcMessages/setTooltip/setMenu/setIcon 均
 *    已 bisect 证实无辜）。Windows 上 X 关闭可能不发 visibleChange，所以可见性以原生
 *    isVisible() 实证为准（fail-closed），事件只作快路径提示；隐藏期间推送/命令轮询全静默。
 * 3. 命令路由：page→host 经 navigator.opentray.ipc + drainIpcMessages 轮询（150ms）；
 *    hello 触发全量重推（offset 清零），ack 单调记录供 smoke/自愈判定。
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TransportTimeoutError, type CreateTrayHandle } from "opentray";
import { WebviewExt, type WebviewWindowHandle, type WebviewWindowOptions } from "@opentray/ext-webview";
import type { Fleet } from "./fleet.ts";
import type { InstanceView, Snapshot, UiCommand, UiPush } from "./types.ts";
import { APP_VERSION } from "./version.ts";

const DRAIN_INTERVAL_MS = 150;
const PUSH_DEBOUNCE_MS = 120;
const WINDOW_BOOTSTRAP_DEADLINE_MS = 30_000;

const resilientWebviewExt: typeof WebviewExt = {
  ...WebviewExt,
  extend(tray, context, options) {
    return WebviewExt.extend(tray, {
      ...context,
      request(data, callOptions) {
        const deadlineMs = callOptions?.deadlineMs;
        const isBootstrapShow = typeof data === "object" && data !== null &&
          "type" in data && data.type === "show" && deadlineMs !== undefined;
        return context.request(data, isBootstrapShow
          ? { ...callOptions, deadlineMs: Math.max(deadlineMs, WINDOW_BOOTSTRAP_DEADLINE_MS) }
          : callOptions);
      },
    }, options);
  },
};

/** U+2028/2029 会切断 JS 对象字面量，序列化后必须转义（不可见字符法则）。 */
function jsLiteral(value: string): string {
  return value.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export class UiHost {
  #window: WebviewWindowHandle | null = null;
  #opening: Promise<void> | null = null;
  #lastSnapshot: Snapshot | null = null;
  #ackedSeq = 0;
  #drainTimer: NodeJS.Timeout | null = null;
  #pushTimer: NodeJS.Timeout | null = null;
  /** 每实例已推送的日志绝对计数（logTotal），0=从头全量。 */
  #logOffsets = new Map<string, number>();
  #seq = 0;
  /** 单飞守卫：hello 全量重推与去抖推送并发交错会让同一批日志行重复送达页面。 */
  #pushInFlight = false;
  #pushPending = false;
  #visible = true;
  /** 隐藏期间 isVisible 慢轮询的分频计数（150ms 滴答 ×7 ≈ 1s）。 */
  #tick = 0;

  constructor(
    private readonly fleet: Fleet,
    private readonly webviewTray: WebviewTray,
    private readonly onOpenDiag: (id: string) => void,
    /** 系统文件选择器（ext-dialog pickFile）；取消/不可用返回 null。 */
    private readonly pickPackageFile: () => Promise<string | null>,
    /** 系统目录选择器（ext-dialog pickDirectory）；取消返回 null。 */
    private readonly pickRunnerDir: () => Promise<string | null>,
    /** 默认浏览器打开外部链接（ext-opener open）。 */
    private readonly openExternal: (url: string) => Promise<void>,
  ) {}

  open(): Promise<void> {
    if (this.#opening) return this.#opening;
    this.#opening = this.#open().finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }

  async #open(): Promise<void> {
    if (this.#window) {
      try {
        await this.#window.show();
        await this.#window.focus();
      } catch (error) {
        if (error instanceof TransportTimeoutError) throw error;
        // Windows 上 X 关闭可能销毁而非隐藏窗口——句柄已死则走重建路径。
        this.#window = null;
      }
    }
    if (this.#window) {
      this.#visible = true;
      this.#logOffsets.clear();
      void this.#doPush();
      return;
    }
    const htmlPath = join(dirname(fileURLToPath(import.meta.url)), "ui", "index.html");
    const html = await readFile(htmlPath, "utf8");
    const win = this.webviewTray.createWebviewWindow({
      html,
      width: 1020,
      height: 700,
      title: `GH Runner v${APP_VERSION}`,
      nativeWindowApi: true,
      devtools: true,
      style: {
        appMode: true,
        autoHide: false,
        frameless: false,
        // 原生材质：macOS vibrancy / Windows acrylic——CSS 玻璃在其上才有可折射的背景
        background: { kind: "semantic", token: "blur", state: "active" },
      },
    });
    await win.show();
    await win.setMinimumSize(720, 520);
    this.#window = win;
    // 可见性门控（fail-closed）：对隐藏窗口的 evaluate 会把它重新激活并抢焦点
    //（2026-10-27 bisect 实证，evaluate 是唯一有此副作用的宿主原语）。Windows 上
    // X 关闭可能不发 visibleChange，所以事件只作快路径提示；推送前另有 isVisible 实证。
    win.listen("visibleChange", (event) => {
      const visible = (event.payload as { visible?: boolean }).visible;
      this.#visible = typeof visible === "boolean" ? visible : true;
      if (visible) {
        this.#logOffsets.clear();
        void this.#doPush();
      }
    });
    win.listen("closed", () => {
      this.#visible = false;
    });
    if (!this.#drainTimer) {
      this.#drainTimer = setInterval(() => void this.#drain(), DRAIN_INTERVAL_MS);
      this.#drainTimer.unref?.();
    }
    this.#flush();
  }

  push(snapshot: Snapshot): void {
    this.#lastSnapshot = snapshot;
    this.#flush();
  }

  /** --smoke 自走查用：页面最近一次 ack 的消息 seq（>0 即真实链路 host→page→host 闭环）。 */
  get ackedSeq(): number {
    return this.#ackedSeq;
  }

  /** --smoke 自走查用：最近一次收到的快照。 */
  get lastSnapshot(): Snapshot | null {
    return this.#lastSnapshot;
  }

  /** --smoke 对照实验：绕过快照管道，直接 evaluate 一个最小 summary。 */
  async debugPushMinimal(): Promise<void> {
    const win = this.#window;
    if (!win) return;
    try {
      await win.evaluate(
        `window.__rfSink({kind:"summary",seq:99999,now:new Date().toISOString(),task:{kind:"none",status:"ok",message:null},instances:[]})`,
      );
    } catch (err) {
      if (process.env.RF_DEBUG) console.error("[ui] minimal evaluate 失败:", err);
    }
  }

  async destroy(): Promise<void> {
    if (this.#drainTimer) clearInterval(this.#drainTimer);
    if (this.#pushTimer) clearTimeout(this.#pushTimer);
    this.#drainTimer = null;
    this.#pushTimer = null;
  }

  #flush(): void {
    if (this.#pushTimer || !this.#window) return;
    this.#pushTimer = setTimeout(() => {
      this.#pushTimer = null;
      void this.#doPush();
    }, PUSH_DEBOUNCE_MS);
    this.#pushTimer.unref?.();
  }

  async #doPush(): Promise<void> {
    const win = this.#window;
    const snap = this.#lastSnapshot;
    if (!win || !snap || win.connectionDead) return;
    // 事实核验：事件可能缺位（Windows X 关闭不发 visibleChange），以原生 isVisible 为准。
    // 已判定隐藏则不再发起任何查询——隐藏期唯一/native 流量是 #drain 的 1s 慢轮询。
    if (this.#visible) {
      try {
        this.#visible = await win.isVisible();
      } catch {
        this.#visible = false;
      }
    }
    if (!this.#visible) return;
    if (this.#pushInFlight) {
      this.#pushPending = true;
      return;
    }
    this.#pushInFlight = true;
    try {
      const summary: UiPush = {
        kind: "summary",
        seq: ++this.#seq,
        now: snap.now,
        platform: snap.platform,
        arch: snap.arch,
        task: snap.task,
        instances: snap.instances.map((inst) => {
          const { log: _log, ...rest } = inst;
          return rest satisfies Omit<InstanceView, "log">;
        }),
        packages: snap.packages,
        download: snap.download,
        authorization: snap.authorization,
        registrationDefaults: snap.registrationDefaults,
        registrationBatch: snap.registrationBatch,
      };
      await this.#evaluate(JSON.stringify(summary));
      for (const inst of snap.instances) {
        // 推送风暴中途窗口被关闭：立即中止余量 evaluate（每一次都可能把窗口拽回前台）。
        if (!this.#visible) return;
        await this.#pushLogDelta(win, inst.id);
      }
    } finally {
      this.#pushInFlight = false;
      if (this.#pushPending && this.#window) {
        this.#pushPending = false;
        this.#flush();
      }
    }
  }

  async #pushLogDelta(win: WebviewWindowHandle, id: string): Promise<void> {
    const view = this.fleet.view(id);
    if (!view) return;
    const pushed = this.#logOffsets.get(id) ?? 0;
    const total = view.logTotal;
    if (total === pushed) return;
    // 拉取自 pushed 之后的行；环绕挤出（可用行 < 期望行）时标记 truncated 让页面全量重建。
    const wanted = total - pushed;
    const available = Math.min(wanted, view.log.length);
    const allLines = view.log.slice(view.log.length - available);
    const truncated = available < wanted;
    // 按字节分包（长堆栈行可达数 KB，按行数分包可能越过 evaluate 体积上限）。
    const chunks: string[][] = [];
    let cur: string[] = [];
    let bytes = 0;
    for (const line of allLines) {
      const b = Buffer.byteLength(line, "utf8") + 1;
      if (bytes + b > 24_000 && cur.length > 0) {
        chunks.push(cur);
        cur = [];
        bytes = 0;
      }
      cur.push(line);
      bytes += b;
    }
    if (cur.length > 0) chunks.push(cur);

    let offset = total - allLines.length;
    for (const lines of chunks) {
      if (!this.#visible) return; // 风暴中途关窗：余包静默（offset 不前移，复显后全量重推）
      const msg: UiPush = {
        kind: "log",
        seq: ++this.#seq,
        id,
        from: truncated && offset === total - allLines.length ? 0 : offset,
        truncated: truncated && offset === total - allLines.length,
        lines,
      };
      const ok = await this.#evaluate(JSON.stringify(msg));
      if (!ok) return; // offset 不前移，下轮重试
      offset += lines.length;
      this.#logOffsets.set(id, offset);
    }
  }

  async #evaluate(json: string): Promise<boolean> {
    const win = this.#window;
    if (!win || win.connectionDead) return false;
    try {
      const js = `window.__rfSink(${jsLiteral(json)})`;
      if (process.env.RF_DEBUG) console.error(`[ui] evaluate ${js.length} bytes: ${json.slice(0, 60)}`);
      await win.evaluate(js);
      return true;
    } catch (err) {
      if (process.env.RF_DEBUG) console.error("[ui] evaluate 失败:", err);
      return false;
    }
  }

  async #drain(): Promise<void> {
    const win = this.#window;
    if (!win || win.connectionDead) return;
    // 隐藏期全静默（drain 本身无辜，但页面不可见时不可能有命令）；仅 1s 一次实证
    // isVisible——覆盖"Windows 关窗不发事件"与"用户从任务栏自行复显"两条复显路径。
    if (!this.#visible) {
      if (++this.#tick % 7 !== 0) return;
      try {
        if (!(await win.isVisible())) return;
      } catch {
        return; // 查询失败按隐藏处理：绝不以猜测换取激活风险
      }
      this.#visible = true;
      this.#logOffsets.clear();
      void this.#doPush();
      return;
    }
    let messages;
    try {
      messages = await win.drainIpcMessages();
    } catch (err) {
      if (process.env.RF_DEBUG) console.error("[ui] drain 失败:", err);
      return;
    }
    for (const message of messages) {
      if (process.env.RF_DEBUG) {
        console.error("[ui] ipc <-", (message.payload as { type?: string } | null)?.type);
      }
      const cmd = message.payload as UiCommand | null;
      if (!cmd || typeof cmd !== "object") continue;
      await this.#handle(cmd);
    }
  }

  async #handle(cmd: UiCommand): Promise<void> {
    switch (cmd.type) {
      case "hello": {
        // 全量重推：offset 清零后走统一 flush 路径（与在途推送单飞串行，杜绝交错重复）。
        this.#logOffsets.clear();
        this.#flush();
        break;
      }
      case "ack": {
        if (cmd.seq > this.#ackedSeq) this.#ackedSeq = cmd.seq;
        break;
      }
      case "start": {
        await this.fleet.start(cmd.id);
        break;
      }
      case "stop": {
        await this.fleet.stop(cmd.id);
        break;
      }
      case "set-auto-start": {
        await this.fleet.setAutoStart(cmd.id, cmd.value);
        break;
      }
      case "open-diag": {
        this.onOpenDiag(cmd.id);
        break;
      }
      case "open-url": {
        // ext-opener 内建 scheme 白名单（http/https/file/mailto），越界会抛 typed 错误。
        try {
          await this.openExternal(cmd.url);
        } catch (err) {
          console.error("[gh-runner] 打开链接失败:", err);
        }
        break;
      }
      case "register": {
        const request = {
          dir: cmd.dir,
          name: cmd.name,
          token: cmd.token,
          labels: cmd.labels,
          orgUrl: cmd.orgUrl,
          workFolder: cmd.workFolder,
          packagePath: cmd.packagePath,
        };
        cmd.token = "";
        void this.fleet.register(request).catch((error) => this.fleet.reportPickerFailure("注册", error)).finally(() => { request.token = ""; });
        break;
      }
      case "register-batch": {
        const request = { ...cmd };
        cmd.token = "";
        void this.fleet.registerBatch(request);
        break;
      }
      case "cancel-authorization": {
        this.fleet.cancelAuthorization();
        break;
      }
      case "download-latest": {
        void this.fleet.downloadLatest();
        break;
      }
      case "import-package": {
        // 系统文件选择对话框（ext-dialog）；取消返回 null。
        const picked = await this.pickPackageFile();
        if (picked) await this.fleet.importPackage(picked);
        break;
      }
      case "import-runner-dir": {
        // 导入已有 runner：系统目录选择框 → attach 路径（读 .runner，work 目录随之恢复，免 Token）。
        const dir = await this.pickRunnerDir();
        if (dir) {
          await this.fleet.register({
            dir,
            name: "",
            token: "",
            labels: "",
            orgUrl: "",
            workFolder: "",
            packagePath: null,
          });
        }
        break;
      }
    }
  }
}

/** 从托盘句柄构造 Webview 能力的便利封装（保持 main.ts 干净）。 */
export function extendWebview(tray: CreateTrayHandle): WebviewTray {
  return tray.extend(resilientWebviewExt) as WebviewTray;
}

/** extend(WebviewExt) 后可用的窗口能力面（本应用只用 createWebviewWindow）。 */
export type WebviewTray = {
  createWebviewWindow: (options: WebviewWindowOptions) => WebviewWindowHandle;
};
