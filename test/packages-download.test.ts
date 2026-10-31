import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PackageDownload, downloadPackage, packagesDir } from "../src/packages.ts";
import { Fleet } from "../src/fleet.ts";
import { assetNameFor } from "../src/platform.ts";
import type { DownloadState, ReleaseInfo } from "../src/types.ts";

const isolated = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/config.ts", async (original) => ({
  ...await original<typeof import("../src/config.ts")>(), configDir: () => isolated.root,
}));

let server: Server;
let release: ReleaseInfo;
let states: DownloadState[];
let jobs: PackageDownload[];
let pending: Promise<unknown>[];
let ranges: (string | undefined)[];
let ignoreRange: boolean;
let invalidRange: boolean;
let hangMetadata: boolean;
let hangHeaders: boolean;
let truncate: boolean;
const content = Buffer.alloc(256 * 1024, "runner archive");
const sessions = new Set<ServerResponse>();

beforeEach(async () => {
  isolated.root = await mkdtemp(join(tmpdir(), "runner-download-"));
  states = []; jobs = []; pending = []; ranges = [];
  ignoreRange = false; invalidRange = false; hangMetadata = false; hangHeaders = false; truncate = false;
  server = createServer((request, response) => {
    sessions.add(response);
    response.on("close", () => sessions.delete(response));
    if (hangHeaders) return;
    ranges.push(request.headers.range);
    const offset = !ignoreRange && request.headers.range ? Number(request.headers.range.match(/\d+/)![0]) : 0;
    response.writeHead(offset ? 206 : 200, {
      "Content-Length": content.length - offset,
      ETag: '"archive-v1"',
      ...(offset ? { "Content-Range": `bytes ${invalidRange ? 0 : offset}-${content.length - 1}/${content.length}` } : {}),
    });
    let position = offset;
    const timer = setInterval(() => {
      response.write(content.subarray(position, position + 4096));
      position += 4096;
      if (truncate) response.destroy();
      else if (position >= content.length) response.end();
    }, 4);
    response.on("close", () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  release = { version: "2.340.0", tag: "v2.340.0", assetName: assetNameFor("2.340.0"), url: `http://127.0.0.1:${address.port}/runner`, sizeBytes: content.length };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).includes("api.github.com")) {
      if (hangMetadata) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init!.signal!;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return Response.json({ tag_name: release.tag, assets: [{ name: release.assetName, browser_download_url: release.url, size: content.length }] });
    }
    return realFetch(input, init);
  });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const job of jobs) job.cancel();
  await Promise.allSettled(pending);
  for (const response of sessions) response.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
  await rm(isolated.root, { recursive: true, force: true });
});

function start() {
  const job = new PackageDownload((state) => states.push(state));
  jobs.push(job);
  const done = job.run();
  pending.push(done);
  return { job, done };
}

async function progressed() {
  await vi.waitFor(() => expect(states.some((state) => state.pct >= 10)).toBe(true));
}

describe("runner 分发包下载控制", () => {
  it("暂停断开连接并停止写入；Range 续传后内容完整，只在成功时出现正式包", async () => {
    const { job, done } = start();
    await progressed();
    job.pause();
    await vi.waitFor(() => expect(sessions.size).toBe(0));
    await delay(20);
    const partial = join(packagesDir(), `${release.assetName}.part`);
    const size = (await stat(partial)).size;
    await delay(35);
    expect((await stat(partial)).size).toBe(size);
    expect(await readdir(packagesDir())).toEqual([`${release.assetName}.part`]);
    expect(states.at(-1)?.status).toBe("paused");
    job.resume();
    const dest = await done;
    expect(ranges[1]).toBe(`bytes=${size}-`);
    expect(await readFile(dest!)).toEqual(content);
    expect(await readdir(packagesDir())).toEqual([release.assetName]);
    expect(states.at(-1)).toMatchObject({ status: "ok", pct: 100 });
  });

  it("服务器忽略 Range 时从头写入，不追加损坏文件", async () => {
    const { job, done } = start();
    await progressed();
    job.pause();
    await vi.waitFor(() => expect(sessions.size).toBe(0));
    ignoreRange = true;
    job.resume();
    expect(await readFile((await done)!)).toEqual(content);
    expect(ranges[1]).toMatch(/^bytes=\d+-$/);
  });

  it("无效续传响应报错并清理部分文件", async () => {
    const { job, done } = start();
    await progressed(); job.pause();
    await vi.waitFor(() => expect(sessions.size).toBe(0));
    invalidRange = true; job.resume();
    expect(await done).toBeNull();
    expect(states.at(-1)).toMatchObject({ status: "error", message: expect.stringContaining("续传响应无效") });
    expect(await readdir(packagesDir())).toEqual([]);
  });

  it.each([false, true])("取消活动/暂停下载（paused=%s），清理部分文件并可重新开始", async (paused) => {
    const { job, done } = start();
    await progressed();
    if (paused) job.pause();
    job.cancel();
    expect(await done).toBeNull();
    expect(states.at(-1)?.status).toBe("cancelled");
    expect(await readdir(packagesDir())).toEqual([]);
    expect(await start().done).not.toBeNull();
  });

  it.each(["metadata", "headers"])("等待 %s 也能取消", async (stage) => {
    hangMetadata = stage === "metadata"; hangHeaders = stage === "headers";
    const { job, done } = start();
    if (hangHeaders) await vi.waitFor(() => expect(sessions.size).toBe(1));
    job.cancel();
    expect(await done).toBeNull();
    expect(states.at(-1)?.status).toBe("cancelled");
  });

  it("快速暂停/继续不会误判为失败，也不会留下第二个下载", async () => {
    const { job, done } = start();
    await progressed();
    job.pause(); job.resume(); job.pause(); job.resume();
    expect(await readFile((await done)!)).toEqual(content);
    expect(states.some((state) => state.status === "error")).toBe(false);
  });

  it("下载截断时不覆盖已有包并清理临时文件", async () => {
    await mkdir(packagesDir(), { recursive: true });
    const dest = join(packagesDir(), release.assetName);
    await writeFile(dest, "previous valid archive");
    truncate = true;
    await expect(downloadPackage(release, () => {})).rejects.toThrow();
    expect(await readFile(dest, "utf8")).toBe("previous valid archive");
    expect(await readdir(packagesDir())).toEqual([release.assetName]);
  });

  it("等待下载响应超过 30 秒会超时，释放任务并允许重试", async () => {
    const metadataFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).includes("api.github.com")) return metadataFetch(input, init);
      return new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    vi.useFakeTimers();
    const { done } = start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await done).toBeNull();
    expect(states.at(-1)).toMatchObject({ status: "error", message: expect.stringContaining("超时") });
  });

  it("Fleet 防止重复下载、保留暂停状态、退出时取消，取消后可重试", async () => {
    const fleet = new Fleet();
    const done = fleet.downloadLatest();
    expect(fleet.downloadLatest()).toBe(done);
    await vi.waitFor(() => expect(fleet.snapshot().download?.pct).toBeGreaterThan(5));
    fleet.pauseDownload();
    expect(fleet.snapshot().download?.status).toBe("paused");
    await fleet.destroy();
    await done;
    expect(fleet.snapshot().download?.status).toBe("cancelled");
    expect(await readdir(packagesDir())).toEqual([]);
    const retry = fleet.downloadLatest();
    fleet.cancelDownload();
    await retry;
    await fleet.destroy();
  });
});
