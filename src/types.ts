/*
 * 原始需求（2026-10-24）：多开 GitHub self-hosted runner，做一个挂在托盘里的管理工具——
 * 表单配置后可把 runner 当实例启动/关闭，并根据运行日志实时分析最近动作成功/失败。
 *
 * 正交意图：
 * 1. 领域模型：实例、进程状态、作业事件、UI 快照与命令的唯一类型源。
 * 2. 不含任何 IO / 副作用，供前后端（宿主与页面）共同引用。
 */

/** 实例进程生命周期（supervisor 视角）。external 表示进程在跑但不是本工具拉起的。 */
export type ProcessState = "stopped" | "starting" | "running" | "stopping";

/** 一次作业（job）的终态，取自 Runner 日志 `completed with result:` 后的原文。 */
export type JobOutcome =
  | "Succeeded"
  | "Failed"
  | "Canceled"
  | "Skipped"
  | "SucceededWithIssues"
  | "PartiallySucceeded"
  | (string & {});

export interface JobRun {
  job: string;
  outcome: JobOutcome;
  /** ISO 时间（UTC）。 */
  at: string;
  durationMs: number;
}

export interface CurrentJob {
  job: string;
  /** ISO 时间（UTC），来自日志行的时间戳。 */
  startedAt: string;
}

/** 实例在 UI 上的一帧完整视图（全量替换式推送）。 */
export interface InstanceView {
  id: string;
  /** runner 目录（绝对路径），实例身份。 */
  dir: string;
  /** .runner 里的 agentName；未注册时取目录名。 */
  name: string;
  agentId: number | null;
  orgUrl: string | null;
  workFolder: string | null;
  configured: boolean;
  processState: ProcessState;
  external: boolean;
  autoStart: boolean;
  pid: number | null;
  currentJob: CurrentJob | null;
  lastResult: JobRun | null;
  lastError: string | null;
  /** 最近日志（环形缓冲，已归一化为纯文本行）。 */
  log: string[];
  /** 日志绝对追加计数（含已被环绕挤出的行），供增量推送对位。 */
  logTotal: number;
}

export interface FleetTask {
  kind: "register" | "none";
  status: "running" | "ok" | "error";
  message: string | null;
}

export interface Snapshot {
  seq: number;
  now: string;
  instances: InstanceView[];
  task: FleetTask;
}

/** 宿主 → 页面 推送（经 evaluate 注入 window.__rfSink）。summary 与 log 增量分通道，
 *  避免单次 evaluate 超限（实测 ~100KB 全量快照在 WKWebView 路径上静默失败）。 */
export type UiPush =
  | { kind: "summary"; seq: number; now: string; task: FleetTask; instances: Omit<InstanceView, "log">[] }
  | { kind: "log"; seq: number; id: string; from: number; truncated: boolean; lines: string[] };

/** 页面 → 宿主 命令（经 navigator.opentray.ipc.postMessage）。 */
export type UiCommand =
  | { type: "hello" }
  | { type: "ack"; seq: number }
  | { type: "start"; id: string }
  | { type: "stop"; id: string }
  | { type: "set-auto-start"; id: string; value: boolean }
  | { type: "open-diag"; id: string }
  | {
      type: "register";
      dir: string;
      name: string;
      token: string;
      labels: string;
      orgUrl: string;
      workFolder: string;
      tarball: string;
    };

/** 工具自身配置（持久化于 ~/Library/Application Support/runner-fleet/config.json）。 */
export interface ToolConfig {
  /** 自动发现 runner 的父目录集合。 */
  searchDirs: string[];
  instances: InstanceConfig[];
}

export interface InstanceConfig {
  id: string;
  dir: string;
  autoStart: boolean;
}
