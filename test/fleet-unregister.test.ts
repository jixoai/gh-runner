import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fleet } from "../src/fleet.ts";
import { authorizeRunners } from "../src/github-auth.ts";
import { registerRunner, unregisterRunner } from "../src/register.ts";
import { instanceIdOf, findListenerProcesses } from "../src/discover.ts";
import { loadConfig, saveConfig } from "../src/config.ts";
import type { RunnerOperationRequest, ToolConfig } from "../src/types.ts";

const tail = vi.hoisted(() => ({ onLines: null as ((lines: string[]) => void) | null }));

vi.mock("../src/config.ts", async (original) => ({ ...await original<typeof import("../src/config.ts")>(), loadConfig: vi.fn(), saveConfig: vi.fn() }));
vi.mock("../src/github-auth.ts", () => ({ githubClientId: () => "Iv1.test", authorizeRunners: vi.fn() }));
vi.mock("../src/register.ts", () => ({ registerRunner: vi.fn(), unregisterRunner: vi.fn(), validateNewRunner: vi.fn() }));
vi.mock("../src/discover.ts", async (original) => ({ ...await original<typeof import("../src/discover.ts")>(), findListenerProcesses: vi.fn(async () => new Map()) }));
vi.mock("../src/tailer.ts", () => ({ DirTail: class { start(onLines: (lines: string[]) => void) { tail.onLines = onLines; } stop() {} } }));

let fleet: Fleet;
let dir: string;
let config: ToolConfig;
const metadata = { agentId: 42, agentName: "test-runner", gitHubUrl: "https://github.com/alice/project", workFolder: "_work" };
const input = (action: RunnerOperationRequest["action"] = "unregister"): RunnerOperationRequest => ({ requestId: "test-operation", id: instanceIdOf(dir), action, method: "github", token: "" });

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await mkdtemp(join(tmpdir(), "rf-fleet-remove-"));
  await mkdir(join(dir, "_work"));
  await writeFile(join(dir, "_work", "keep.txt"), "WORK");
  await writeFile(join(dir, ".runner"), JSON.stringify(metadata));
  await writeFile(join(dir, "config.sh"), "#!/bin/sh\n");
  config = { searchDirs: [], importedPackages: [], instances: [{ id: instanceIdOf(dir), dir, autoStart: false }] };
  vi.mocked(loadConfig).mockImplementation(async () => structuredClone(config));
  vi.mocked(saveConfig).mockImplementation(async (next) => { config = structuredClone(next); });
  vi.mocked(findListenerProcesses).mockResolvedValue(new Map());
  vi.mocked(authorizeRunners).mockImplementation(async () => ["REMOVE_SECRET"]);
  vi.mocked(unregisterRunner).mockImplementation(async () => { await rm(join(dir, ".runner")); });
  vi.mocked(registerRunner).mockImplementation(async () => {
    await writeFile(join(dir, ".runner"), JSON.stringify({ ...metadata, agentId: 43 }));
    return { ok: true, error: null, runnerDir: dir };
  });
  fleet = new Fleet();
  await fleet.boot({ autoStart: false });
});
afterEach(async () => { await fleet.destroy(); await rm(dir, { recursive: true, force: true }); });

