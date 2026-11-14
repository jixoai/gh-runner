import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findListenerProcesses } from "../src/discover.ts";
import { startRunner, stopProcessGroup } from "../src/supervisor.ts";

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

  it("PowerShell 启动参数与长编码命令兼容", async () => {
    const results: Array<{ detached: boolean; nonInteractive: boolean; padding: number; code: number | null; output: string }> = [];
    for (const detached of [false]) {
      for (const nonInteractive of [false, true]) {
        for (const padding of [0, 5000]) {
          const script = `[Console]::WriteLine('ps-ready'); exit 7\n#${" ".repeat(padding)}`;
          const args = ["-NoLogo", "-NoProfile", ...(nonInteractive ? ["-NonInteractive"] : []), "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
          const shell = spawn("powershell.exe", args, { detached, windowsHide: true, stdio: "pipe" });
          let output = "";
          shell.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
          shell.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
          const code = await new Promise<number | null>((resolve, reject) => {
            const timeout = setTimeout(() => { shell.kill(); reject(new Error("PowerShell smoke timeout")); }, 5000);
            shell.on("error", reject);
            shell.on("close", (code) => { clearTimeout(timeout); resolve(code); });
          });
          results.push({ detached, nonInteractive, padding, code, output });
        }
      }
    }
    expect(results.every(result => result.code === 7 && result.output.includes("ps-ready")), JSON.stringify(results)).toBe(true);
  });

  it("真实 Ctrl-Break 被 Runner 接收，退出后不残留会话宿主", async () => {
    const output: string[] = [];
    const runner = startRunner(directory, (stream, line) => output.push(`${stream}: ${line}`));
    expect(runner).not.toBeNull();
    await runner!.ready;
    pid = runner!.pid;
    let exitCode: number | null | undefined;
    const closed = new Promise<number | null>((resolve) => runner!.child.on("close", (code) => {
      exitCode = code;
      resolve(code);
    }));
    try {
      await vi.waitFor(async () => {
        if (exitCode !== undefined) throw new Error(`Host exited ${exitCode}`);
        expect(await readFile(join(directory, "started"), "utf8")).toBe("ready");
      }, { timeout: 15_000 });
    } catch (error) {
      throw new Error(`Runner did not start. Host exit=${exitCode}. Host output:\n${output.join("\n")}`, { cause: error });
    }
    expect((await findListenerProcesses(true)).get(pid)).toBe(directory);
    expect(await stopProcessGroup(pid)).toBe(true);
    expect(await closed).toBe(0);
    expect(await readFile(join(directory, "graceful-stop"), "utf8")).toBe("ControlBreak");
  });

  it("管理进程退出并关闭输出管道后 Runner 仍继续运行", async () => {
    const supervisor = pathToFileURL(join(import.meta.dirname, "../src/supervisor.ts")).href;
    const script = `import { startRunner } from ${JSON.stringify(supervisor)};
const runner = startRunner(${JSON.stringify(directory)}, () => {});
if (!runner) process.exit(1);
await runner.ready;
console.log(runner.pid);
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
