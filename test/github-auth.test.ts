import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeRunners, githubClientId } from "../src/github-auth.ts";
import { parseRunnerTarget } from "../src/github-target.ts";
import { setTimeout as delay } from "node:timers/promises";
import { createPackageTransport } from "../src/package-network.ts";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));
vi.mock("../src/package-network.ts", () => ({ createPackageTransport: vi.fn() }));

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const codeResponse = () => json({ device_code: "PRIVATE_DEVICE_CODE", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
const options = () => ({ clientId: "Iv1.test-client", targetUrl: "https://github.com/acme", count: 1, signal: new AbortController().signal, onCode: vi.fn(), onAuthorized: vi.fn() });

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(delay).mockImplementation(async () => {});
});

describe("内置 GitHub App Client ID", () => {
  it.each([
    [undefined, undefined, "Iv23liwxZ2AQwKPeyeYF"],
    ["", "", "Iv23liwxZ2AQwKPeyeYF"],
    ["   ", "   ", "Iv23liwxZ2AQwKPeyeYF"],
    [undefined, " Iv1.build ", "Iv1.build"],
    [" Iv1.runtime ", "Iv1.build", "Iv1.runtime"],
  ])("运行环境 %j，构建默认值 %j → %s", (runtime, build, expected) => {
    vi.stubEnv("GH_RUNNER_GITHUB_CLIENT_ID", runtime);
    vi.stubGlobal("__GITHUB_APP_CLIENT_ID__", build);
    expect(githubClientId()).toBe(expected);
  });
});

