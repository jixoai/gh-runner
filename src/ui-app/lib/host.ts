/*
 * 正交意图：宿主协议的唯一前端入口——summary/log 双通道接收（window.__rfSink）+
 * 命令上行（navigator.opentray.ipc / 演示模式降级）。React 经 useSyncExternalStore 订阅。
 */

import type { UiCommand, UiPush } from "../../types.ts";
export type { UiCommand } from "../../types.ts";

export interface InstanceView {
  id: string;
  dir: string;
  name: string;
  agentId: number | null;
  orgUrl: string | null;
  workFolder: string | null;
  configured: boolean;
  processState: "stopped" | "starting" | "running" | "stopping";
  external: boolean;
  autoStart: boolean;
  pid: number | null;
  currentJob: { job: string; startedAt: string } | null;
  lastResult: { job: string; outcome: string; at: string; durationMs: number } | null;
  lastError: string | null;
  logTotal: number;
}

export interface PackageInfo {
  path: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
  compatible: boolean;
}

export type SummaryPush = Extract<UiPush, { kind: "summary" }>;

const EMPTY_LOGS: string[] = [];

class HostStore {
  summary: SummaryPush | null = null;
  logs = new Map<string, string[]>();
  /** useSyncExternalStore 的版本号（引用稳定性由外部以 version 判别）。 */
  version = 0;
  /** 演示模式（无宿主桥）。 */
  demo = false;

  #listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  #emit(): void {
    this.version += 1;
    for (const listener of this.#listeners) listener();
  }

  sink = (msg: { kind: string; seq: number } & Record<string, unknown>): void => {
    if (msg.kind === "summary") {
      this.summary = msg as unknown as SummaryPush;
      const task = this.summary.task;
      if (task.kind === "register") announceTask(task);
    } else if (msg.kind === "log") {
      const { id, lines, truncated } = msg as unknown as {
        id: string;
        lines: string[];
        truncated: boolean;
      };
      let buf = this.logs.get(id);
      if (!buf) {
        buf = [];
        this.logs.set(id, buf);
      }
      if (truncated) buf.length = 0;
      for (const line of lines) buf.push(line);
      if (buf.length > 800) buf.splice(0, buf.length - 600);
    }
    this.#emit();
    this.send({ type: "ack", seq: msg.seq });
  };

  send = (cmd: UiCommand): void => {
    const ipc = (navigator as Navigator & { opentray?: { ipc?: { postMessage: (c: UiCommand) => void } } })
      .opentray?.ipc;
    if (ipc) ipc.postMessage(cmd);
    else void demoCommand(cmd);
  };

  logsOf(id: string | null): string[] {
    if (!id) return EMPTY_LOGS;
    return this.logs.get(id) ?? EMPTY_LOGS;
  }
}

export const store = new HostStore();

async function demoCommand(cmd: UiCommand): Promise<void> {
  if (cmd.type === "open-url") {
    window.open(cmd.url, "_blank");
    return;
  }
  const { demoHost } = await import("../demo");
  demoHost.command(cmd);
}

/* 任务播报（sonner 由 App 层接线） */
type TaskAnnouncer = (message: string, kind: "ok" | "error") => void;
let taskAnnouncer: TaskAnnouncer | null = null;
export function setTaskAnnouncer(fn: TaskAnnouncer): void {
  taskAnnouncer = fn;
}
let lastAnnounced = "";
function announceTask(task: {
  kind: string;
  status: "running" | "ok" | "error";
  message: string | null;
}): void {
  if (task.status === "running") return;
  const key = task.kind + task.status + (task.message ?? "");
  if (key === lastAnnounced) return;
  lastAnnounced = key;
  taskAnnouncer?.(task.message ?? (task.status === "ok" ? "完成" : "失败"), task.status);
}

/* 初始化：桥存在则 hello；否则进演示模式 */
const bridge = (navigator as Navigator & { opentray?: { ipc?: { postMessage: (c: UiCommand) => void } } })
  .opentray?.ipc;
if (bridge) {
  window.__rfSink = store.sink as unknown as (msg: unknown) => void;
  store.send({ type: "hello" });
} else {
  store.demo = true;
  void import("../demo");
}

declare global {
  interface Window {
    __rfSink?: (msg: unknown) => void;
  }
}
