/*
 * 原始需求（2026-10-24）：界面要实时地响应和显示——宿主把 Fleet 快照推给 appMode 窗口，
 * 页面命令经 IPC 回流；断线（页面重载）通过 hello/ack 协议自动重新对齐。
 *
 * 正交意图：
 * 1. appMode 主窗口的创建与恢复式显隐（createWebviewWindow 一次性声明，show()/focus() 复用）。
 * 2. 推送协议：summary（实例状态，剔除日志）与 log 增量分通道 evaluate 注入 window.__rfSink；
 *    单次 evaluate 体积控制在 KB 级（实测 ~100KB 全量快照在 WKWebView 路径静默失败）。
 * 3. 命令路由：page→host 经 navigator.opentray.ipc + drainIpcMessages 轮询（150ms）；
 *    hello 触发全量重推（offset 清零），ack 单调记录供 smoke/自愈判定。
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CreateTrayHandle } from "opentray";
import { WebviewExt, type WebviewWindowHandle, type WebviewWindowOptions } from "@opentray/ext-webview";
import type { Fleet } from "./fleet.ts";
import type { InstanceView, Snapshot, UiCommand, UiPush } from "./types.ts";

const DRAIN_INTERVAL_MS = 150;
const PUSH_DEBOUNCE_MS = 120;

/** U+2028/2029 会切断 JS 对象字面量，序列化后必须转义（不可见字符法则）。 */
function jsLiteral(value: string): string {
  return value.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export class UiHost {
  #window: WebviewWindowHandle | null = null;
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

  constructor(
    private readonly fleet: Fleet,
    private readonly webviewTray: WebviewTray,
    private readonly onOpenDiag: (id: string) => void,
    /** 系统文件选择器（ext-dialog pickFile）；取消/不可用返回 null。 */
    private readonly pickPackageFile: () => Promise<string | null>,
    /** 默认浏览器打开外部链接（ext-opener open）。 */
    private readonly openExternal: (url: string) => Promise<void>,
  ) {}

  async open(): Promise<void> {
    if (this.#window) {
      await this.#window.show();
      await this.#window.focus();
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
      title: "GH Runner",
      nativeWindowApi: true,
      devtools: true,
      style: {
        appMode: true,
        autoHide: false,
        frameless: false,
      },
    });
    this.#window = win;
    await win.show();
    await win.setMinimumSize(720, 520);
    // 可见性门控：窗口隐藏时完全静默推送——对隐藏窗口的反复原生调用是"一有动静
    // 窗口就闪出来"的一半帮凶（另一半：托盘投影去重，见 tray.ts）。重新可见即全量重推。
    win.listen("visibleChange", (event) => {
      const visible = (event.payload as { visible?: boolean }).visible ?? true;
      this.#visible = visible;
      if (visible) {
        this.#logOffsets.clear();
        void this.#doPush();
      }
    });
    this.#drainTimer = setInterval(() => void this.#drain(), DRAIN_INTERVAL_MS);
    this.#drainTimer.unref?.();
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
    if (!win || !snap || win.connectionDead || !this.#visible) return;
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
      };
      await this.#evaluate(JSON.stringify(summary));
      for (const inst of snap.instances) {
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
    let messages;
    try {
      messages = await win.drainIpcMessages();
    } catch (err) {
      if (process.env.RF_DEBUG) console.error("[ui] drain 失败:", err);
      return;
    }
    for (const message of messages) {
      if (process.env.RF_DEBUG) {
        console.error("[ui] ipc <-", JSON.stringify(message.payload).slice(0, 120));
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
        await this.fleet.register({
          dir: cmd.dir,
          name: cmd.name,
          token: cmd.token,
          labels: cmd.labels,
          orgUrl: cmd.orgUrl,
          workFolder: cmd.workFolder,
          packagePath: cmd.packagePath,
        });
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
    }
  }
}

/** 从托盘句柄构造 Webview 能力的便利封装（保持 main.ts 干净）。 */
export function extendWebview(tray: CreateTrayHandle): WebviewTray {
  return tray.extend(WebviewExt) as WebviewTray;
}

/** extend(WebviewExt) 后可用的窗口能力面（本应用只用 createWebviewWindow）。 */
export type WebviewTray = {
  createWebviewWindow: (options: WebviewWindowOptions) => WebviewWindowHandle;
};
