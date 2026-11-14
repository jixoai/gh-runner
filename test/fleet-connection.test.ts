import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputLineSink } from "../src/supervisor.ts";

const isolated = vi.hoisted(() => ({ root: "", initialLines: [] as string[], onLines: null as null | ((lines: string[]) => void) }));
vi.mock("../src/config.ts", async (original) => ({
  ...await original<typeof import("../src/config.ts")>(),
  configDir: () => isolated.root,
  loadConfig: async () => ({ searchDirs: [], importedPackages: [], instances: [{ id: "runner", dir: isolated.root, autoStart: false }] }),
  saveConfig: vi.fn(),
}));
vi.mock("../src/discover.ts", async (original) => ({
  ...await original<typeof import("../src/discover.ts")>(),
  findListenerProcesses: vi.fn(async () => new Map<number, string>()),
  processStartedAt: vi.fn(async (): Promise<number | null> => null),
}));
vi.mock("../src/supervisor.ts", () => ({ startRunner: vi.fn(), stopProcessGroup: vi.fn(), pidExists: vi.fn(() => "alive") }));
vi.mock("../src/packages.ts", () => ({ listPackages: vi.fn(async () => []), PackageDownload: vi.fn() }));
vi.mock("../src/tailer.ts", () => ({
  DirTail: class {
    start(onLines: (lines: string[]) => void) { isolated.onLines = onLines; onLines(isolated.initialLines); }
    stop() {}
  },
}));

import { Fleet } from "../src/fleet.ts";
import { findListenerProcesses, processStartedAt } from "../src/discover.ts";
import { startRunner, stopProcessGroup } from "../src/supervisor.ts";

let fleet: Fleet;
let output: OutputLineSink;
let child: EventEmitter;

beforeEach(async () => {
  vi.clearAllMocks();
  isolated.initialLines = [];
  vi.mocked(processStartedAt).mockResolvedValue(null);
  isolated.root = await mkdtemp(join(tmpdir(), "runner-connection-"));
  await writeFile(join(isolated.root, ".runner"), JSON.stringify({ agentId: 114, agentName: "runner", gitHubUrl: "https://github.com/jixoai", workFolder: "_work" }));
  child = new EventEmitter();
  vi.mocked(findListenerProcesses).mockResolvedValue(new Map());
  vi.mocked(stopProcessGroup).mockResolvedValue(true);
  vi.mocked(startRunner).mockImplementation((_dir, onLine) => {
    output = onLine;
    return { pid: 4321, child: child as never };
  });
  fleet = new Fleet();
  await fleet.boot({ autoStart: false, persist: false });
});

