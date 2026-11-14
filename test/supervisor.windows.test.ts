import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
vi.mock("../src/platform.ts", () => ({
  IS_WIN: true,
  runnerSpawn: () => ({ file: "C:\\runner\\bin\\Runner.Listener.exe", args: ["run"] }),
}));

import { spawn } from "node:child_process";
import { startRunner, stopProcessGroup } from "../src/supervisor.ts";

function childProcess(pid = 1234) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: vi.fn(),
    kill: vi.fn(),
  });
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Windows supervisor", () => {
  it("启动私有控制台宿主，缓存完整 UTF-8 行并在 EOF 交付尾行", () => {
    const child = childProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const output = vi.fn();
    expect(startRunner("C:\\runner", output)?.pid).toBe(1234);
    expect(spawn).toHaveBeenCalledWith("powershell.exe", expect.arrayContaining(["-EncodedCommand"]), expect.objectContaining({ detached: true, windowsHide: true }));
    child.stdout.write("A session for this runner ");
    expect(output).not.toHaveBeenCalled();
    child.stdout.write("already exists.\r\n");
    expect(output).toHaveBeenCalledWith("stdout", "A session for this runner already exists.");
    const encoded = Buffer.from("✓ Connected to GitHub\n");
    child.stdout.write(encoded.subarray(0, 1));
    child.stdout.write(encoded.subarray(1));
    expect(output).toHaveBeenCalledWith("stdout", "✓ Connected to GitHub");
    child.stderr.end("tail error");
    return new Promise<void>((resolve) => child.stderr.on("end", () => {
      expect(output).toHaveBeenCalledWith("stderr", "tail error");
      resolve();
    }));
  });

  it.each([true, false])("先优雅停止，只有仍存活时才树强杀（优雅退出：%s）", async (graceful) => {
    vi.useFakeTimers();
    let alive = true;
    vi.spyOn(process, "kill").mockImplementation(() => {
      if (!alive) throw Object.assign(new Error("dead"), { code: "ESRCH" });
      return true;
    });
    vi.mocked(spawn).mockImplementation((file) => {
      const child = childProcess(5678);
      if (file === "taskkill") alive = false;
      setTimeout(() => {
        if (graceful) alive = false;
        child.emit("close", 0);
      }, 0);
      return child as never;
    });
    const stopped = stopProcessGroup(1234);
    await vi.advanceTimersByTimeAsync(36_000);
    expect(await stopped).toBe(true);
    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe("powershell.exe");
    expect(vi.mocked(spawn).mock.calls.some(([file]) => file === "taskkill")).toBe(!graceful);
    if (!graceful) expect(spawn).toHaveBeenLastCalledWith("taskkill", ["/pid", "1234", "/T", "/F"], expect.anything());
  });

  it("无可用控制台时退回强杀，不无限等待", async () => {
    vi.useFakeTimers();
    let alive = true;
    vi.spyOn(process, "kill").mockImplementation(() => {
      if (!alive) throw Object.assign(new Error("dead"), { code: "ESRCH" });
      return true;
    });
    vi.mocked(spawn).mockImplementation((file) => {
      const child = childProcess();
      if (file === "taskkill") alive = false;
      setTimeout(() => child.emit("close", file === "taskkill" ? 0 : 1), 0);
      return child as never;
    });
    const stopped = stopProcessGroup(1234);
    await vi.advanceTimersByTimeAsync(100);
    expect(await stopped).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
