import { describe, expect, it } from "vitest";
import { windowsRunnerHost, windowsRunnerHostDirectory, windowsRunnerStop } from "../src/windows-runner.ts";

describe("Windows runner console host", () => {
  it.each(["C:\\actions-runners\\runner-01", "C:\\用户\\it's runner; $(test)\\实例"])("编码命令安全保留目录：%s", (directory) => {
    const host = windowsRunnerHost(directory);
    expect(host.file).toBe("powershell.exe");
    expect(windowsRunnerHostDirectory(host.args.join(" "))).toBe(directory);
    const script = Buffer.from(host.args.at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("AllocConsole()");
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
