import { describe, expect, it } from "vitest";
import { windowsRunnerBootstrap, windowsRunnerHost, windowsRunnerHostDirectory, windowsRunnerStop } from "../src/windows-runner.ts";

describe("Windows runner console host", () => {
  it("引导进程在创建宿主时就隐藏独立控制台，避免终端接管与 Node 退出回收", () => {
    const bootstrap = windowsRunnerBootstrap("C:\\runner");
    expect(windowsRunnerHostDirectory(bootstrap.args.join(" "))).toBeNull();
    expect(windowsRunnerHostDirectory(`-EncodedCommand ${bootstrap.env.GH_RUNNER_CONSOLE_COMMAND}`)).toBe("C:\\runner");
    const script = Buffer.from(bootstrap.args.at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("[GhRunnerConsole]::Bootstrap");
    expect(script).toContain('Environment.SetEnvironmentVariable("GH_RUNNER_CONSOLE_COMMAND", null)');
    expect(script).toContain("Flags = STARTF_USESHOWWINDOW");
    expect(script).toContain("ShowWindow = SW_HIDE");
    expect(script).toContain("false, CREATE_NEW_CONSOLE | CREATE_BREAKAWAY_FROM_JOB");
    expect(script).toContain("CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED");
    expect(script).toContain("IsProcessInJob(process.ProcessHandle, IntPtr.Zero, out inJob)");
    expect(script).toContain("Cannot discard attached runner host");
    expect(script).toContain("ResumeThread(process.ThreadHandle)");
    expect(script).toContain("failure != 5");
    expect(script).toContain("Invoke-CimMethod -ClassName Win32_Process -MethodName Create");
    expect(script).toContain("EnvironmentVariables = $environment");
    expect(script).toContain("NamedPipeServerStream");
    expect(script).toContain("WaitForConnectionAsync()");
    expect(bootstrap.env.GH_RUNNER_CONSOLE_PIPE).toMatch(/^gh-runner-[a-f0-9-]+$/);
    expect(script).not.toContain("AllocConsole()");
  });

  it("同时识别旧宿主和带命名管道的新宿主，管道名称不允许注入命令", () => {
    const host = windowsRunnerHost("C:\\runner", "gh-runner-1234");
    expect(windowsRunnerHostDirectory(host.args.join(" "))).toBe("C:\\runner");
    expect(() => windowsRunnerHost("C:\\runner", "bad'; exit 1")).toThrow("Invalid runner pipe name");
  });

  it("宿主和 WMI 引导命令不超过 Windows 原生创建进程的长度上限", () => {
    const bootstrap = windowsRunnerBootstrap(`C:\\用户\\${"实例".repeat(100)}`);
    expect(bootstrap.args.join(" ").length + 200).toBeLessThan(32767);
    expect(bootstrap.env.GH_RUNNER_CONSOLE_COMMAND.length + 200).toBeLessThan(32767);
  });
  it.each(["C:\\actions-runners\\runner-01", "C:\\用户\\it's runner; $(test)\\实例"])("编码命令安全保留目录：%s", (directory) => {
    const host = windowsRunnerHost(directory);
    expect(host.file).toBe("powershell.exe");
    expect(windowsRunnerHostDirectory(host.args.join(" "))).toBe(directory);
    const script = Buffer.from(host.args.at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("GetStartupInfo(out startup)");
    expect(script).toContain("Runner host requires a console created hidden at startup");
    expect(script).toContain("SetConsoleOutputCP(65001)");
    expect(script).toContain("CreateNoWindow = false");
    expect(script).toContain("run --startuptype manual");
    expect(script).toContain("catch (IOException)");
  });

  it("只对私有控制台广播 Ctrl-Break，普通终端只定向发送", () => {
    const stop = windowsRunnerStop(1234);
    const script = Buffer.from(stop.args.at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("ProcessId=1234");
    expect(script).toContain("GenerateConsoleCtrlEvent(1, privateConsole ? 0 : processId)");
    expect(script).toContain("$privateConsole = $false");
    expect(windowsRunnerHostDirectory(stop.args.join(" "))).toBeNull();
  });

  it.each([0, -1, 1.5, NaN, Infinity])("拒绝无效 PID：%s", (pid) => {
    expect(() => windowsRunnerStop(pid)).toThrow("Invalid runner PID");
  });

  it("忽略不属于 GH Runner 的 PowerShell 命令", () => {
    expect(windowsRunnerHostDirectory("powershell -Command test")).toBeNull();
    expect(windowsRunnerHostDirectory("powershell -EncodedCommand invalid")).toBeNull();
  });
});
