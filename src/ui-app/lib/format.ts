import type { InstanceView } from "./host";

/** 作业已运行/距今时长：<5s 显示"刚刚"，秒/分/小时自适应，无补零。 */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "刚刚";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function fmtAgo(iso: string): string {
  return fmtDuration(Math.max(0, Date.now() - Date.parse(iso)));
}

export function fmtSize(bytes: number): string {
  if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(1) + " GB";
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(0) + " MB";
  return Math.max(1, Math.round(bytes / (1 << 10))) + " KB";
}

/** 日志行语义分类（结果=绿/红/琥珀，开始=蓝，杂项=暗）。 */
export function classifyLog(line: string): "ok" | "bad" | "warn" | "run" | "dim" | null {
  if (/completed with result: (Succeeded|SucceededWithIssues|PartiallySucceeded)/.test(line)) return "ok";
  if (/completed with result: (Failed|Canceled)/.test(line)) {
    return /Canceled/.test(line) ? "warn" : "bad";
  }
  if (/Running job:/.test(line)) return "run";
  if (/^\$|✔|✘/.test(line.trim())) return "dim";
  return null;
}

/** 事件行的 "时间戳: 正文" 拆分——时间戳恒为中性灰。 */
const EVENT_LINE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z): (.*)$/;
export function splitEventLine(line: string): { ts: string; body: string } | null {
  const m = EVENT_LINE.exec(line);
  return m ? { ts: m[1]!, body: m[2]! } : null;
}

export function dotClass(inst: InstanceView): "busy" | "running" | "stopped" | "starting" | "stopping" {
  if (inst.currentJob && inst.processState === "running") return "busy";
  return inst.processState;
}

export function stateText(inst: InstanceView): string {
  if (inst.currentJob) return "作业中";
  const map = { running: "空闲", stopped: "已停止", starting: "启动中…", stopping: "停止中…" } as const;
  return map[inst.processState];
}

/** 最近动作的结果语义色：成功=ok，取消/跳过=warn，其余=bad。 */
export function outcomeClass(outcome: string): "ok" | "warn" | "bad" {
  if (outcome === "Succeeded" || outcome === "SucceededWithIssues" || outcome === "PartiallySucceeded") return "ok";
  if (outcome === "Canceled" || outcome === "Skipped") return "warn";
  return "bad";
}
