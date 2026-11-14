import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/supervisor.ts", () => ({ pidExists: vi.fn(() => "alive") }));

import { pidExists } from "../src/supervisor.ts";
import { acquireRunnerStartLock } from "../src/runner-start-lock.ts";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "runner-lock-test-"));
  vi.mocked(pidExists).mockReturnValue("alive");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("跨进程 Runner 启动锁", () => {
  it("并发请求只有一个持有者，释放后可以再次启动", async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => acquireRunnerStartLock(directory)));
    const holders = results.filter((result) => result.status === "fulfilled");
    expect(holders).toHaveLength(1);
    await holders[0]!.value();
    expect(await readdir(directory)).toEqual([]);
    const release = await acquireRunnerStartLock(directory);
    await release();
    expect(await readdir(directory)).toEqual([]);
  });

  it("并发清理死亡持有者不会删掉新持有者的锁", async () => {
    const path = join(directory, ".gh-runner-start.lock");
    await mkdir(path);
    await writeFile(join(path, `999999-${randomUUID()}`), "");
    vi.mocked(pidExists).mockImplementation((pid) => pid === 999999 ? "dead" : "alive");
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => acquireRunnerStartLock(directory)));
    const holders = results.filter((result) => result.status === "fulfilled");
    expect(holders).toHaveLength(1);
    expect(await readdir(path)).toHaveLength(1);
    await holders[0]!.value();
    expect(await readdir(directory)).toEqual([]);
  });

  it("旧持有者重复释放不会删除新持有者的锁", async () => {
    const firstRelease = await acquireRunnerStartLock(directory);
    await firstRelease();
    const secondRelease = await acquireRunnerStartLock(directory);
    await firstRelease();
    await expect(acquireRunnerStartLock(directory)).rejects.toThrow("另一个 GH Runner");
    await secondRelease();
    expect(await readdir(directory)).toEqual([]);
  });

  it("损坏的锁和无权限确认存活的持有者安全阻止启动", async () => {
    const path = join(directory, ".gh-runner-start.lock");
    await mkdir(path);
    await writeFile(join(path, "invalid"), "");
    await expect(acquireRunnerStartLock(directory)).rejects.toThrow("启动锁无法确认");
    await rm(path, { recursive: true });
    const release = await acquireRunnerStartLock(directory);
    vi.mocked(pidExists).mockReturnValue("no-perm");
    await expect(acquireRunnerStartLock(directory)).rejects.toThrow("另一个 GH Runner");
    await release();
  });
});
