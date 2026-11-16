import { describe, expect, it } from "vitest";
import { windowsProcessQuery } from "../src/windows-process.ts";

describe("Windows native process query", () => {
  it("只读枚举 Runner 和私有宿主，不依赖 CIM 或性能计数器", () => {
    const query = windowsProcessQuery();
    const script = Buffer.from(query.args.at(-1)!, "base64").toString("utf16le");
    expect(query.file).toBe("powershell.exe");
    expect(query.args).toContain("-NonInteractive");
    expect(script).toContain("CreateToolhelp32Snapshot(2, 0)");
    expect(script).toContain('"Runner.Listener.exe"');
    expect(script).toContain('"powershell.exe"');
    expect(script).toContain("OpenProcess(0x1000, false, processId)");
    expect(script).toContain("CloseHandle(snapshot)");
    expect(script).toContain("CloseHandle(handle)");
    expect(script).toContain("FreeHGlobal(buffer)");
    expect(script).toContain("ConvertTo-Json -Compress -InputObject @([GhRunnerProcesses]::Find())");
    expect(script).not.toMatch(/Get-CimInstance|Get-WmiObject|Get-Process|tasklist|Process\.GetProcesses/);
    expect(query.args.join(" ").length + 200).toBeLessThan(32767);
  });

  it("单个 PID 的启动时间也使用原生读取", () => {
    const query = windowsProcessQuery(5980);
    const script = Buffer.from(query.args.at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("GetProcessTimes");
    expect(script).toContain("[GhRunnerProcesses]::Read(5980, $null).StartedAt");
    expect(query.args.join(" ").length + 200).toBeLessThan(32767);
  });

  it.each([0, -1, 1.5, NaN, Infinity])("拒绝无效 PID：%s", (pid) => {
    expect(() => windowsProcessQuery(pid)).toThrow("Invalid runner PID");
  });
});
