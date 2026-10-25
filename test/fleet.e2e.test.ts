/*
 * Fleet 全链路 E2E（无头）：真实 spawn/kill + 真实日志形态 + 真实发现/对账逻辑，
 * 以 mock-runner fixture 模拟 Runner.Listener（stdout + _diag 双写，TERM 优雅退出）。
 * HOME 指向临时目录，隔离真实用户配置。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

let home: string;
let parent: string;
let instanceDir: string;
let fleetModule: typeof import("../src/fleet.ts");
let cfgDir: string;
let fleet: import("../src/fleet.ts").Fleet | null = null;
const fakeExternals: ChildProcess[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  fn: () => T | null | undefined,
  label: string,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T | null | undefined;
  while (Date.now() < deadline) {
    last = fn();
    if (last !== null && last !== undefined) return last;
    await sleep(150);
  }
  throw new Error(`waitFor 超时: ${label}`);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rf-home-"));
  parent = await mkdtemp(join(tmpdir(), "rf-parent-"));
  instanceDir = join(parent, "actions-runner-e2e");
  await mkdir(join(instanceDir, "_diag"), { recursive: true });
  const fixture = join(import.meta.dirname, "fixtures", "mock-runner");
  await copyFile(join(fixture, "run.sh"), join(instanceDir, "run.sh"));
  await chmod(join(instanceDir, "run.sh"), 0o755);
  await writeFile(join(instanceDir, ".runner"), JSON.stringify({
    agentId: 999,
    agentName: "mock-ext-99",
    gitHubUrl: "https://github.com/jixoai",
    workFolder: join(home, "mock-work"),
  }));
  // 预置一段历史日志：验证 attach 时从日志尾部恢复"最近动作"状态
  await writeFile(
    join(instanceDir, "_diag", "Runner_20261024-080000-utc.log"),
    [
      "[2026-10-24 08:00:00Z INFO Terminal] WRITE LINE: 2026-10-24 08:00:00Z: Running job: seed-job",
      "[2026-10-24 08:01:00Z INFO Terminal] WRITE LINE: 2026-10-24 08:01:00Z: Job seed-job completed with result: Succeeded",
      "[2026-10-24 08:01:05Z INFO Terminal] WRITE LINE: 2026-10-24 08:01:05Z: Listening for Jobs",
    ].join("\n") + "\n",
  );
  process.env.HOME = home;
  fleetModule = await import("../src/fleet.ts");
  // configDir() 依赖 HOME，须在环境替换后求值
  const { configDir } = await import("../src/config.ts");
  cfgDir = configDir();
  // 预写工具配置（HOME 已隔离）：searchDirs 指向 fixture 父目录
  await mkdir(cfgDir, { recursive: true });
  await writeFile(
    join(cfgDir, "config.json"),
    JSON.stringify({ searchDirs: [parent], instances: [], importedPackages: [] }),
  );
});

afterEach(async () => {
  await fleet?.destroy();
  fleet = null;
  for (const p of fakeExternals) p.kill("SIGKILL");
  fakeExternals.length = 0;
  delete process.env.HOME;
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(parent, { recursive: true, force: true }).catch(() => {});
});

describe("Fleet E2E", () => {
  it("发现实例并从历史日志恢复最近动作状态", async () => {
    fleet = new fleetModule.Fleet();
    await fleet.boot();
    const view = await waitFor(() => fleet!.view("actions-runner-e2e"), "实例被发现");
    expect(view.configured).toBe(true);
    expect(view.name).toBe("mock-ext-99");
    expect(view.lastResult).toMatchObject({ job: "seed-job", outcome: "Succeeded" });
    expect(view.currentJob).toBeNull();
  });

  it("启动 → 作业解析 → 最近结果 → 停止 全链路", async () => {
    fleet = new fleetModule.Fleet();
    await fleet.boot();
    await waitFor(() => fleet!.view("actions-runner-e2e")?.configured, "实例被发现");

    await fleet.start("actions-runner-e2e");
    await waitFor(
      () => (fleet!.view("actions-runner-e2e")?.processState === "running" ? true : null),
      "进入 running",
      15_000,
    );
    const currentJob = await waitFor(
      () => fleet!.view("actions-runner-e2e")?.currentJob,
      "识别 Running job",
      15_000,
    );
    expect(currentJob.job).toBe("e2e-job");

    const lastResult = await waitFor(
      () => {
        const v = fleet!.view("actions-runner-e2e");
        return v?.lastResult?.job === "e2e-job" ? v.lastResult : null;
      },
      "作业完成被解析",
      15_000,
    );
    expect(lastResult.outcome).toBe("Succeeded");
    expect(lastResult.durationMs).toBeGreaterThanOrEqual(2000);

    // 日志环同时收录了两种形态但已归并去重（e2e-job 事件行各出现一次）
    const view = fleet.view("actions-runner-e2e")!;
    expect(view.log.filter((l) => l.includes("Running job: e2e-job"))).toHaveLength(1);
    expect(view.log.some((l) => l.includes("Listening for Jobs"))).toBe(true);

    await fleet.stop("actions-runner-e2e");
    await waitFor(
      () => (fleet!.view("actions-runner-e2e")?.processState === "stopped" ? true : null),
      "停止",
      15_000,
    );
  }, 60_000);

  it("外部启动的 Runner.Listener 进程被对账识别，停止后回落 stopped", async () => {
    fleet = new fleetModule.Fleet();
    await fleet.boot();
    await waitFor(() => fleet!.view("actions-runner-e2e")?.configured, "实例被发现");

    // argv[0] 伪装成 Runner.Listener run，cwd 在实例目录 → pgrep+lsof 命中
    const fake = spawn("bash", ["-c", `exec -a "Runner.Listener run" sleep 30`], {
      cwd: instanceDir,
      stdio: "ignore",
      detached: true,
    });
    fake.unref();
    fakeExternals.push(fake);

    await waitFor(
      () => {
        const v = fleet!.view("actions-runner-e2e");
        return v?.processState === "running" && v.external && v.pid === fake.pid ? true : null;
      },
      "外部进程被识别",
      20_000,
    );

    await fleet.stop("actions-runner-e2e");
    await waitFor(
      () => (fleet!.view("actions-runner-e2e")?.processState === "stopped" ? true : null),
      "外部进程停止",
      15_000,
    );
  }, 60_000);
});
