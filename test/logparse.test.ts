/*
 * logparse 单元测试：样本全部取自本机真实 runner 日志（mac-ext-01..04，2026-10-24），
 * 含 diag 包裹形态、stdout 裸形态、中文/括号/斜杠 job 名。
 */
import { describe, expect, it } from "vitest";
import { normalizeLine, parseConsoleLine, replayJobState, toIsoUtc } from "../src/logparse.ts";

describe("normalizeLine", () => {
  it("剥离 diag 包裹与 ANSI", () => {
    const diag =
      "[2026-10-24 10:16:04Z INFO Terminal] WRITE LINE: 2026-10-24 10:16:04Z: Job build-win completed with result: Succeeded";
    const ansi = "2026-10-24 10:16:04Z: \x1b[32mJob build-win completed with result: Succeeded\x1b[0m";
    expect(normalizeLine(diag)).toBe("2026-10-24 10:16:04Z: Job build-win completed with result: Succeeded");
    expect(normalizeLine(ansi)).toBe("2026-10-24 10:16:04Z: Job build-win completed with result: Succeeded");
  });

  it("非事件行返回 null", () => {
    expect(normalizeLine("[.. INFO Terminal] WRITE LINE: 2026-10-24 10:16:04Z: Current runner version: '2.338.1'")).toBeNull();
    expect(normalizeLine("random stdout noise")).toBeNull();
  });
});

describe("parseConsoleLine", () => {
  it("解析 diag 形态的 job-end（Succeeded）", () => {
    const line =
      "[2026-10-24 10:16:04Z INFO Terminal] WRITE LINE: 2026-10-24 10:16:04Z: Job build-win completed with result: Succeeded";
    expect(parseConsoleLine(line)).toEqual({
      at: "2026-10-24T10:16:04Z",
      kind: "job-end",
      job: "build-win",
      outcome: "Succeeded",
    });
  });

  it("解析 stdout 形态的 job-start（中文/括号/斜杠名不截断）", () => {
    const line = "2026-10-24 10:16:10Z: Running job: 核心门禁（cli / contracts / icons / hermes）";
    expect(parseConsoleLine(line)).toEqual({
      at: "2026-10-24T10:16:10Z",
      kind: "job-start",
      job: "核心门禁（cli / contracts / icons / hermes）",
    });
  });

  it("解析 Failed 与 Listening for Jobs", () => {
    expect(parseConsoleLine("2026-10-24 10:17:03Z: Job lint-test-scan completed with result: Failed")?.outcome).toBe("Failed");
    expect(parseConsoleLine("2026-10-24 10:18:00Z: Listening for Jobs")).toEqual({
      at: "2026-10-24T10:18:00Z",
      kind: "idle",
    });
  });

  it("job 名含 ' completed with result: ' 样貌的极端情况：Running 行优先整体截取", () => {
    const line = "2026-10-24 10:00:00Z: Running job: Job A completed with result: Succeeded（作业名即如此）";
    expect(parseConsoleLine(line)?.kind).toBe("job-start");
  });
});

describe("replayJobState", () => {
  it("恢复 currentJob 与 lastResult（含时长）", () => {
    const lines = [
      "2026-10-24 10:10:00Z: Running job: build-mac",
      "2026-10-24 10:25:00Z: Job build-mac completed with result: Succeeded",
      "2026-10-24 10:25:06Z: Running job: deploy",
    ];
    const { currentJob, lastResult } = replayJobState(lines);
    expect(currentJob).toEqual({ job: "deploy", startedAt: "2026-10-24T10:25:06Z" });
    expect(lastResult).toEqual({
      job: "build-mac",
      outcome: "Succeeded",
      at: "2026-10-24T10:25:00Z",
      durationMs: 15 * 60 * 1000,
    });
  });

  it("Listening 清空 currentJob", () => {
    const { currentJob } = replayJobState([
      "2026-10-24 10:10:00Z: Running job: deploy",
      "2026-10-24 10:11:00Z: Job deploy completed with result: Failed",
      "2026-10-24 10:11:05Z: Listening for Jobs",
    ]);
    expect(currentJob).toBeNull();
  });
});

describe("toIsoUtc", () => {
  it("runner 控制台时间戳按 UTC 解析", () => {
    expect(toIsoUtc("2026-10-24 10:16:04")).toBe("2026-10-24T10:16:04Z");
    expect(Date.parse(toIsoUtc("2026-10-24 10:16:04"))).toBe(Date.UTC(2026, 9, 24, 10, 16, 4));
  });
});
