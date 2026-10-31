import { assetNameFor } from "./platform.ts";
import type { ReleaseInfo } from "./types.ts";

const RELEASE_API = "https://api.github.com/repos/actions/runner/releases/latest";
const RELEASE_PAGE = "https://github.com/actions/runner/releases/latest";
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

async function releaseFromPage(signal: AbortSignal | undefined, request: typeof fetch, reason: string): Promise<ReleaseInfo> {
  const response = await request(RELEASE_PAGE, { headers: HEADERS, redirect: "follow", signal: requestSignal(signal) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${reason}；GitHub 官方发布页也无法访问（HTTP ${response.status}），请更换代理节点或导入已有包`);
  }
  const url = new URL(response.url);
  const tag = /^\/actions\/runner\/releases\/tag\/(v\d+\.\d+\.\d+)$/.exec(url.pathname)?.[1];
  if (url.origin !== "https://github.com" || !tag) {
    await response.body?.cancel();
    throw new Error("GitHub 官方发布页地址异常，无法确认 runner 版本；请导入已有包");
  }
  const version = tag.slice(1);
  const assetName = assetNameFor(version);
  const html = await response.text();
  return {
    tag, version, assetName, sizeBytes: 0,
    url: `https://github.com/actions/runner/releases/download/${tag}/${assetName}`,
    sha256: releaseChecksum(html, assetName),
    metadataSource: `${reason}，已切换 GitHub 官方发布页`,
  };
}

export async function fetchLatestReleaseInfo(signal?: AbortSignal, request = fetch): Promise<ReleaseInfo> {
  let response: Response;
  try {
    response = await request(RELEASE_API, {
      headers: { ...HEADERS, Accept: "application/vnd.github+json" }, signal: requestSignal(signal),
    });
  } catch {
    signal?.throwIfAborted();
    return releaseFromPage(signal, request, "GitHub API 暂不可用");
  }
  if (!response.ok) {
    const status = response.status;
    const limited = status === 429 || response.headers.get("x-ratelimit-remaining") === "0";
    await response.body?.cancel();
    if (status === 403 || status === 429 || status >= 500) {
      return releaseFromPage(signal, request, limited ? "GitHub API 额度已用尽" : `GitHub API HTTP ${status}`);
    }
    throw new Error(`GitHub API ${status}（查询最新 release 失败）`);
  }
  const body = await response.json() as {
    tag_name?: string;
    body?: string;
    assets?: { name: string; browser_download_url: string; size: number; digest?: string | null }[];
  };
  const version = (body.tag_name ?? "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version) || !Array.isArray(body.assets)) throw new Error("release 响应缺少有效 tag_name/assets");
  const assetName = assetNameFor(version);
  const asset = body.assets.find((entry) => entry.name === assetName);
  if (!asset) throw new Error(`最新 release ${body.tag_name} 没有当前平台的资产（期望 ${assetName}）`);
  return {
    tag: body.tag_name!, version, assetName, url: asset.browser_download_url, sizeBytes: asset.size,
    sha256: /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? "")?.[1]?.toLowerCase() ?? releaseChecksum(body.body ?? "", assetName),
  };
}
