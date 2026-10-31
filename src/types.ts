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
  unregistered?: boolean;
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
  kind: "register" | "unregister" | "reregister" | "none";
  status: "running" | "ok" | "error";
  message: string | null;
}

export interface PackageInfo {
  path: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
  /** 是否匹配当前平台架构。 */
  compatible: boolean;
}

export interface DownloadState {
  status: "running" | "paused" | "cancelling" | "cancelled" | "ok" | "error";
  /** 0-100。 */
  pct: number;
  message: string;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  assetName: string;
  url: string;
  sizeBytes: number;
}

export interface AuthorizationState {
  status: "requesting" | "waiting" | "exchanging" | "registering" | "cleared" | "error" | "cancelled";
  userCode?: string;
  verificationUri?: string;
  expiresAt?: number;
  message: string;
}

export interface RegistrationDefaults {
  parentDir: string;
  name: string;
  clientId: string;
}

export interface BatchRegistrationRequest {
  requestId?: string;
  method: "github" | "token";
  clientId: string;
  token: string;
  targetUrl: string;
  packagePath: string;
  runners: { dir: string; name: string; labels: string; workFolder: string }[];
}

export interface RunnerOperationRequest {
  requestId: string;
  id: string;
  action: "unregister" | "reregister";
  method: "github" | "token";
  token: string;
}

export interface RunnerOperationState {
  requestId: string;
  id: string;
  action: "unregister" | "reregister";
  status: "running" | "ok" | "error";
  message: string;
}

export interface RegistrationBatchState {
  requestId?: string;
  credentialsCleared: boolean;
  items: {
    name: string;
    dir: string;
    status: "pending" | "registering" | "ok" | "error";
    message: string;
  }[];
}

export interface Snapshot {
  seq: number;
  now: string;
  /** 当前平台/架构（UI 据此设置表单默认值）。 */
  platform: string;
  arch: string;
  instances: InstanceView[];
  task: FleetTask;
  /** 可选分发包清单（下载缓存 ∪ 导入路径，新者在前）。 */
  packages: PackageInfo[];
  /** 进行中/刚完成的最新包下载（null=无）。 */
  download: DownloadState | null;
  authorization?: AuthorizationState | null;
  registrationDefaults?: RegistrationDefaults;
  registrationBatch?: RegistrationBatchState | null;
  runnerOperation?: RunnerOperationState | null;
}

/** 宿主 → 页面 推送（经 evaluate 注入 window.__rfSink）。summary 与 log 增量分通道，
 *  避免单次 evaluate 超限（实测 ~100KB 全量快照在 WKWebView 路径上静默失败）。 */
export type UiPush =
  | {
      kind: "summary";
      seq: number;
      now: string;
      platform: string;
      arch: string;
      task: FleetTask;
      instances: Omit<InstanceView, "log">[];
      packages: PackageInfo[];
      download: DownloadState | null;
      authorization?: AuthorizationState | null;
      registrationDefaults?: RegistrationDefaults;
      registrationBatch?: RegistrationBatchState | null;
      runnerOperation?: RunnerOperationState | null;
    }
  | { kind: "log"; seq: number; id: string; from: number; truncated: boolean; lines: string[] };

/** 页面 → 宿主 命令（经 navigator.opentray.ipc.postMessage）。 */
export type UiCommand =
  | { type: "hello" }
  | { type: "ack"; seq: number }
  | { type: "start"; id: string }
  | { type: "stop"; id: string }
  | { type: "set-auto-start"; id: string; value: boolean }
  | { type: "open-diag"; id: string }
  | { type: "open-work-dir"; id: string }
  | ({ type: "runner-operation" } & RunnerOperationRequest)
  | { type: "open-url"; url: string }
  | { type: "download-latest" }
  | { type: "pause-download" }
  | { type: "resume-download" }
  | { type: "cancel-download" }
  | { type: "import-package" }
  | { type: "import-runner-dir" }
  | { type: "cancel-authorization" }
  | ({ type: "register-batch" } & BatchRegistrationRequest)
  | {
      type: "register";
      dir: string;
      name: string;
      token: string;
      labels: string;
      orgUrl: string;
      workFolder: string;
      /** 选定分发包的绝对路径（下载缓存或导入路径）。 */
      packagePath: string;
    };

/** 工具自身配置（持久化于平台配置目录/gh-runner/config.json）。 */
export interface ToolConfig {
  /** 自动发现 runner 的父目录集合。 */
  searchDirs: string[];
  instances: InstanceConfig[];
  /** 用户导入的分发包绝对路径（不复制，仅登记）。 */
  importedPackages: string[];
}

export interface InstanceConfig {
  id: string;
  dir: string;
  autoStart: boolean;
  unregistered?: { name: string; targetUrl: string; workFolder: string };
}
