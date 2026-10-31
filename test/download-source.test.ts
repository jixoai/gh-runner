import { describe, expect, it, vi } from "vitest";
import { checkedMirrorRequest, downloadTemplateError, packageDownloadUrl } from "../src/download-source.ts";
import type { ReleaseInfo } from "../src/types.ts";

const release: ReleaseInfo = {
  version: "2.340.0", tag: "v2.340.0", assetName: "actions-runner-osx-arm64-2.340.0.tar.gz", sizeBytes: 123,
  url: "https://github.com/actions/runner/releases/download/v2.340.0/actions-runner-osx-arm64-2.340.0.tar.gz",
};

describe("可信加速源模板", () => {
  it("默认仍为官方地址；支持下载代理和对象存储路径，不改变版本或平台", () => {
    expect(packageDownloadUrl(release)).toBe(release.url);
    expect(packageDownloadUrl(release, " https://mirror.test/{url} ")).toBe(`https://mirror.test/${release.url}`);
    expect(packageDownloadUrl(release, "https://cdn.test/runner/v{version}/{asset}")).toBe(`https://cdn.test/runner/v2.340.0/${release.assetName}`);
  });

  it.each([
    "https://mirror.test/", "https://mirror.test/{unknown}/{asset}", "http://mirror.test/{url}",
    "https://secret:password@mirror.test/{url}", "https://mirror.test/{asset}?token=password", "https://mirror.test/{url}#fragment",
  ])("拒绝无效模板 %s，不输出敏感地址", (template) => {
    const error = downloadTemplateError(template);
    expect(error).toBeTypeOf("string");
    expect(error).not.toContain("password");
    expect(() => packageDownloadUrl(release, template)).toThrow();
  });

  it("下载源的重定向保留 Range 和取消信号，但不携带额外账号凭据", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://cdn.test/archive?sig=asset-signature" } })).mockResolvedValueOnce(new Response("package"));
    const controller = new AbortController();
    const response = await checkedMirrorRequest(request)("https://mirror.test/archive", { signal: controller.signal, headers: { Range: "bytes=123-" } });
    expect(await response.text()).toBe("package");
    expect(request.mock.calls[1]![0]).toBe("https://cdn.test/archive?sig=asset-signature");
    for (const [, init] of request.mock.calls) {
      expect(init?.signal).toBe(controller.signal);
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("range")).toBe("bytes=123-");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
    }
  });

  it.each(["http://cdn.test/archive", "https://secret:password@cdn.test/archive"])("阻止不安全跳转 %s，绝不请求目标", async (location) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    await expect(checkedMirrorRequest(request)("https://mirror.test/archive")).rejects.toThrow("不安全");
    expect(request).toHaveBeenCalledOnce();
  });

  it("重定向循环有限制，不会无限消耗带宽", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302, headers: { location: "/archive" } }));
    await expect(checkedMirrorRequest(request)("https://mirror.test/archive")).rejects.toThrow("次数过多");
    expect(request).toHaveBeenCalledTimes(9);
  });
});
