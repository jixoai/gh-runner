/*
 * 原始需求（2026-10-26）：注册新实例时可选择分发包——从 GitHub 官方源（actions/runner releases）
 * 下载最新包、导入本地已有包，或选用此前下载/导入的包。
 *
 * 正交意图：
 * 1. 包清单：下载缓存目录 ∪ 用户导入路径（config.importedPackages），标注平台兼容性。
 * 2. 最新版探测（GitHub API）与带进度的流式下载（tmp→rename 原子落盘）。
 * 3. 纯函数资产名映射（platform.ts）的单测入口不在此处。
 */

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { configDir } from "./config.ts";
import { packageCompatible } from "./platform.ts";
import { createPackageTransport, type PackageTransport } from "./package-network.ts";
import { fetchLatestReleaseInfo } from "./runner-release.ts";
import type { DownloadState, PackageInfo, ReleaseInfo } from "./types.ts";

export type { DownloadState, PackageInfo, ReleaseInfo };
export { fetchLatestReleaseInfo } from "./runner-release.ts";

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

async function packageChecksum(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  signal?.throwIfAborted();
  return hash.digest("hex");
}

/** 流式下载到包缓存目录（tmp→rename 原子替换）；onProgress 以 0-100 汇报。 */
export interface DownloadCheckpoint {
  validator?: string;
}

export async function downloadPackage(
  release: ReleaseInfo,
  onProgress: (pct: number, downloadedBytes: number, totalBytes: number) => void,
  signal?: AbortSignal,
  checkpoint?: DownloadCheckpoint,
  request = fetch,
): Promise<string> {
  signal?.throwIfAborted();
  await mkdir(packagesDir(), { recursive: true });
  const dest = join(packagesDir(), release.assetName);
  const tmp = `${dest}.part`;
  if (release.sha256) {
    const cached = await stat(dest).catch(() => null);
    if (cached?.isFile() && (!release.sizeBytes || cached.size === release.sizeBytes) && await packageChecksum(dest, signal) === release.sha256) {
      onProgress(100, cached.size, cached.size);
      return dest;
    }
  }
  const partialSize = checkpoint?.validator ? (await stat(tmp).catch(() => null))?.size ?? 0 : 0;
  const offset = release.sizeBytes > 0 && partialSize >= release.sizeBytes ? 0 : partialSize;
  const stalled = new AbortController();
  let timer: NodeJS.Timeout;
  const resetTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stalled.abort(new Error("下载连接超时（30 秒未收到数据），请检查代理后重试")), 30_000);
    timer.unref?.();
  };
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), stalled.signal]);
  resetTimeout();
  try {
    const headers: Record<string, string> = { "User-Agent": "jixoai-gh-runner", "Accept-Encoding": "identity" };
    if (offset > 0) {
      headers.Range = `bytes=${offset}-`;
      headers["If-Range"] = checkpoint!.validator!;
    }
    const res = await request(release.url, { headers, redirect: "follow", signal: requestSignal });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new Error(res.status === 403
        ? "包下载服务器返回 HTTP 403（不是版本查询 API 限流）；请更换代理节点、使用可信加速源或导入已有包"
        : `下载失败：HTTP ${res.status}`);
    }
    let received = 0;
    let total = release.sizeBytes || Number(res.headers.get("content-length")) || 0;
    if (res.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
      if (!offset || !range || Number(range[1]) !== offset || Number(range[2]) + 1 !== Number(range[3]) || (release.sizeBytes > 0 && Number(range[3]) !== release.sizeBytes)) {
        await res.body.cancel();
        throw new Error("下载续传响应无效，请重新下载");
      }
      received = offset;
      total = Number(range[3]);
    }
    if (checkpoint) {
      const etag = res.headers.get("etag");
      checkpoint.validator = etag && !etag.startsWith("W/") ? etag : res.headers.get("last-modified") ?? undefined;
    }
    let lastPct = -1;
    const progress = () => {
      const pct = total > 0 ? Math.min(99, Math.floor(received / total * 100)) : 0;
      if (pct !== lastPct) {
        lastPct = pct;
        onProgress(pct, received, total);
      }
    };
    progress();
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on("data", (chunk: Buffer) => {
      received += chunk.length;
      resetTimeout();
      progress();
    });
    await pipeline(source, createWriteStream(tmp, { flags: received > 0 ? "a" : "w" }), { signal: requestSignal });
    requestSignal.throwIfAborted();
    clearTimeout(timer!);
    if (total > 0 && received !== total) throw new Error(`下载不完整：${received}/${total} 字节`);
    if (release.sha256 && await packageChecksum(tmp, signal) !== release.sha256) throw new Error("分发包 SHA-256 与 GitHub 官方校验值不一致，已拒绝使用；请更换下载源后重试");
    signal?.throwIfAborted();
    await rename(tmp, dest);
    onProgress(100, received, total);
    return dest;
  } catch (error) {
    if (!checkpoint || !signal?.aborted) await rm(tmp, { force: true });
    if (stalled.signal.aborted) throw stalled.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer!);
  }
}

