/*
 * 原始需求（2026-10-24）：根据 runner 运行日志，实时分析它最近的一个动作（作业）是成功还是失败。
 *
 * 正交意图：
 * 1. 纯函数解析 Runner.Listener 的控制台行（run.sh stdout 与 _diag/Runner_*.log 两种形态）
 *    → 归一化的作业事件流。
 * 2. 不做 IO、不维护状态；状态机归 fleet。
 *
 * 实测行式（mac-ext-01..04，runner 2.338.1，2026-10-24）：
 *   [2026-10-24 10:16:04Z INFO Terminal] WRITE LINE: 2026-10-24 10:16:04Z: Job build-win completed with result: Succeeded
 *   [2026-10-24 10:16:10Z INFO Terminal] WRITE LINE: 2026-10-24 10:16:10Z: Running job: 核心门禁（cli / contracts / icons / hermes）
 *   2026-10-24 10:16:10Z: Listening for Jobs
 * 注意 job 名可含中文、括号、斜杠、空格——必须按"行尾整体"截取，不能按空格分词。
 */

export interface JobEvent {
  /** ISO UTC。 */
  at: string;
  kind: "job-start" | "job-end" | "idle";
  job?: string;
  outcome?: string;
}

/** 日志行前缀（diag 文件形态）：`[2026-10-24 10:16:04Z INFO Terminal] WRITE LINE: `。 */
const DIAG_PREFIX = "] WRITE LINE: ";

const ANSI = /\x1b\[[0-9;]*m/g;
const TS = "([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2})";
const RE_RUNNING = new RegExp(`^${TS}Z: Running job: (.+)$`);
const RE_COMPLETED = new RegExp(`^${TS}Z: Job (.+) completed with result: (.+)$`);
const RE_LISTENING = new RegExp(`^${TS}Z: Listening for Jobs$`);

/** `2026-10-24 10:16:04` → `2026-10-24T10:16:04Z`（runner 控制台时间戳恒为 UTC）。 */
export function toIsoUtc(raw: string): string {
  return `${raw.replace(" ", "T")}Z`;
}

/** 剥离 diag 包裹前缀（`[..INFO Terminal] WRITE LINE: `），非包裹行原样返回。 */
export function stripDiagPrefix(line: string): string {
  const marker = line.indexOf(DIAG_PREFIX);
  return marker >= 0 ? line.slice(marker + DIAG_PREFIX.length) : line;
}

/** 剥离 diag 包裹与 ANSI 颜色，还原纯控制台行；非控制台行返回 null。 */
export function normalizeLine(line: string): string | null {
  const stripped = stripDiagPrefix(line).replaceAll(ANSI, "").trimEnd();
  return RE_LISTENING.test(stripped) || RE_RUNNING.test(stripped) || RE_COMPLETED.test(stripped)
    ? stripped
    : null;
}

/** 解析一行控制台输出；不是作业事件行时返回 null。 */
export function parseConsoleLine(line: string): JobEvent | null {
  const content = normalizeLine(line);
  if (content === null) return null;

  const completed = RE_COMPLETED.exec(content);
  if (completed) {
    return {
      at: toIsoUtc(completed[1]!),
      kind: "job-end",
      job: completed[2]!,
      outcome: completed[3]!.trim(),
    };
  }
  const running = RE_RUNNING.exec(content);
  if (running) {
    return { at: toIsoUtc(running[1]!), kind: "job-start", job: running[2]!.trim() };
  }
  const listening = RE_LISTENING.exec(content);
  if (listening) return { at: toIsoUtc(listening[1]!), kind: "idle" };
  return null;
}

/**
 * 从一批（按时间正序的）日志行恢复当前作业状态。
 * 返回 currentJob（最后一个未完结的 Running job）与 lastResult（最后一个完成态）。
 */
export function replayJobState(lines: string[]): {
  currentJob: { job: string; startedAt: string } | null;
  lastResult: { job: string; outcome: string; at: string; durationMs: number } | null;
} {
  let currentJob: { job: string; startedAt: string } | null = null;
  let lastResult: {
    job: string;
    outcome: string;
    at: string;
    durationMs: number;
    startedAtMs: number | null;
  } | null = null;

  for (const line of lines) {
    const event = parseConsoleLine(line);
    if (!event) continue;
    if (event.kind === "job-start") {
      currentJob = { job: event.job!, startedAt: event.at };
    } else if (event.kind === "job-end") {
      const startedAtMs = currentJob?.startedAt ? Date.parse(currentJob.startedAt) : null;
      lastResult = {
        job: event.job!,
        outcome: event.outcome!,
        at: event.at,
        durationMs:
          startedAtMs !== null && Number.isFinite(startedAtMs)
            ? Math.max(0, Date.parse(event.at) - startedAtMs)
            : 0,
        startedAtMs,
      };
      currentJob = null;
    } else {
      currentJob = null;
    }
  }
  if (lastResult) {
    const { startedAtMs: _omit, ...rest } = lastResult;
    return { currentJob, lastResult: rest };
  }
  return { currentJob, lastResult: null };
}
