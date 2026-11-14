import { describe, expect, it, vi, beforeEach } from "vitest";
import { windowsRunnerHost } from "../src/windows-runner.ts";

const io = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async (original) => {
  const { promisify } = await import("node:util");
  return { ...await original<typeof import("node:child_process")>(), execFile: Object.assign(vi.fn(), { [promisify.custom]: io.exec }) };
});
vi.mock("../src/platform.ts", () => ({ IS_WIN: true }));

import { findListenerProcesses } from "../src/discover.ts";

beforeEach(() => { vi.clearAllMocks(); });

describe("Windows listener discovery", () => {
  it("识别尚未启动 Listener 的私有宿主，并优先接入宿主 PID", async () => {
    const directory = "C:\\用户\\it's runner";
    const host = windowsRunnerHost(directory);
    io.exec.mockResolvedValue({ stdout: JSON.stringify([
      { ProcessId: 22, Name: "Runner.Listener.exe", ExecutablePath: `${directory}\\bin\\Runner.Listener.exe`, CommandLine: `"${directory}\\bin\\Runner.Listener.exe" run` },
      { ProcessId: 11, Name: "powershell.exe", ExecutablePath: "powershell.exe", CommandLine: host.args.join(" ") },
    ]) });
    const listeners = await findListenerProcesses(true);
    expect([...listeners]).toEqual([[11, directory], [22, directory]]);
    const args = io.exec.mock.calls[0]?.[1] as string[];
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("UTF8Encoding");
  });

  it("忽略配置进程和普通 PowerShell", async () => {
    io.exec.mockResolvedValue({ stdout: JSON.stringify([
      { ProcessId: 22, Name: "Runner.Listener.exe", ExecutablePath: "C:\\run\\bin\\Runner.Listener.exe", CommandLine: '"C:\\run\\bin\\Runner.Listener.exe" configure --name run' },
      { ProcessId: 11, Name: "powershell.exe", ExecutablePath: "powershell.exe", CommandLine: "powershell -Command test" },
    ]) });
    expect(await findListenerProcesses(true)).toEqual(new Map());
  });

  it("无权限读取 Runner 身份时启动前探测失败，而后台轮询容错", async () => {
    io.exec.mockResolvedValue({ stdout: '[{"ProcessId":22,"Name":"Runner.Listener.exe","ExecutablePath":null,"CommandLine":null}]' });
    await expect(findListenerProcesses(true)).rejects.toThrow("相同权限");
    expect(await findListenerProcesses()).toEqual(new Map());
  });

  it("PowerShell 失败和空进程列表含义不同", async () => {
    io.exec.mockResolvedValue({ stdout: "[]" });
    expect(await findListenerProcesses(true)).toEqual(new Map());
    io.exec.mockRejectedValue(new Error("PowerShell unavailable"));
    await expect(findListenerProcesses(true)).rejects.toThrow("PowerShell unavailable");
  });
});