export class PackageDownload {
  #state: DownloadState = { status: "running", pct: 0, message: "查询最新 release…" };
  #controller: AbortController | null = null;
  #paused = false;
  #cancelled = false;
  #settled = false;
  #wake: (() => void) | null = null;
  #network: string | undefined;

  constructor(private readonly onState: (state: DownloadState) => void) {}

  #publish(status: DownloadState["status"], message: string, pct = this.#state.pct): void {
    this.#state = { status, message, pct, network: this.#network };
    this.onState(this.#state);
  }

  pause(): void {
    if (this.#settled || this.#cancelled || this.#paused) return;
    this.#paused = true;
    this.#controller?.abort();
    this.#publish("paused", "已暂停；继续时优先断点续传，服务器不支持时重新下载");
  }

  resume(): void {
    if (this.#settled || this.#cancelled || !this.#paused) return;
    this.#paused = false;
    this.#publish("running", "正在继续下载…");
    this.#wake?.();
  }

  cancel(): void {
    if (this.#settled || this.#cancelled) return;
    this.#cancelled = true;
    this.#controller?.abort();
    this.#publish("cancelling", "正在取消并清理未完成的下载…");
    this.#wake?.();
  }

  async run(): Promise<string | null> {
    let release: ReleaseInfo | undefined;
    let transport: PackageTransport | undefined;
    const checkpoint: DownloadCheckpoint = {};
    this.onState(this.#state);
    try {
      while (!this.#cancelled) {
        if (this.#paused) await new Promise<void>((resolve) => { this.#wake = resolve; });
        this.#wake = null;
        if (this.#cancelled) break;
        const controller = new AbortController();
        this.#controller = controller;
        try {
          if (!transport) {
            transport = await createPackageTransport(controller.signal);
            this.#network = transport.description;
          }
          this.#publish("running", release ? "正在继续下载…" : "查询最新 release…");
          release ??= await fetchLatestReleaseInfo(controller.signal, transport.fetch);
          controller.signal.throwIfAborted();
          const description = `${release.metadataSource ? `${release.metadataSource}；` : ""}下载并校验 ${release.assetName}`;
          this.#publish("running", description);
          const dest = await downloadPackage(release, (pct) => {
            if (!this.#paused && !this.#cancelled) this.#publish("running", description, pct);
          }, controller.signal, checkpoint, transport.fetch);
          this.#settled = true;
          this.#publish("ok", `已下载 ${dest}`, 100);
          return dest;
        } catch (error) {
          if (controller.signal.aborted) continue;
          throw error;
        }
      }
      return null;
    } catch (error) {
      this.#publish("error", error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      this.#settled = true;
      this.#controller = null;
      try { await transport?.close(); }
      catch { this.#publish("error", "下载连接清理失败，请退出应用后重试"); }
      if (release) {
        try { await rm(join(packagesDir(), `${release.assetName}.part`), { force: true }); }
        catch { this.#publish("error", "无法清理未完成的下载文件，请检查缓存目录权限"); }
      }
      if (this.#cancelled && this.#state.status !== "error" && this.#state.status !== "ok") this.#publish("cancelled", "已取消，未完成的下载已清理");
    }
  }
}
