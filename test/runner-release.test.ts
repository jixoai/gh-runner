import { describe, expect, it, vi } from "vitest";
import { fetchLatestReleaseInfo, fetchReleaseInfo, releaseChecksum } from "../src/runner-release.ts";
import { assetNameFor } from "../src/platform.ts";

const asset = assetNameFor("2.340.0");
const sha = "a1".repeat(32);
const api = (digest?: string, body = "") => Response.json({
  tag_name: "v2.340.0", body,
  assets: [{ name: asset, size: 1234, browser_download_url: `https://github.com/actions/runner/releases/download/v2.340.0/${asset}`, digest }],
});
function page(url = "https://github.com/actions/runner/releases/tag/v2.340.0") {
  const response = new Response(`<h2>SHA-256 Checksums</h2><ul><li>${asset} ${sha}</li></ul>`);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("官方 runner release 探测", () => {
  it("指定版本与 Windows ARM64 资产，不受运行查询的本机平台影响", async () => {
    const name = "actions-runner-win-arm64-2.338.2.zip";
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ tag_name: "v2.338.2", assets: [{ name, size: 321, browser_download_url: `https://github.com/actions/runner/releases/download/v2.338.2/${name}`, digest: `sha256:${sha}` }] }));
    expect(await fetchReleaseInfo({ target: "win-arm64", version: "v2.338.2" }, undefined, request)).toMatchObject({ version: "2.338.2", assetName: name, sha256: sha });
    expect(request.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/actions/runner/releases/tags/v2.338.2");
  });

  it("指定版本 API 限流后仍查询原版本官网，不改成最新版", async () => {
    const name = "actions-runner-linux-arm-2.338.2.tar.gz";
    const response = new Response(`<li>${name} ${sha}</li>`);
    Object.defineProperty(response, "url", { value: "https://github.com/actions/runner/releases/tag/v2.338.2" });
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("limited", { status: 403 })).mockResolvedValueOnce(response);
    expect(await fetchReleaseInfo({ target: "linux-arm", version: "2.338.2" }, undefined, request)).toMatchObject({ version: "2.338.2", assetName: name, sha256: sha });
    expect(request.mock.calls[1]?.[0]).toBe("https://github.com/actions/runner/releases/tag/v2.338.2");
  });

  it("版本不存在时提供可恢复的错误", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(fetchReleaseInfo({ target: "linux-x64", version: "2.999.0" }, undefined, request)).rejects.toThrow("找不到发布版本 2.999.0");
    expect(request).toHaveBeenCalledOnce();
  });

  it("API 没有所选平台的资产时不会下载本机包替代", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ tag_name: "v2.340.0", assets: [] }));
    await expect(fetchReleaseInfo({ target: "win-arm64" }, undefined, request)).rejects.toThrow("没有所选平台的资产");
  });

  it("官网未确认所选资产时不会拼接可能不存在的下载链接", async () => {
    const response = new Response("release without asset checksum");
    Object.defineProperty(response, "url", { value: "https://github.com/actions/runner/releases/tag/v2.340.0" });
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("limited", { status: 403 })).mockResolvedValueOnce(response);
    await expect(fetchReleaseInfo({ target: "linux-arm" }, undefined, request)).rejects.toThrow("无法确认所选平台的资产");
  });

  it("API 与官网均拒绝版本被静默替换", async () => {
    await expect(fetchReleaseInfo({ target: "osx-arm64", version: "2.338.2" }, undefined, vi.fn<typeof fetch>().mockResolvedValueOnce(api()))).rejects.toThrow("与所选版本不一致");
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("limited", { status: 403 })).mockResolvedValueOnce(page());
    await expect(fetchReleaseInfo({ target: "osx-arm64", version: "2.338.2" }, undefined, request)).rejects.toThrow("地址异常");
  });

  it("非法版本在发起网络请求前被拒绝", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(fetchReleaseInfo({ target: "osx-arm64", version: "../latest" }, undefined, request)).rejects.toThrow("版本号格式");
    expect(request).not.toHaveBeenCalled();
  });

  it("API 403 且额度为零时切换官方网页，不需要 Token，不再阻塞下载", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } })).mockResolvedValueOnce(page());
    const release = await fetchLatestReleaseInfo(undefined, request);
    expect(release).toMatchObject({ tag: "v2.340.0", assetName: asset, sha256: sha, sizeBytes: 0, metadataSource: expect.stringContaining("额度已用尽") });
    expect(release.url).toBe(`https://github.com/actions/runner/releases/download/v2.340.0/${asset}`);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/actions/runner/releases/latest", "https://github.com/actions/runner/releases/latest",
    ]);
    expect(request.mock.calls.every(([, init]) => !new Headers(init?.headers).has("Authorization"))).toBe(true);
  });

  it.each([403, 429, 502, 503])("API HTTP %s 时只尝试一次官方网页", async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("error", { status })).mockResolvedValueOnce(page());
    expect((await fetchLatestReleaseInfo(undefined, request)).sha256).toBe(sha);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("API 网络故障可使用同一网络配置访问官方网页", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(page());
    expect((await fetchLatestReleaseInfo(undefined, request)).metadataSource).toContain("暂不可用");
  });

  it("查询被取消后不再请求备用入口", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(); throw controller.signal.reason; });
    await expect(fetchLatestReleaseInfo(controller.signal, request)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });

  it("API 与官网均失败时区分阶段并提供恢复提示", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } })).mockResolvedValueOnce(new Response("blocked", { status: 403 }));
    await expect(fetchLatestReleaseInfo(undefined, request)).rejects.toThrow("额度已用尽；GitHub 官方发布页也无法访问（HTTP 403）");
  });

  it.each(["https://example.com/actions/runner/releases/tag/v2.340.0", "https://github.com/actions/runner/releases/tag/v2.340.0-rc1"])("不信任未知跳转目标 %s", async (url) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("limited", { status: 403 })).mockResolvedValueOnce(page(url));
    await expect(fetchLatestReleaseInfo(undefined, request)).rejects.toThrow("地址异常");
  });

  it("成功 API 优先读取官方 digest，旧版 API 从官方 release 正文提取", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(api(`sha256:${sha}`)).mockResolvedValueOnce(api(undefined, `- ${asset} ${sha}`));
    expect((await fetchLatestReleaseInfo(undefined, request)).sha256).toBe(sha);
    expect((await fetchLatestReleaseInfo(undefined, request)).sha256).toBe(sha);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("仅提取当前平台当前版本的完整 SHA-256", () => {
    expect(releaseChecksum(`<li>${asset}<code>${sha}</code></li>`, asset)).toBe(sha);
    expect(releaseChecksum(`${sha} *${asset}`, asset)).toBe(sha);
    expect(releaseChecksum(`wrong-${asset} ${sha}`, asset)).toBeUndefined();
    expect(releaseChecksum(`${asset} ${sha}0`, asset)).toBeUndefined();
    expect(releaseChecksum(`${asset}.other ${sha}`, asset)).toBeUndefined();
  });
});
