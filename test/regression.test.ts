/*
 * 复核回归测试（对抗式审查 P0-2/P0-3）：
 * 1. run.sh 无执行位 → spawn 失败只发 error+close 不发 exit，Fleet 必须存活并落 lastError；
 * 2. config.json 形状损坏（合法 JSON 但实例项缺 dir）→ boot 不得抛错。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, copyFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
let parent: string;
let instanceDir: string;
let fleetModule: typeof import("../src/fleet.ts");
let fleet: import("../src/fleet.ts").Fleet | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rf-reg-home-"));
  parent = await mkdtemp(join(tmpdir(), "rf-reg-parent-"));
  instanceDir = join(parent, "actions-runner-reg");
  await mkdir(join(instanceDir, "_diag"), { recursive: true });
  const fixture = join(import.meta.dirname, "fixtures", "mock-runner");
  await copyFile(join(fixture, "run.sh"), join(instanceDir, "run.sh"));
  await writeFile(join(instanceDir, ".runner"), JSON.stringify({ agentId: 998, agentName: "reg-ext-98" }));
  await mkdir(join(home, "Library", "Application Support", "runner-fleet"), { recursive: true });
  process.env.HOME = home;
  fleetModule = await import("../src/fleet.ts");
});

afterEach(async () => {
  await fleet?.destroy();
  fleet = null;
  delete process.env.HOME;
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(parent, { recursive: true, force: true }).catch(() => {});
});

describe("回归：spawn 失败与配置损坏", () => {
  it("run.sh 无执行位：进程不崩、实例回落 stopped 并带 lastError", async () => {
    await chmod(join(instanceDir, "run.sh"), 0o644);
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(
      join(home, "Library", "Application Support", "runner-fleet", "config.json"),
      JSON.stringify({ searchDirs: [parent], instances: [] }),
    );
    fleet = new fleetModule.Fleet();
    const bootPromise = fleet.boot();
    await expect(bootPromise).resolves.toBeUndefined(); // 不抛错
    // 启动一个坏实例：不崩溃、最终 stopped + lastError
    await fleet.start("actions-runner-reg");
    const deadline = Date.now() + 10_000;
    let lastError: string | null = null;
    while (Date.now() < deadline) {
      const v = fleet.view("actions-runner-reg");
      if (v?.processState === "stopped" && v.lastError) {
        lastError = v.lastError;
        break;
      }
      await sleep(150);
    }
    expect(lastError).toBeTruthy();
  }, 30_000);

  it("config.json 形状损坏：boot 容错并继续发现实例", async () => {
    await writeFile(
      join(home, "Library", "Application Support", "runner-fleet", "config.json"),
      JSON.stringify({ searchDirs: [parent], instances: [{ autoStart: true }, { id: "x", dir: "not-absolute", autoStart: false }] }),
    );
    fleet = new fleetModule.Fleet();
    await expect(fleet.boot()).resolves.toBeUndefined();
    expect(fleet.view("actions-runner-reg")?.configured).toBe(true);
  }, 30_000);
});
