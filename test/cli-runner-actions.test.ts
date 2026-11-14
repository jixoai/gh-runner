import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  runner: { id: "runner", name: "runner", dir: "/runner", processState: "stopped", lastError: null as string | null },
  destroy: vi.fn(),
}));

vi.mock("../src/fleet.ts", () => ({
  Fleet: class {
    async boot() {}
    async start() {}
    async stop() {}
    async destroy() { state.destroy(); }
    snapshot() { return { instances: [state.runner] }; }
    view() { return state.runner; }
  },
}));

import { runCli } from "../src/cli.ts";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  state.runner.processState = "stopped";
  state.runner.lastError = null;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("CLI Runner 请求反馈", () => {
  it("启动被安全检查拒绝时报告原因，不显示请求已提交", async () => {
    state.runner.lastError = "启动已取消：同一 Runner 注册身份已在其他目录运行";
    await expect(runCli(["start", "runner"])).rejects.toThrow(state.runner.lastError);
    expect(console.log).not.toHaveBeenCalled();
    expect(state.destroy).toHaveBeenCalled();
  });

  it("停止失败时报告仍在运行的进程错误", async () => {
    state.runner.processState = "running";
    state.runner.lastError = "停止失败：进程无响应或无权限";
    await expect(runCli(["stop", "runner"])).rejects.toThrow("停止失败");
    expect(console.log).not.toHaveBeenCalled();
  });

  it("成功提交启动请求时保留确认信息", async () => {
    state.runner.processState = "starting";
    await runCli(["start", "runner"]);
    expect(console.log).toHaveBeenCalledWith("runner: start 请求已提交");
  });

  it("对已停止的实例请求停止，不误报上一次启动的错误", async () => {
    state.runner.lastError = "上一次启动失败";
    await runCli(["stop", "runner"]);
    expect(console.log).toHaveBeenCalledWith("runner: stop 请求已提交");
  });
});
