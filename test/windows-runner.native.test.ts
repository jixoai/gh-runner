import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findListenerProcesses } from "../src/discover.ts";
import { pidExists, startRunner, stopProcessGroup } from "../src/supervisor.ts";
import { windowsRunnerBootstrap } from "../src/windows-runner.ts";

const exec = promisify(execFile);
let directory: string;
let pid: number | undefined;

describe.skipIf(process.platform !== "win32")("Windows native console lifecycle", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "runner-console-"));
    await mkdir(join(directory, "bin"));
    const program = `using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public class MockRunner {
  [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll")] private static extern uint GetConsoleProcessList(uint[] processes, uint count);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  public static void Main(string[] arguments) {
    Console.CancelKeyPress += (sender, cancel) => {
      cancel.Cancel = true;
      File.WriteAllText("graceful-stop", cancel.SpecialKey.ToString());
      Environment.Exit(0);
    };
    IntPtr window = GetConsoleWindow();
    uint[] consoleProcesses = new uint[32];
    uint consoleProcessCount = GetConsoleProcessList(consoleProcesses, (uint)consoleProcesses.Length);
    Array.Resize(ref consoleProcesses, (int)consoleProcessCount);
    File.WriteAllText("console-state", window.ToInt64() + "\\n" + IsWindowVisible(window) + "\\n" + string.Join(",", consoleProcesses));
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

  it("Runner 控制台已隐藏且不与管理进程共享", async () => {
    const runner = startRunner(directory, () => {});
    expect(runner).not.toBeNull();
    await runner!.ready;
    pid = runner!.pid;
    await vi.waitFor(async () => expect(await readFile(join(directory, "started"), "utf8")).toBe("ready"), { timeout: 15_000 });
    const [window, visible, processes] = (await readFile(join(directory, "console-state"), "utf8")).split("\n");
    expect(Number(window)).toBeGreaterThan(0);
    expect(visible).toBe("False");
    const consoleProcesses = processes!.split(",").map(Number);
    expect(consoleProcesses).toContain(pid);
    expect(consoleProcesses).not.toContain(process.pid);
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

  it("管理器退出后 Runner 仍运行，重新启动的管理器可以发现并停止", async () => {
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
    const configDirectory = join(directory, "config", "gh-runner");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(directory, ".runner"), JSON.stringify({ agentId: 99, agentName: "native-runner", gitHubUrl: "https://github.com/test", workFolder: "_work" }));
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({ searchDirs: [], importedPackages: [], instances: [{ id: "native-runner", dir: directory, autoStart: false }] }));
    const fleet = pathToFileURL(join(import.meta.dirname, "../src/fleet.ts")).href;
    const restarted = `import { Fleet } from ${JSON.stringify(fleet)};
const fleet = new Fleet();
try {
  await fleet.boot({ autoStart: false, persist: false });
  const instance = fleet.snapshot().instances[0];
  if (!instance || instance.processState !== 'running') throw new Error('Runner was not rediscovered');
  await fleet.stop(instance.id);
  if (fleet.view(instance.id)?.processState !== 'stopped') throw new Error('Runner did not stop');
} finally { await fleet.destroy(); }`;
    await exec(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", restarted], { env: { ...process.env, APPDATA: join(directory, "config") }, timeout: 50_000 });
    expect(pidExists(pid)).toBe("dead");
    expect([...await findListenerProcesses(true)].some(([, path]) => path === directory)).toBe(false);
    expect(await readFile(join(directory, "graceful-stop"), "utf8")).toBe("ControlBreak");
  });

  it("关闭启动管理器的终端窗口不会关闭 Runner 的独立控制台", async () => {
    const quote = (value: string) => value.replaceAll("'", "''");
    const managerRecord = join(directory, "manager-ready.json");
    const terminalRecord = join(directory, "terminal.json");
    const managerScript = join(directory, "manager.mjs");
    const supervisor = pathToFileURL(join(import.meta.dirname, "../src/supervisor.ts")).href;
    await writeFile(managerScript, `import { writeFileSync } from 'node:fs';
