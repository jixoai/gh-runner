import { describe, expect, it } from "vitest";
import type { InstanceView } from "../src/ui-app/lib/host.ts";
import { dotClass, stateText } from "../src/ui-app/lib/format.ts";

const instance: InstanceView = {
  id: "runner", dir: "/runner", name: "runner", agentId: 114, orgUrl: null, workFolder: null,
  configured: true, processState: "running", connectionState: "online", external: false, autoStart: true,
  pid: 1234, currentJob: null, lastResult: null, lastError: null, logTotal: 0,
};

describe("连接状态文案", () => {
  it.each([
    ["online", "空闲", "running"],
    ["connecting", "连接中…", "starting"],
    ["conflict", "会话冲突 · 重试中", "conflict"],
    ["unknown", "连接待确认", "unknown"],
  ] as const)("%s 不误报空闲", (connectionState, label, dot) => {
    expect(stateText({ ...instance, connectionState })).toBe(label);
    expect(dotClass({ ...instance, connectionState })).toBe(dot);
  });

  it("停止状态优先于历史作业与连接状态", () => {
    const stopped = { ...instance, processState: "stopped" as const, currentJob: { job: "old", startedAt: "2026-10-24T01:00:00Z" } };
    expect(stateText(stopped)).toBe("已停止");
    expect(dotClass(stopped)).toBe("stopped");
    expect(stateText({ ...stopped, processState: "stopping" })).toBe("停止中…");
  });
});
