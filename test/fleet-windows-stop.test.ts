import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isolated = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/config.ts", async (original) => ({
  ...await original<typeof import("../src/config.ts")>(),
  configDir: () => isolated.root,
  loadConfig: async () => ({ searchDirs: [], importedPackages: [], instances: [{ id: "runner", dir: isolated.root, autoStart: false }] }),
  saveConfig: vi.fn(),
}));
vi.mock("../src/platform.ts", async (original) => ({
  ...await original<typeof import("../src/platform.ts")>(),
  PLATFORM: "win32",
  IS_WIN: true,
}));
vi.mock("../src/discover.ts", async (original) => ({
  ...await original<typeof import("../src/discover.ts")>(),
  findListenerProcesses: vi.fn(),
}));
vi.mock("../src/supervisor.ts", () => ({ startRunner: vi.fn(), stopProcessGroup: vi.fn(), pidExists: vi.fn() }));
vi.mock("../src/packages.ts", () => ({ listPackages: vi.fn(async () => []), PackageDownload: vi.fn() }));
vi.mock("../src/tailer.ts", () => ({ DirTail: class { start() {} stop() {} } }));

import { Fleet } from "../src/fleet.ts";
import { findListenerProcesses } from "../src/discover.ts";
import { pidExists, startRunner, stopProcessGroup } from "../src/supervisor.ts";

let fleet: Fleet;
let processes: Map<number, string>;
let directory: string;

beforeEach(async () => {
  vi.clearAllMocks();
  isolated.root = await mkdtemp(join(tmpdir(), "runner-windows-stop-"));
  directory = await realpath(isolated.root);
  await writeFile(join(directory, ".runner"), JSON.stringify({ agentId: 114, agentName: "runner", gitHubUrl: "https://github.com/jixoai", workFolder: "_work" }));
  processes = new Map([[4321, directory], [4322, directory]]);
  vi.mocked(findListenerProcesses).mockImplementation(async () => new Map(processes));
  vi.mocked(pidExists).mockImplementation((pid) => processes.has(pid) ? "alive" : "dead");
  vi.mocked(stopProcessGroup).mockImplementation(async (pid) => { processes.delete(pid); return true; });
  fleet = new Fleet();
  await fleet.boot({ autoStart: false, persist: false });
});

afterEach(async () => {
  await fleet.destroy();
  vi.useRealTimers();
  await rm(isolated.root, { recursive: true, force: true });
});

const view = () => fleet.snapshot().instances[0]!;

describe("Windows 重新接入后的停止确认", () => {
  it("重启后识别宿主，停止同目录宿主和残留 Listener 后才显示已停止", async () => {
    await fleet.destroy();
    fleet = new Fleet();
    await fleet.boot({ autoStart: false, persist: false });
    expect(view()).toMatchObject({ processState: "running", external: true, pid: 4321 });
    await fleet.stop(view().id);
    expect(stopProcessGroup).toHaveBeenNthCalledWith(1, 4321, 6000);
    expect(stopProcessGroup).toHaveBeenNthCalledWith(2, 4322, 6000);
    expect(view()).toMatchObject({ processState: "stopped", pid: null, lastError: null });
    expect(findListenerProcesses).toHaveBeenLastCalledWith(true);
    expect(startRunner).not.toHaveBeenCalled();
  });

  it("宿主已退出时改为停止仍在运行的 Listener", async () => {
    processes.delete(4321);
    await fleet.stop(view().id);
    expect(stopProcessGroup).toHaveBeenCalledExactlyOnceWith(4322, 6000);
    expect(view()).toMatchObject({ processState: "stopped", pid: null });
  });

  it("旧 PID 被其他实例复用时不误杀，而是停止本目录当前的进程", async () => {
    processes.set(4321, `${directory}-other`);
    await fleet.stop(view().id);
    expect(stopProcessGroup).toHaveBeenCalledExactlyOnceWith(4322, 6000);
    expect(processes.has(4321)).toBe(true);
    expect(view().processState).toBe("stopped");
  });

  it("停止失败保留真实残留 PID，点击再次停止仍可重试", async () => {
    vi.mocked(stopProcessGroup).mockImplementation(async (pid) => {
      if (pid === 4321) { processes.delete(pid); return true; }
      return false;
    });
    await fleet.stop(view().id);
    expect(view()).toMatchObject({ processState: "running", external: true, pid: 4322, lastError: expect.stringContaining("停止失败") });
    vi.mocked(stopProcessGroup).mockImplementation(async (pid) => { processes.delete(pid); return true; });
    await fleet.stop(view().id);
    expect(view()).toMatchObject({ processState: "stopped", pid: null, lastError: null });
  });

  it("无法读取进程身份时保留错误和运行状态，不宣称停止成功", async () => {
    vi.mocked(findListenerProcesses).mockRejectedValue(new Error("CIM unavailable"));
    await fleet.stop(view().id);
    expect(stopProcessGroup).not.toHaveBeenCalled();
    expect(view()).toMatchObject({ processState: "running", pid: 4321, lastError: expect.stringContaining("CIM unavailable") });
  });

  it("无法确认存活进程的身份时不盲目终止", async () => {
    processes.clear();
    vi.mocked(pidExists).mockReturnValue("alive");
    await fleet.stop(view().id);
    expect(stopProcessGroup).not.toHaveBeenCalled();
    expect(view()).toMatchObject({ processState: "running", pid: 4321, lastError: expect.stringContaining("无法确认") });
  });

  it("停止失败后的后台探测为空时不把仍存活的 Runner 误报为已停止", async () => {
    await fleet.destroy();
    vi.useFakeTimers();
    fleet = new Fleet();
    await fleet.boot({ autoStart: false, persist: false });
    vi.mocked(findListenerProcesses).mockImplementation(async (strict) => {
      if (strict) throw new Error("CIM unavailable");
      return new Map();
    });
    await fleet.stop(view().id);
    await vi.advanceTimersByTimeAsync(2500);
    expect(view()).toMatchObject({ processState: "running", pid: 4321, lastError: expect.stringContaining("CIM unavailable") });
  });

  it("停止后被系统服务重新拉起时保留运行状态和新的 PID", async () => {
    vi.mocked(stopProcessGroup).mockImplementation(async (pid) => {
      processes.delete(pid);
      if (pid === 4322) processes.set(5678, directory);
      return true;
    });
    await fleet.stop(view().id);
    expect(view()).toMatchObject({ processState: "running", pid: 5678, lastError: expect.stringContaining("停止失败") });
  });
});