describe("注销及原目录复用", () => {
  it("作业中不申请授权，不强停作业", async () => {
    tail.onLines!(["2026-10-31 00:00:00Z: Running job: test-build"]);
    await fleet.operateRunner(input());
    expect(authorizeRunners).not.toHaveBeenCalled();
    expect(unregisterRunner).not.toHaveBeenCalled();
    expect(fleet.snapshot().runnerOperation?.message).toContain("作业");
  });

  it("外部终端或系统服务管理的实例必须先停止", async () => {
    await fleet.destroy();
    vi.mocked(findListenerProcesses).mockResolvedValue(new Map([[12345, await realpath(dir)]]));
    fleet = new Fleet();
    await fleet.boot({ autoStart: false });
    await fleet.operateRunner(input());
    expect(authorizeRunners).not.toHaveBeenCalled();
    expect(unregisterRunner).not.toHaveBeenCalled();
    expect(fleet.snapshot().runnerOperation?.message).toContain("外部");
  });

  it("授权过程中开始作业时停止后续注销", async () => {
    vi.mocked(authorizeRunners).mockImplementation(async () => {
      tail.onLines!(["2026-10-31 00:00:00Z: Running job: test-build"]);
      return ["REMOVE_SECRET"];
    });
    await fleet.operateRunner(input());
    expect(unregisterRunner).not.toHaveBeenCalled();
    expect(fleet.snapshot().runnerOperation?.message).toContain("授权期间");
  });

  it("授权期间注册配置被替换时不注销其他 runner", async () => {
    vi.mocked(authorizeRunners).mockImplementation(async () => {
      await writeFile(join(dir, ".runner"), JSON.stringify({ ...metadata, agentId: 999 }));
      return ["REMOVE_SECRET"];
    });
    await fleet.operateRunner(input());
    expect(unregisterRunner).not.toHaveBeenCalled();
    expect(fleet.snapshot().runnerOperation?.message).toContain("配置发生变化");
  });

  it("注销后保留实例、工作目录和重注册信息，禁用自启，快照不包含凭据", async () => {
    const snapshots: string[] = [];
    fleet.onSnapshot((snapshot) => snapshots.push(JSON.stringify(snapshot)));
    await fleet.operateRunner(input());
    expect(vi.mocked(authorizeRunners).mock.calls[0]![0]).toMatchObject({ purpose: "remove", count: 1, targetUrl: metadata.gitHubUrl });
    expect(unregisterRunner).toHaveBeenCalledWith(dir, "REMOVE_SECRET", expect.any(Function));
    expect(fleet.view(instanceIdOf(dir))).toMatchObject({ configured: false, unregistered: true, autoStart: false, name: "test-runner" });
    expect(config.instances[0]?.unregistered).toEqual({ name: "test-runner", targetUrl: metadata.gitHubUrl, workFolder: join(dir, "_work") });
    expect(fleet.snapshot().runnerOperation).toMatchObject({ status: "ok", action: "unregister" });
    expect(snapshots.join("\n")).not.toContain("REMOVE_SECRET");
    expect(await readFile(join(dir, "_work", "keep.txt"), "utf8")).toBe("WORK");
  });

  it("重启管理器后仍可打开原工作目录、重新授权注册，注册完保持停止", async () => {
    await fleet.operateRunner(input());
    await fleet.destroy();
    fleet = new Fleet();
    await fleet.boot({ autoStart: false });
    expect(fleet.view(instanceIdOf(dir))).toMatchObject({ unregistered: true, workFolder: join(dir, "_work"), orgUrl: metadata.gitHubUrl });
    await fleet.operateRunner(input("reregister"));
    expect(registerRunner).toHaveBeenCalledWith(expect.objectContaining({ dir, reusePackage: true, packagePath: null, workFolder: join(dir, "_work") }), [], expect.any(Function));
    expect(vi.mocked(registerRunner).mock.calls[0]![0].token).toBe("");
    expect(config.instances[0]?.unregistered).toBeUndefined();
    expect(fleet.view(instanceIdOf(dir))).toMatchObject({ configured: true, unregistered: false, processState: "stopped", agentId: 43 });
  });

  it("取消授权不停止、不注销，也不遗留验证码", async () => {
    const stop = vi.spyOn(fleet, "stop");
    vi.mocked(authorizeRunners).mockImplementation(async (options) => {
      options.onCode({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 900_000 });
      await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      return [];
    });
    const pending = fleet.operateRunner(input());
    await vi.waitFor(() => expect(fleet.snapshot().authorization?.status).toBe("waiting"));
    fleet.cancelAuthorization();
    await pending;
    expect(stop).not.toHaveBeenCalled();
    expect(unregisterRunner).not.toHaveBeenCalled();
    expect(fleet.snapshot().authorization).toMatchObject({ status: "cancelled" });
    expect(fleet.snapshot().authorization?.userCode).toBeUndefined();
  });

  it("重复点击与并发注册共用互斥保护，丢弃请求的 Token 也会清除", async () => {
    let finish!: (tokens: string[]) => void;
    vi.mocked(authorizeRunners).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = fleet.operateRunner(input());
    await vi.waitFor(() => expect(authorizeRunners).toHaveBeenCalledOnce());
    const duplicate = { ...input(), token: "DO_NOT_KEEP" };
    await fleet.operateRunner(duplicate);
    expect(duplicate.token).toBe("");
    const start = vi.spyOn(fleet, "start");
    await fleet.start(instanceIdOf(dir));
    expect(fleet.view(instanceIdOf(dir))?.processState).toBe("stopped");
    start.mockRestore();
    finish(["REMOVE_SECRET"]);
    await pending;
    expect(unregisterRunner).toHaveBeenCalledOnce();
  });

  it("手动注销 Token 模式不使用账号授权", async () => {
    const request = { ...input(), method: "token" as const, token: "MANUAL_REMOVE" };
    await fleet.operateRunner(request);
    expect(authorizeRunners).not.toHaveBeenCalled();
    expect(unregisterRunner).toHaveBeenCalledWith(dir, "MANUAL_REMOVE", expect.any(Function));
    expect(request.token).toBe("");
  });

  it("注销失败仍保留注册记录，不展示成功，也不启用重新注册", async () => {
    vi.mocked(unregisterRunner).mockRejectedValueOnce(new Error("必须先卸载系统服务"));
    await fleet.operateRunner(input());
    expect(fleet.snapshot().runnerOperation).toMatchObject({ status: "error", message: "必须先卸载系统服务" });
    expect(fleet.view(instanceIdOf(dir))?.configured).toBe(true);
    expect(config.instances[0]?.unregistered).toBeUndefined();
  });

  it("已运行的受管 runner 在执行注销命令前确实停止", async () => {
    await writeFile(join(dir, "run.sh"), "#!/bin/sh\ntrap 'exit 0' TERM INT\necho '2026-10-31 00:00:00Z: Listening for Jobs'\nwhile true; do sleep 0.1; done\n");
    await chmod(join(dir, "run.sh"), 0o755);
    const id = instanceIdOf(dir);
    try {
      await fleet.start(id);
      await vi.waitFor(() => expect(fleet.view(id)?.processState).toBe("running"));
      expect(fleet.view(id)?.pid).not.toBeNull();
      vi.mocked(unregisterRunner).mockImplementationOnce(async () => {
        expect(fleet.view(id)).toMatchObject({ processState: "stopped", pid: null });
        await rm(join(dir, ".runner"));
      });
      await fleet.operateRunner(input());
      expect(fleet.snapshot().runnerOperation?.status).toBe("ok");
      expect(fleet.view(id)?.pid).toBeNull();
    } finally { await fleet.stop(id); }
  });

  it("只读诊断模式不会发起注销授权", async () => {
    await fleet.destroy();
    fleet = new Fleet();
    await fleet.boot({ autoStart: false, persist: false });
    await fleet.operateRunner(input());
    expect(authorizeRunners).not.toHaveBeenCalled();
    expect(unregisterRunner).not.toHaveBeenCalled();
    expect(fleet.snapshot().runnerOperation?.message).toContain("只读");
  });

  it("重新注册缺少安装文件时先报错，不浪费一次授权", async () => {
    await fleet.operateRunner(input());
    vi.mocked(authorizeRunners).mockClear();
    await rm(join(dir, "config.sh"));
    await fleet.operateRunner(input("reregister"));
    expect(authorizeRunners).not.toHaveBeenCalled();
    expect(fleet.snapshot().runnerOperation?.message).toContain("安装文件已缺失");
  });
});