import { startRunner } from ${JSON.stringify(supervisor)};
const runner = startRunner(${JSON.stringify(directory)}, () => {});
if (!runner) process.exit(1);
await runner.ready;
writeFileSync(${JSON.stringify(managerRecord)}, JSON.stringify({ managerPid: process.pid, runnerPid: runner.pid }));
setInterval(() => {}, 1000);`);
    const bootstrap = windowsRunnerBootstrap(directory);
    const pipeName = bootstrap.env.GH_RUNNER_CONSOLE_PIPE;
    const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class TestTerminal {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
'@
$outputPipe = [IO.Pipes.NamedPipeClientStream]::new('.', '${pipeName}-out', [IO.Pipes.PipeDirection]::Out)
$errorPipe = [IO.Pipes.NamedPipeClientStream]::new('.', '${pipeName}-err', [IO.Pipes.PipeDirection]::Out)
$outputPipe.Connect(15000)
$errorPipe.Connect(15000)
@{ window = [TestTerminal]::GetConsoleWindow().ToInt64(); pid = $PID } | ConvertTo-Json | Set-Content -Encoding UTF8 '${quote(terminalRecord)}'
& '${quote(process.execPath)}' '${quote(managerScript)}'
exit $LASTEXITCODE`;
    const terminal = spawn(bootstrap.file, bootstrap.args, {
      cwd: directory,
      detached: false,
      windowsHide: true,
      stdio: "pipe",
      env: { ...process.env, ...bootstrap.env, GH_RUNNER_CONSOLE_COMMAND: Buffer.from(script, "utf16le").toString("base64") },
    });
    let terminalError: Error | undefined;
    let terminalOutput = "";
    terminal.on("error", (error) => { terminalError = error; });
    terminal.stdout.on("data", (chunk: Buffer) => { terminalOutput += chunk.toString(); });
    terminal.stderr.on("data", (chunk: Buffer) => { terminalOutput += chunk.toString(); });
    let terminalPid: number | undefined;
    try {
      await vi.waitFor(async () => {
        if (terminalError) throw terminalError;
        const record = JSON.parse((await readFile(terminalRecord, "utf8")).replace(/^\uFEFF/, ""));
        terminalPid = record.pid;
        expect(record.window, terminalOutput).toBeGreaterThan(0);
        const manager = JSON.parse(await readFile(managerRecord, "utf8"));
        pid = manager.runnerPid;
        expect(pid).toBeGreaterThan(0);
      }, { timeout: 25_000 });
      const { window } = JSON.parse((await readFile(terminalRecord, "utf8")).replace(/^\uFEFF/, ""));
      const { managerPid } = JSON.parse(await readFile(managerRecord, "utf8"));
      const close = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class TestTerminalClose {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr first, IntPtr second);
}
'@
if (![TestTerminalClose]::PostMessage([IntPtr]${window}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { exit 1 }`;
      await exec("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(close, "utf16le").toString("base64")], { timeout: 10_000 });
      await vi.waitFor(() => expect(pidExists(managerPid)).toBe("dead"), { timeout: 15_000 });
      expect(pidExists(pid!)).toBe("alive");
      expect((await findListenerProcesses(true)).get(pid!)).toBe(directory);
      expect(await stopProcessGroup(pid!)).toBe(true);
      expect(await readFile(join(directory, "graceful-stop"), "utf8")).toBe("ControlBreak");
    } finally {
      if (terminalPid && pidExists(terminalPid) !== "dead") {
        await exec("taskkill", ["/pid", String(terminalPid), "/T", "/F"], { timeout: 5000 }).catch(() => {});
      }
      terminal.kill();
    }
  });

  it("终端的禁止 breakaway 回收 Job 被关闭后 Runner 仍存活并可停止", async () => {
    const managerScript = join(directory, "restricted-manager.mjs");
    const managerRecord = join(directory, "restricted-ready.json");
    const assigned = join(directory, "job-assigned");
    const supervisor = pathToFileURL(join(import.meta.dirname, "../src/supervisor.ts")).href;
    await writeFile(managerScript, `import { existsSync, writeFileSync } from 'node:fs';
import { startRunner } from ${JSON.stringify(supervisor)};
while (!existsSync(${JSON.stringify(assigned)})) await new Promise(resolve => setTimeout(resolve, 100));
const runner = startRunner(${JSON.stringify(directory)}, () => {});
if (!runner) process.exit(1);
await runner.ready;
writeFileSync(${JSON.stringify(managerRecord)}, JSON.stringify({ managerPid: process.pid, runnerPid: runner.pid }));
setInterval(() => {}, 1000);`);
    const jobSource = `using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public class TestTerminalJob {
  [StructLayout(LayoutKind.Sequential)]
  private struct BasicLimits {
    public long ProcessTime;
    public long JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet;
    public UIntPtr MaximumWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority;
    public uint Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters {
    public ulong ReadOperations;
    public ulong WriteOperations;
    public ulong OtherOperations;
    public ulong ReadBytes;
    public ulong WriteBytes;
    public ulong OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory;
    public UIntPtr JobMemory;
    public UIntPtr PeakProcessMemory;
    public UIntPtr PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, uint kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  public static void Run(string directory, string executable, string script) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) throw new Win32Exception(Marshal.GetLastWin32Error());
      var settings = new ProcessStartInfo {
        FileName = executable,
        Arguments = "\\\"" + script + "\\\"",
        WorkingDirectory = directory,
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardOutput = true,
        RedirectStandardError = true
      };
      using (var manager = Process.Start(settings)) {
        if (!AssignProcessToJobObject(job, manager.Handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
        File.WriteAllText(Path.Combine(directory, "job-assigned"), "ready");
        var timeout = Stopwatch.StartNew();
        while (!File.Exists(Path.Combine(directory, "restricted-ready.json"))) {
          if (manager.HasExited) throw new Exception("Manager exited: " + manager.StandardError.ReadToEnd());
          if (timeout.ElapsedMilliseconds > 25000) throw new TimeoutException("Restricted manager did not start Runner");
          Thread.Sleep(100);
        }
        CloseHandle(job);
        job = IntPtr.Zero;
        manager.WaitForExit();
      }
    } finally {
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}`;
    const quote = (value: string) => value.replaceAll("'", "''");
    const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${jobSource}
'@
[TestTerminalJob]::Run('${quote(directory)}', '${quote(process.execPath)}', '${quote(managerScript)}')`;
    await exec("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 35_000 });
    const manager = JSON.parse(await readFile(managerRecord, "utf8"));
    pid = manager.runnerPid;
    expect(pidExists(manager.managerPid)).toBe("dead");
    expect(pidExists(pid!)).toBe("alive");
    await vi.waitFor(async () => expect(await readFile(join(directory, "started"), "utf8")).toBe("ready"), { timeout: 15_000 });
    expect((await findListenerProcesses(true)).get(pid!)).toBe(directory);
    expect(await stopProcessGroup(pid!)).toBe(true);
    expect(await readFile(join(directory, "graceful-stop"), "utf8")).toBe("ControlBreak");
  });
});