afterEach(async () => {
  await fleet.destroy();
  await rm(isolated.root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function view() { return fleet.snapshot().instances[0]!; }

describe("Runner connection and startup guards", () => {
  it("普通输出不算在线，冲突持续重试，真正就绪后清除提示", async () => {
    await fleet.start(view().id);
    output("stdout", "✓ Connected to GitHub");
    expect(view()).toMatchObject({ processState: "running", connectionState: "connecting" });
    output("stderr", "A session for this runner already exists.");
    output("stderr", "2026-11-14 01:47:02Z: Runner connect error: Error: Conflict. Retrying until reconnected.");
    output("stdout", "Attempt to create session.");
    expect(view()).toMatchObject({ connectionState: "conflict", lastError: expect.stringContaining("每 30 秒") });
    isolated.onLines!(["2026-10-24 01:49:48Z: Listening for Jobs"]);
    expect(view().connectionState).toBe("conflict");
    output("stdout", "2026-11-14 01:49:48Z: Listening for Jobs");
    expect(view()).toMatchObject({ connectionState: "online", lastError: null });
  });

  it("历史日志不会把已停止的 Runner 标记在线", () => {
    isolated.onLines!(["2026-10-24 01:49:48Z: Listening for Jobs"]);
    expect(view()).toMatchObject({ processState: "stopped", connectionState: "disconnected" });
  });

  it("重试耗尽退出时保留可操作的会话冲突原因", async () => {
    await fleet.start(view().id);
    output("stderr", "A session for this runner already exists.");
    child.emit("close", 1, null);
    expect(view()).toMatchObject({ processState: "stopped", connectionState: "disconnected", lastError: expect.stringContaining("会话冲突重试失败") });
  });

  it("启动前重新探测并接入刚出现的外部进程", async () => {
    vi.mocked(findListenerProcesses).mockResolvedValue(new Map([[1234, await realpath(isolated.root)]]));
    await fleet.start(view().id);
    expect(startRunner).not.toHaveBeenCalled();
    expect(findListenerProcesses).toHaveBeenLastCalledWith(true);
    expect(view()).toMatchObject({ processState: "running", connectionState: "unknown", external: true, pid: 1234 });
  });

  it("重启管理器时从当前存活进程的日志恢复在线，不等待新的 Listening 行", async () => {
    await fleet.destroy();
    const startedAt = Date.now() - 60_000;
    const timestamp = new Date(startedAt + 1000).toISOString().slice(0, 19).replace("T", " ");
    isolated.initialLines = [`[${timestamp}Z INFO Terminal] WRITE LINE: ${timestamp}Z: Listening for Jobs`];
    vi.mocked(processStartedAt).mockResolvedValue(startedAt);
    vi.mocked(findListenerProcesses).mockResolvedValue(new Map([[1234, await realpath(isolated.root)]]));
    fleet = new Fleet();
    await fleet.boot({ autoStart: false, persist: false });
    expect(view()).toMatchObject({ processState: "running", connectionState: "online", external: true, pid: 1234 });
    expect(startRunner).not.toHaveBeenCalled();
  });

  it("接入后的回读日志只接受当前进程启动后的连接事件", async () => {
    const startedAt = Date.now() - 60_000;
    vi.mocked(processStartedAt).mockResolvedValue(startedAt);
    vi.mocked(findListenerProcesses).mockResolvedValue(new Map([[1234, await realpath(isolated.root)]]));
    await fleet.start(view().id);
    const stale = new Date(startedAt - 5000).toISOString().slice(0, 19).replace("T", " ");
    isolated.onLines!([`${stale}Z: Listening for Jobs`]);
    expect(view().connectionState).toBe("unknown");
    const current = new Date(startedAt + 1000).toISOString().slice(0, 19).replace("T", " ");
    isolated.onLines!([`${current}Z: Listening for Jobs`]);
    expect(view().connectionState).toBe("online");
  });

  it("当前进程日志中更晚的会话冲突不能被更早的在线记录覆盖", async () => {
    await fleet.destroy();
    const startedAt = Date.now() - 60_000;
    const online = new Date(startedAt + 1000).toISOString().slice(0, 19).replace("T", " ");
    const conflict = new Date(startedAt + 5000).toISOString().slice(0, 19).replace("T", " ");
    isolated.initialLines = [`[${conflict}Z ERR Terminal] WRITE ERROR: A session for this runner already exists.`, `${online}Z: Listening for Jobs`];
    vi.mocked(processStartedAt).mockResolvedValue(startedAt);
    vi.mocked(findListenerProcesses).mockResolvedValue(new Map([[1234, await realpath(isolated.root)]]));
    fleet = new Fleet();
    await fleet.boot({ autoStart: false, persist: false });
    expect(view()).toMatchObject({ connectionState: "conflict", lastError: expect.stringContaining("会话已被占用") });
  });

  it("读不到当前进程启动时间时不根据旧日志猜测在线", async () => {
    await fleet.destroy();
    isolated.initialLines = ["2026-10-24 01:49:48Z: Listening for Jobs"];
    vi.mocked(findListenerProcesses).mockResolvedValue(new Map([[1234, await realpath(isolated.root)]]));
    fleet = new Fleet();
    await fleet.boot({ autoStart: false, persist: false });
    expect(view()).toMatchObject({ processState: "running", connectionState: "unknown", external: true });
  });

  it("读取启动时间期间停止的 Runner 不会被日志回放重新标记在线", async () => {
    const startedAt = Date.now() - 60_000;
    const timestamp = new Date(startedAt + 1000).toISOString().slice(0, 19).replace("T", " ");
    isolated.onLines!([`${timestamp}Z: Listening for Jobs`]);
    let finishTimestamp!: (timestamp: number) => void;
    vi.mocked(processStartedAt).mockImplementationOnce(() => new Promise((resolve) => { finishTimestamp = resolve; }));
    vi.mocked(findListenerProcesses).mockResolvedValue(new Map([[1234, await realpath(isolated.root)]]));
    const starting = fleet.start(view().id);
    await vi.waitFor(() => expect(processStartedAt).toHaveBeenCalledWith(1234));
    vi.mocked(stopProcessGroup).mockImplementationOnce(async () => {
      vi.mocked(findListenerProcesses).mockResolvedValue(new Map());
      return true;
    });
    await fleet.stop(view().id);
    finishTimestamp(startedAt);
    await starting;
    expect(view()).toMatchObject({ processState: "stopped", connectionState: "disconnected", pid: null });
  });

  it("并发启动请求只创建一个进程，并释放启动锁", async () => {
    await Promise.all(Array.from({ length: 10 }, () => fleet.start(view().id)));
    expect(startRunner).toHaveBeenCalledTimes(1);
    await expect(readFile(join(isolated.root, ".gh-runner-start.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("同一目录的两个 GH Runner 窗口不能同时拉起", async () => {
    const anotherFleet = new Fleet();
    await anotherFleet.boot({ autoStart: false, persist: false });
    let finishScan: ((listeners: Map<number, string>) => void) | undefined;
    vi.mocked(findListenerProcesses).mockImplementationOnce(() => new Promise((resolve) => { finishScan = resolve; }));
    const starting = fleet.start(view().id);
    await vi.waitFor(() => expect(finishScan).toBeDefined());
    try {
      await anotherFleet.start(view().id);
      expect(anotherFleet.snapshot().instances[0]?.lastError).toContain("另一个 GH Runner");
      finishScan!(new Map());
      await starting;
      expect(startRunner).toHaveBeenCalledTimes(1);
    } finally {
      finishScan?.(new Map());
      await starting;
      await anotherFleet.destroy();
    }
  });

  it("进程探测失败时安全取消，不盲目重复启动", async () => {
    vi.mocked(findListenerProcesses).mockRejectedValue(new Error("PowerShell unavailable"));
    await fleet.start(view().id);
    expect(startRunner).not.toHaveBeenCalled();
    expect(view()).toMatchObject({ processState: "stopped", lastError: expect.stringContaining("PowerShell unavailable") });
  });

  it("等待进程探测时点击停止会取消尚未完成的启动", async () => {
    let finishScan: ((listeners: Map<number, string>) => void) | undefined;
    vi.mocked(findListenerProcesses).mockImplementationOnce(() => new Promise((resolve) => { finishScan = resolve; }));
    const starting = fleet.start(view().id);
    await vi.waitFor(() => expect(finishScan).toBeDefined());
    await fleet.stop(view().id);
    finishScan!(new Map());
    await starting;
    expect(startRunner).not.toHaveBeenCalled();
    expect(view()).toMatchObject({ processState: "stopped", connectionState: "disconnected" });
  });

  it("关闭 GH Runner 后不会完成尚在等待的启动请求", async () => {
    let finishScan: ((listeners: Map<number, string>) => void) | undefined;
    vi.mocked(findListenerProcesses).mockImplementationOnce(() => new Promise((resolve) => { finishScan = resolve; }));
    const starting = fleet.start(view().id);
    await vi.waitFor(() => expect(finishScan).toBeDefined());
    await fleet.destroy();
    finishScan!(new Map());
    await starting;
    expect(startRunner).not.toHaveBeenCalled();
    await fleet.start(view().id);
    expect(startRunner).not.toHaveBeenCalled();
  });

  it("不同目录共用注册身份时拒绝启动", async () => {
    const duplicate = await mkdtemp(join(tmpdir(), "duplicate-runner-"));
    try {
      await writeFile(join(duplicate, ".runner"), await readFile(join(isolated.root, ".runner")));
      vi.mocked(findListenerProcesses).mockResolvedValue(new Map([[9999, duplicate]]));
      await fleet.start(view().id);
      expect(startRunner).not.toHaveBeenCalled();
      expect(view().lastError).toContain("同一 Runner 注册身份");
    } finally {
      await rm(duplicate, { recursive: true, force: true });
    }
  });

  it("停止进行中不能重新启动，外部停止失败仍保留 PID", async () => {
    vi.mocked(findListenerProcesses).mockResolvedValue(new Map([[1234, await realpath(isolated.root)]]));
    await fleet.start(view().id);
    let finishStop: ((ok: boolean) => void) | undefined;
    vi.mocked(stopProcessGroup).mockImplementationOnce(() => new Promise((resolve) => { finishStop = resolve; }));
    const stopping = fleet.stop(view().id);
    await vi.waitFor(() => expect(finishStop).toBeDefined());
    await fleet.start(view().id);
    expect(startRunner).not.toHaveBeenCalled();
    finishStop!(false);
    await stopping;
    expect(view()).toMatchObject({ processState: "running", external: true, pid: 1234, lastError: expect.stringContaining("停止失败") });
  });
});
