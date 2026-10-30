import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Fleet } from "../src/fleet.ts";
import { authorizeRunners } from "../src/github-auth.ts";
import { registerRunner, validateNewRunner } from "../src/register.ts";
import type { BatchRegistrationRequest, Snapshot } from "../src/types.ts";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/github-auth.ts", () => ({ githubClientId: () => "Iv1.test", authorizeRunners: vi.fn() }));
vi.mock("../src/register.ts", () => ({ registerRunner: vi.fn(), validateNewRunner: vi.fn() }));
vi.mock("../src/discover.ts", async (original) => ({ ...await original<typeof import("../src/discover.ts")>(), readRunnerMeta: vi.fn(async () => ({ agentId: 1, agentName: "test-runner", gitHubUrl: "https://github.com/acme", workFolder: "/tmp/work", configured: true })) }));

let fleet: Fleet;
const request = (): BatchRegistrationRequest => ({
  method: "github", clientId: "Iv1.test", token: "", targetUrl: "https://github.com/acme", packagePath: "/tmp/pkg.tar.gz",
  runners: [1, 2].map((index) => ({ name: `runner-${index}`, dir: `/tmp/batch-runner-${index}`, workFolder: `/tmp/batch-work-${index}`, labels: "" })),
});

beforeEach(() => {
  vi.clearAllMocks();
  fleet = new Fleet();
  vi.spyOn(fleet, "start").mockResolvedValue();
  vi.mocked(validateNewRunner).mockResolvedValue("/tmp/pkg.tar.gz");
  vi.mocked(authorizeRunners).mockResolvedValue(["REG_1", "REG_2"]);
  vi.mocked(registerRunner).mockImplementation(async (input) => ({ ok: true, error: null, runnerDir: input.dir }));
});
afterEach(async () => { await fleet.destroy(); });

describe("一次授权批量创建", () => {
  it("授权一次，顺序注册全部实例，快照不包含任何 Token", async () => {
    const snapshots: Snapshot[] = [];
    fleet.onSnapshot((snapshot) => snapshots.push(snapshot));
    const secrets: string[] = [];
    vi.mocked(registerRunner).mockImplementation(async (input) => { secrets.push(input.token); return { ok: true, error: null, runnerDir: input.dir }; });
    await fleet.registerBatch(request());
    expect(authorizeRunners).toHaveBeenCalledOnce();
    expect(vi.mocked(authorizeRunners).mock.calls[0]![0].count).toBe(2);
    expect(secrets).toEqual(["REG_1", "REG_2"]);
    expect(fleet.start).toHaveBeenCalledTimes(2);
    expect(fleet.snapshot().registrationBatch).toMatchObject({ credentialsCleared: true, items: [{ status: "ok" }, { status: "ok" }] });
    expect(JSON.stringify(snapshots)).not.toContain("REG_");
    expect(vi.mocked(registerRunner).mock.calls.every(([input]) => input.token === "")).toBe(true);
  });

  it("个别实例失败不阻断其余实例，保留逐项错误", async () => {
    vi.mocked(registerRunner).mockResolvedValueOnce({ ok: false, error: "磁盘空间不足", runnerDir: "/tmp/batch-runner-1" }).mockResolvedValueOnce({ ok: true, error: null, runnerDir: "/tmp/batch-runner-2" });
    await fleet.registerBatch(request());
    expect(fleet.snapshot().registrationBatch?.items.map((item) => item.status)).toEqual(["error", "ok"]);
    expect(fleet.snapshot().task.message).toContain("1/2");
    expect(fleet.snapshot().authorization?.status).toBe("cleared");
  });

  it("在发起授权前完成全部目录检查", async () => {
    vi.mocked(validateNewRunner).mockRejectedValueOnce(new Error("目录非空"));
    await fleet.registerBatch(request());
    expect(authorizeRunners).not.toHaveBeenCalled();
    expect(registerRunner).not.toHaveBeenCalled();
    expect(fleet.snapshot().task.message).toContain("目录非空");
    expect(fleet.snapshot().registrationBatch?.credentialsCleared).toBe(true);
  });

  it.each(["name", "dir", "workFolder"] as const)("阻止重复 %s，不浪费授权", async (field) => {
    const input = request();
    input.runners[1]![field] = input.runners[0]![field];
    await fleet.registerBatch(input);
    expect(authorizeRunners).not.toHaveBeenCalled();
    expect(fleet.snapshot().task.status).toBe("error");
  });

  it("取消会中断授权、移除验证码，不启动注册", async () => {
    vi.mocked(authorizeRunners).mockImplementation(async (options) => {
      options.onCode({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 900_000 });
      await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      return [];
    });
    const pending = fleet.registerBatch(request());
    await vi.waitFor(() => expect(fleet.snapshot().authorization?.status).toBe("waiting"));
    fleet.cancelAuthorization();
    await pending;
    expect(registerRunner).not.toHaveBeenCalled();
    expect(fleet.snapshot().authorization).toMatchObject({ status: "cancelled" });
    expect(fleet.snapshot().authorization?.userCode).toBeUndefined();
  });

  it("手动 Token 模式不调用账号授权，完成后擦除输入引用", async () => {
    const input = { ...request(), method: "token" as const, token: "MANUAL_REGISTRATION" };
    await fleet.registerBatch(input);
    expect(authorizeRunners).not.toHaveBeenCalled();
    expect(input.token).toBe("");
    expect(fleet.snapshot().registrationBatch?.credentialsCleared).toBe(true);
  });

  it("阻止嵌套目录，即使用户用 .. 绕过文本去重", async () => {
    const input = request();
    input.runners[1]!.workFolder = `${input.runners[0]!.dir}/child/../shared`;
    await fleet.registerBatch(input);
    expect(authorizeRunners).not.toHaveBeenCalled();
    expect(fleet.snapshot().task.message).toContain("嵌套");
  });

  it("解析已有父目录的符号链接，避免两个实例解包到同一位置", async () => {
    const parent = await mkdtemp(join(tmpdir(), "rf-batch-symlink-"));
    try {
      await mkdir(join(parent, "real"));
      await symlink(join(parent, "real"), join(parent, "alias"), "junction");
      const input = request();
      input.runners[0]!.dir = join(parent, "real", "runner");
      input.runners[1]!.dir = join(parent, "alias", "runner");
      await fleet.registerBatch(input);
      expect(authorizeRunners).not.toHaveBeenCalled();
      expect(fleet.snapshot().task.status).toBe("error");
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("重复点击不会同时发起第二次授权，也会清理被拒绝请求的 Token", async () => {
    let finish: ((tokens: string[]) => void) | undefined;
    vi.mocked(authorizeRunners).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const active = fleet.registerBatch(request());
    await vi.waitFor(() => expect(authorizeRunners).toHaveBeenCalledOnce());
    const duplicate = { ...request(), token: "DO_NOT_KEEP" };
    await fleet.registerBatch(duplicate);
    expect(duplicate.token).toBe("");
    expect(authorizeRunners).toHaveBeenCalledOnce();
    finish!(["REG_1", "REG_2"]);
    await active;
  });
});