describe("GitHub Device Flow", () => {
  it("默认所有授权步骤共用代理连接，并在完成后释放连接", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(codeResponse()).mockResolvedValueOnce(json({ access_token: "PRIVATE_ACCESS" })).mockResolvedValueOnce(json({ token: "REMOVE_SECRET" }, 201));
    const close = vi.fn(async () => {});
    vi.mocked(createPackageTransport).mockResolvedValueOnce({ description: "系统代理 · HTTPS 127.0.0.1:7890", fetch: request, close });
    const raw = vi.fn<typeof fetch>().mockRejectedValue(new Error("不应绕过代理"));
    vi.stubGlobal("fetch", raw);
    const input = { ...options(), purpose: "remove" as const };
    expect(await authorizeRunners(input)).toEqual(["REMOVE_SECRET"]);
    expect(createPackageTransport).toHaveBeenCalledWith(input.signal);
    expect(request.mock.calls.map((call) => new URL(String(call[0])).hostname)).toEqual(["github.com", "github.com", "api.github.com"]);
    expect(raw).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("申请验证码失败也释放代理连接，不回显底层敏感错误", async () => {
    const close = vi.fn(async () => {});
    vi.mocked(createPackageTransport).mockResolvedValueOnce({ description: "系统代理 · HTTPS 127.0.0.1:7890", fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("SECRET_PROXY_PASSWORD")), close });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("旧直连路径")));
    const pending = authorizeRunners(options());
    await expect(pending).rejects.toThrow("申请 GitHub 设备验证码失败");
    await expect(pending).rejects.toThrow("127.0.0.1:7890");
    await expect(pending).rejects.not.toThrow("SECRET_PROXY_PASSWORD");
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 2])("第 %s 步超时给出阶段和重试指引", async (step) => {
    const request = vi.fn<typeof fetch>();
    if (step > 0) request.mockResolvedValueOnce(codeResponse());
    if (step > 1) request.mockResolvedValueOnce(json({ access_token: "PRIVATE_ACCESS" }));
    request.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const pending = authorizeRunners({ ...options(), purpose: "remove" }, request);
    await expect(pending).rejects.toThrow(["申请 GitHub 设备验证码超时", "等待 GitHub 授权确认超时", "申请 runner 注销 Token 超时"][step]);
    await expect(pending).rejects.toThrow("网络和代理");
  });

  it("响应头到达后读取响应体超时也显示授权阶段，不误报响应格式", async () => {
    const response = codeResponse();
    vi.spyOn(response, "json").mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
    await expect(authorizeRunners(options(), vi.fn<typeof fetch>().mockResolvedValueOnce(response))).rejects.toThrow("申请 GitHub 设备验证码超时");
  });

  it("申请验证码时取消不会误报超时", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(authorizeRunners({ ...options(), signal: controller.signal }, request)).rejects.toThrow("授权已取消");
  });

  it.each(["https://github.com/acme", "https://github.com/alice/project"])("注销使用独立 remove-token 接口：%s", async (targetUrl) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(codeResponse()).mockResolvedValueOnce(json({ access_token: "PRIVATE_ACCESS", refresh_token: "PRIVATE_REFRESH" })).mockResolvedValueOnce(json({ token: "REMOVE_SECRET" }, 201));
    const input = { ...options(), purpose: "remove" as const, targetUrl };
    expect(await authorizeRunners(input, request)).toEqual(["REMOVE_SECRET"]);
    const expectedPath = targetUrl.endsWith("project") ? "/repos/alice/project/actions/runners/remove-token" : "/orgs/acme/actions/runners/remove-token";
    expect(request.mock.calls[2]![0]).toBe(`https://api.github.com${expectedPath}`);
    expect(JSON.stringify(input.onCode.mock.calls)).not.toContain("SECRET");
  });

  it("一次授权为本批申请独立注册 Token，不向回调暴露账号或设备凭据", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(codeResponse())
      .mockResolvedValueOnce(json({ error: "authorization_pending" }))
      .mockResolvedValueOnce(json({ access_token: "PRIVATE_ACCESS", refresh_token: "PRIVATE_REFRESH" }))
      .mockResolvedValueOnce(json({ token: "REGISTRATION_1" }, 201))
      .mockResolvedValueOnce(json({ token: "REGISTRATION_2" }, 201));
    const settings = { ...options(), count: 2 };
    expect(await authorizeRunners(settings, request)).toEqual(["REGISTRATION_1", "REGISTRATION_2"]);
    expect(settings.onCode).toHaveBeenCalledWith({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: expect.any(Number) });
    expect(JSON.stringify(settings.onCode.mock.calls)).not.toContain("PRIVATE_");
    expect(settings.onAuthorized).toHaveBeenCalledOnce();
    const firstBody = request.mock.calls[0]![1]!.body as URLSearchParams;
    expect([...firstBody.keys()]).toEqual(["client_id"]);
    expect(request.mock.calls[3]![0]).toBe("https://api.github.com/orgs/acme/actions/runners/registration-token");
    expect(request.mock.calls[3]![1]!.headers).toMatchObject({ Authorization: "Bearer PRIVATE_ACCESS" });
    expect(request.mock.calls[3]![1]!.redirect).toBe("error");
  });

  it("遵守 slow_down，后续轮询间隔增加 5 秒", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(codeResponse())
      .mockResolvedValueOnce(json({ error: "slow_down" }))
      .mockResolvedValueOnce(json({ access_token: "PRIVATE_ACCESS" }))
      .mockResolvedValueOnce(json({ token: "REG" }, 201));
    await authorizeRunners(options(), request);
    expect(vi.mocked(delay).mock.calls.map((call) => call[0])).toEqual([5000, 10000]);
  });

  it.each([
    ["access_denied", "拒绝授权"],
    ["expired_token", "已过期"],
    ["incorrect_device_code", "授权失败"],
  ])("可恢复地报告 %s", async (error, message) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(codeResponse()).mockResolvedValueOnce(json({ error }));
    await expect(authorizeRunners(options(), request)).rejects.toThrow(message);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("取消后不交换账号凭据，也不调用注册 API", async () => {
    const controller = new AbortController();
    vi.mocked(delay).mockImplementation(async () => { controller.abort(); throw new Error("aborted"); });
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(codeResponse());
    await expect(authorizeRunners({ ...options(), signal: controller.signal }, request)).rejects.toThrow("授权已取消");
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([403, 404])("权限不足 HTTP %s 给出目标相关指引，不回显响应中的秘密", async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(codeResponse()).mockResolvedValueOnce(json({ access_token: "SECRET" })).mockResolvedValueOnce(json({ message: "SECRET", token: "LEAK" }, status));
    await expect(authorizeRunners({ ...options(), targetUrl: "https://github.com/acme/repo" }, request)).rejects.toThrow("Administration: write");
  });

  it("拒绝伪造验证页面和不合法响应", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ device_code: "secret", user_code: "ABCD-1234", verification_uri: "https://evil.test", expires_in: 900, interval: 5 }));
    await expect(authorizeRunners(options(), request)).rejects.toThrow("响应无效");
  });

  it("未配置应用时不发起网络请求", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(authorizeRunners({ ...options(), clientId: "" }, request)).rejects.toThrow("Client ID");
    expect(request).not.toHaveBeenCalled();
  });

  it("请求失败不会把 GitHub 返回的敏感错误描述传播到界面", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: "incorrect_client_credentials", error_description: "SECRET" }, 400));
    await expect(authorizeRunners(options(), request)).rejects.toThrow("启用 Device Flow");
  });
});

describe("runner 注册目标", () => {
  it("区分组织和仓库，设置链接由目标生成", () => {
    expect(parseRunnerTarget(" https://github.com/acme/ ")).toMatchObject({ kind: "organization", name: "acme", settingsUrl: "https://github.com/organizations/acme/settings/actions/runners/new" });
    expect(parseRunnerTarget("https://github.com/acme/repo")).toMatchObject({ kind: "repository", apiPath: "/repos/acme/repo/actions/runners/registration-token" });
  });
  it.each(["http://github.com/acme", "https://evil.test/acme", "https://github.com/acme/repo/settings", "https://user:password@github.com/acme", "https://github.com/acme?token=x", "https://github.com/"])("拒绝向不受信任目标授权：%s", (target) => {
    expect(() => parseRunnerTarget(target)).toThrow();
  });
});
