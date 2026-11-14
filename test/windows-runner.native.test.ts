import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findListenerProcesses } from "../src/discover.ts";
import { startRunner, stopProcessGroup } from "../src/supervisor.ts";
import { windowsRunnerHost } from "../src/windows-runner.ts";

const exec = promisify(execFile);
let directory: string;
let pid: number | undefined;

describe.skipIf(process.platform !== "win32")("Windows native console lifecycle", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "runner-console-"));
    await mkdir(join(directory, "bin"));
    const program = `using System;
using System.IO;
using System.Threading;
public class MockRunner {
  public static void Main(string[] arguments) {
    Console.CancelKeyPress += (sender, cancel) => {
      cancel.Cancel = true;
      File.WriteAllText("graceful-stop", cancel.SpecialKey.ToString());
      Environment.Exit(0);
    };
    File.WriteAllText("started", "ready");
    while (true) {
      Console.WriteLine(DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm:ss") + "Z: Listening for Jobs");
      Thread.Sleep(100);
    }
  }
}`;
    const executable = join(directory, "bin", "Runner.Listener.exe").replaceAll("'", "''");
    const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${program}\n'@ -OutputAssembly '${executable}' -OutputType ConsoleApplication`;
    await exec("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 30_000 });
  });

  afterEach(async () => {
    if (pid) await stopProcessGroup(pid);
    pid = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  it("真实 Ctrl-Break 被 Runner 接收，退出后不残留会话宿主", async () => {
    const runner = startRunner(directory, () => {});
    expect(runner).not.toBeNull();
    pid = runner!.pid;
    const closed = new Promise<number | null>((resolve) => runner!.child.on("close", resolve));
    await vi.waitFor(async () => expect(await readFile(join(directory, "started"), "utf8")).toBe("ready"), { timeout: 15_000 });
    expect((await findListenerProcesses(true)).get(pid)).toBe(directory);
    expect(await stopProcessGroup(pid)).toBe(true);
    expect(await closed).toBe(0);
    expect(await readFile(join(directory, "graceful-stop"), "utf8")).toBe("ControlBreak");
  });

  it("管理进程退出并关闭输出管道后 Runner 仍继续运行", async () => {
    const host = windowsRunnerHost(directory);
    const script = `import { spawn } from 'node:child_process';
const runner = spawn(${JSON.stringify(host.file)}, ${JSON.stringify(host.args)}, { cwd: ${JSON.stringify(directory)}, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
runner.on('error', error => { console.error(error); process.exit(1); });
console.log(runner.pid);
runner.unref();
process.exit(0);`;
    const launcher = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    launcher.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    await new Promise<void>((resolve, reject) => {
      launcher.on("error", reject);
      launcher.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Launcher exited ${code}`)));
    });
    pid = Number(output.trim());
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(async () => expect(await readFile(join(directory, "started"), "utf8")).toBe("ready"), { timeout: 15_000 });
    expect(await stopProcessGroup(pid)).toBe(true);
    expect(await readFile(join(directory, "graceful-stop"), "utf8")).toBe("ControlBreak");
  });
});
