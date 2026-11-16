import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { findListenerProcesses, processStartedAt } from "../src/discover.ts";

let directory: string | null = null;
let listener: ChildProcess | null = null;

afterEach(async () => {
  if (listener) {
    const child = listener;
    listener = null;
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = null;
  }
});

describe.skipIf(process.platform !== "win32")("Windows native process query integration", () => {
  it("发现带空格和 Unicode 路径的 Listener，并排除同名配置进程", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "gh-runner 用户 it's ")));
    await mkdir(join(directory, "bin"));
    const executable = join(directory, "bin", "Runner.Listener.exe");
    await copyFile(process.execPath, executable);
    const script = "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);";
    await writeFile(join(directory, "run"), script);
    await writeFile(join(directory, "configure"), script);
    for (const argument of ["run", "configure"]) {
      listener = spawn(executable, [argument], { cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      await once(listener.stdout!, "data");
      const processes = await findListenerProcesses();
      if (argument === "run") {
        expect(win32.normalize(processes.get(listener.pid!)!)).toBe(win32.normalize(directory));
      } else {
        expect(processes.has(listener.pid!)).toBe(false);
      }
      const closed = once(listener, "close");
      listener.kill();
      await closed;
      listener = null;
    }
  });

  it("从本机当前进程读取启动时间，不查询 WMI", async () => {
    const timestamp = await processStartedAt(process.pid);
    expect(timestamp).not.toBeNull();
    expect(Math.abs(timestamp! - (Date.now() - process.uptime() * 1000))).toBeLessThan(5000);
  });
});
