/*
 * 原始需求（2026-10-26）：注册新实例时可选择分发包——从 GitHub 官方源（actions/runner releases）
 * 下载最新包、导入本地已有包，或选用此前下载/导入的包。
 *
 * 正交意图：
 * 1. 包清单：下载缓存目录 ∪ 用户导入路径（config.importedPackages），标注平台兼容性。
 * 2. 最新版探测（GitHub API）与带进度的流式下载（tmp→rename 原子落盘）。
 * 3. 纯函数资产名映射（platform.ts）的单测入口不在此处。
 */

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { configDir } from "./config.ts";
import { assetNameFor, packageCompatible } from "./platform.ts";
import type { DownloadState, PackageInfo, ReleaseInfo } from "./types.ts";

export type { DownloadState, PackageInfo, ReleaseInfo };

/** 下载缓存目录（下载的包与导入清单都归工具所有）。 */
export function packagesDir(): string {
  return join(configDir(), "packages");
}

const PKG_RE = /^actions-runner-(osx|win|linux)-(x86|x64|arm64)-\d+\.\d+\.\d+\.(tar\.gz|zip)$/;

function toInfo(path: string, st: { size: number; mtimeMs: number }): PackageInfo {
  const name = path.split(/[\\/]+/).pop() ?? path;
  return { path, name, sizeBytes: st.size, mtimeMs: st.mtimeMs, compatible: packageCompatible(name) };
}

/** 包清单：下载缓存目录里的包 + config 导入的外部路径（去重、新者在前）。 */
export async function listPackages(importedPaths: string[]): Promise<PackageInfo[]> {
  const out = new Map<string, PackageInfo>();
  const dir = packagesDir();
  if (existsSync(dir)) {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      if (!PKG_RE.test(name)) continue;
      try {
        const st = await stat(path);
        if (st.isFile()) out.set(path, toInfo(path, st));
      } catch {
        /* 竞态消失 */
      }
    }
  }
  for (const path of importedPaths) {
    try {
      const st = await stat(path);
      if (st.isFile() && !out.has(path)) out.set(path, toInfo(path, st));
    } catch {
      /* 导入的文件已不存在：跳过，config 清理交给调用方 */
    }
  }
  return [...out.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 查询 actions/runner 最新 release 中匹配当前平台的资产。 */
export async function fetchLatestReleaseInfo(): Promise<ReleaseInfo> {
  const res = await fetch("https://api.github.com/repos/actions/runner/releases/latest", {
    headers: { "User-Agent": "jixoai-gh-runner", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}（查询最新 release 失败）`);
  const body = (await res.json()) as {
    tag_name?: string;
    assets?: { name: string; browser_download_url: string; size: number }[];
  };
  const version = (body.tag_name ?? "").replace(/^v/, "");
  if (!version || !Array.isArray(body.assets)) throw new Error("release 响应缺少 tag_name/assets");
  const assetName = assetNameFor(version);
  const asset = body.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(`最新 release ${body.tag_name} 没有当前平台的资产（期望 ${assetName}）`);
  }
  return { tag: body.tag_name!, version, assetName, url: asset.browser_download_url, sizeBytes: asset.size };
}

/** 流式下载到包缓存目录（tmp→rename 原子替换）；onProgress 以 0-100 汇报。 */
export async function downloadPackage(
  release: ReleaseInfo,
  onProgress: (pct: number, downloadedBytes: number, totalBytes: number) => void,
): Promise<string> {
  await mkdir(packagesDir(), { recursive: true });
  const dest = join(packagesDir(), release.assetName);
  const tmp = `${dest}.part`;
  await rm(tmp, { force: true });

  const res = await fetch(release.url, {
    headers: { "User-Agent": "jixoai-gh-runner" },
    redirect: "follow",
  });
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? release.sizeBytes) || release.sizeBytes;
  let received = 0;
  let lastPct = -1;

  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
    if (pct !== lastPct) {
      lastPct = pct;
      onProgress(pct, received, total);
    }
  });
  await pipeline(source, createWriteStream(tmp));
  if (total > 0 && received !== total) {
    await rm(tmp, { force: true });
    throw new Error(`下载不完整：${received}/${total} 字节`);
  }
  // 原子替换：先移走同名旧包再改名
  await rm(dest, { force: true });
  await rename(tmp, dest);
  return dest;
}
