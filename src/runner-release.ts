import { ARCH, PLATFORM } from "./platform.ts";
import { recommendedRunnerTarget, resolvePackageSelection, runnerPackageName, type RunnerPackageSelection } from "./runner-package.ts";
import type { ReleaseInfo } from "./types.ts";

const RELEASE_API = "https://api.github.com/repos/actions/runner/releases";
const RELEASE_PAGE = "https://github.com/actions/runner/releases";
const HEADERS = { "User-Agent": "jixoai-gh-runner" };

export function releaseChecksum(text: string, assetName: string): string | undefined {
  const plain = text.replace(/<[^>]*>/g, " ").replace(/&(?:nbsp|amp);/g, " ");
  const asset = assetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const after = new RegExp(`(?:^|\\s)${asset}\\s+([a-f0-9]{64})(?=\\s|$)`, "im").exec(plain);
  const before = new RegExp(`(?:^|\\s)([a-f0-9]{64})\\s+\\*?${asset}(?=\\s|$)`, "im").exec(plain);
  return (after?.[1] ?? before?.[1])?.toLowerCase();
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
}

async function releaseFromPage(selection: ReturnType<typeof resolvePackageSelection>, signal: AbortSignal | undefined, request: typeof fetch, reason: string): Promise<ReleaseInfo> {
  const response = await request(`${RELEASE_PAGE}/${selection.version === "latest" ? "latest" : `tag/v${selection.version}`}`, { headers: HEADERS, redirect: "follow", signal: requestSignal(signal) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${reason}；GitHub 官方发布页也无法访问（HTTP ${response.status}），请更换代理节点或导入已有包`);
  }
  const url = new URL(response.url);
  const tag = /^\/actions\/runner\/releases\/tag\/(v\d+\.\d+\.\d+)$/.exec(url.pathname)?.[1];
  if (url.origin !== "https://github.com" || !tag || (selection.version !== "latest" && tag !== `v${selection.version}`)) {
    await response.body?.cancel();
    throw new Error("GitHub 官方发布页地址异常，无法确认 runner 版本；请导入已有包");
  }
  const version = tag.slice(1);
  const assetName = runnerPackageName(selection.target, version);
  const html = await response.text();
  const sha256 = releaseChecksum(html, assetName);
  if (!sha256) throw new Error(`发布版本 ${tag} 无法确认所选平台的资产（${assetName}）；请选择其他平台或版本，或导入已有包`);
  return {
    tag, version, assetName, sizeBytes: 0,
    url: `https://github.com/actions/runner/releases/download/${tag}/${assetName}`,
    sha256,
    metadataSource: `${reason}，已切换 GitHub 官方发布页`,
  };
}

export async function fetchLatestReleaseInfo(signal?: AbortSignal, request = fetch): Promise<ReleaseInfo> {
  return fetchReleaseInfo({}, signal, request);
}

export async function fetchReleaseInfo(input: RunnerPackageSelection = {}, signal?: AbortSignal, request = fetch): Promise<ReleaseInfo> {
  const selection = resolvePackageSelection(input, recommendedRunnerTarget(PLATFORM, ARCH));
  let response: Response;
  try {
    response = await request(`${RELEASE_API}/${selection.version === "latest" ? "latest" : `tags/v${selection.version}`}`, {
      headers: { ...HEADERS, Accept: "application/vnd.github+json" }, signal: requestSignal(signal),
    });
  } catch {
    signal?.throwIfAborted();
    return releaseFromPage(selection, signal, request, "GitHub API 暂不可用");
  }
  if (!response.ok) {
    const status = response.status;
    const limited = status === 429 || response.headers.get("x-ratelimit-remaining") === "0";
    await response.body?.cancel();
    if (status === 403 || status === 429 || status >= 500) {
      return releaseFromPage(selection, signal, request, limited ? "GitHub API 额度已用尽" : `GitHub API HTTP ${status}`);
    }
    throw new Error(status === 404 ? `找不到发布版本 ${selection.version}，请检查版本号或选择最新版` : `GitHub API ${status}（查询 release 失败）`);
  }
  const body = await response.json() as {
    tag_name?: string;
    body?: string;
    assets?: { name: string; browser_download_url: string; size: number; digest?: string | null }[];
  };
  const version = (body.tag_name ?? "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version) || !Array.isArray(body.assets)) throw new Error("release 响应缺少有效 tag_name/assets");
  if (selection.version !== "latest" && selection.version !== version) throw new Error("release 响应与所选版本不一致，已停止下载");
  const assetName = runnerPackageName(selection.target, version);
  const asset = body.assets.find((entry) => entry.name === assetName);
  if (!asset) throw new Error(`发布版本 ${body.tag_name} 没有所选平台的资产（期望 ${assetName}）；请选择其他平台或版本`);
  return {
    tag: body.tag_name!, version, assetName, url: asset.browser_download_url, sizeBytes: asset.size,
    sha256: /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? "")?.[1]?.toLowerCase() ?? releaseChecksum(body.body ?? "", assetName),
  };
}
