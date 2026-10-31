import type { ReleaseInfo } from "./types.ts";

export function packageDownloadUrl(release: ReleaseInfo, template = ""): string {
  const source = template.trim();
  if (!source) return release.url;
  if (source.length > 2048 || !/\{(?:url|asset)\}/.test(source) || /[{}]/.test(source.replace(/\{(?:url|version|asset)\}/g, ""))) {
    throw new Error("加速地址模板必须包含 {url} 或 {asset}；支持 {url}、{version}、{asset}");
  }
  const expanded = source.replace(/\{(url|version|asset)\}/g, (_match, field: string) => ({ url: release.url, version: release.version, asset: release.assetName })[field]!);
  try {
    const url = new URL(expanded);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href;
  } catch {
    throw new Error("加速源必须使用 HTTPS，且不能包含用户名、密码、查询参数或片段");
  }
}

export function downloadTemplateError(template: string): string | null {
  try {
    packageDownloadUrl({ tag: "v1.2.3", version: "1.2.3", assetName: "actions-runner-osx-arm64-1.2.3.tar.gz", url: "https://github.com/actions/runner/releases/download/v1.2.3/actions-runner-osx-arm64-1.2.3.tar.gz", sizeBytes: 0 }, template);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "加速地址模板无效";
  }
}

export function checkedMirrorRequest(request: typeof fetch): typeof fetch {
  return async (input, init) => {
    let url = new URL(String(input));
    for (let redirects = 0; redirects <= 8; redirects++) {
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("加速源跳转到不安全的地址，已停止下载");
      const response = await request(url.href, { ...init, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("加速源返回的重定向缺少目标地址");
      url = new URL(location, url);
    }
    throw new Error("加速源重定向次数过多，请更换下载源");
  };
}
