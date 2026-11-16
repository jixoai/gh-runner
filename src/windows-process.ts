export const WINDOWS_COMMAND_LINE_SOURCE = String.raw`
public static class GhRunnerCommandLine {
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern System.IntPtr OpenProcess(uint access, bool inherit, int processId);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern bool CloseHandle(System.IntPtr handle);
    [System.Runtime.InteropServices.DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(System.IntPtr process, int informationClass, System.IntPtr buffer, int size, out int required);
    public static string Read(int processId) {
        var handle = OpenProcess(0x1000, false, processId);
        if (handle == System.IntPtr.Zero) return null;
        try { return Read(handle); } finally { CloseHandle(handle); }
    }
    public static string Read(System.IntPtr handle) {
        int required;
        NtQueryInformationProcess(handle, 60, System.IntPtr.Zero, 0, out required);
        if (required <= 0 || required > 131072) return null;
        var buffer = System.Runtime.InteropServices.Marshal.AllocHGlobal(required);
        try {
            if (NtQueryInformationProcess(handle, 60, buffer, required, out required) < 0) return null;
            int length = (ushort)System.Runtime.InteropServices.Marshal.ReadInt16(buffer);
            var text = System.Runtime.InteropServices.Marshal.ReadIntPtr(buffer, System.IntPtr.Size == 8 ? 8 : 4);
            return text == System.IntPtr.Zero ? null : System.Runtime.InteropServices.Marshal.PtrToStringUni(text, length / 2);
        } finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(buffer); }
    }
}`;

const WINDOWS_PROCESS_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
${WINDOWS_COMMAND_LINE_SOURCE}
public sealed class GhRunnerProcessInfo {
    public int ProcessId;
    public string Name;
    public string ExecutablePath;
    public string CommandLine;
    public long? StartedAt;
}
public static class GhRunnerProcesses {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public UIntPtr Heap;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string Name;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    public static GhRunnerProcessInfo Read(int processId, string name) {
        var result = new GhRunnerProcessInfo { ProcessId = processId, Name = name };
        var handle = OpenProcess(0x1000, false, processId);
        if (handle == IntPtr.Zero) return result;
        try {
            uint size = 32768;
            var path = new StringBuilder((int)size);
            if (QueryFullProcessImageNameW(handle, 0, path, ref size)) result.ExecutablePath = path.ToString();
            result.CommandLine = GhRunnerCommandLine.Read(handle);
            long creation, exit, kernel, user;
            if (GetProcessTimes(handle, out creation, out exit, out kernel, out user)) {
                result.StartedAt = new DateTimeOffset(DateTime.FromFileTimeUtc(creation)).ToUnixTimeMilliseconds();
            }
            return result;
        } finally { CloseHandle(handle); }
    }
    public static GhRunnerProcessInfo[] Find() {
        var snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var result = new List<GhRunnerProcessInfo>();
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            bool found = Process32FirstW(snapshot, ref entry);
            if (!found) {
                int error = Marshal.GetLastWin32Error();
                if (error != 18) throw new Win32Exception(error);
                return result.ToArray();
            }
            do {
                if (String.Equals(entry.Name, "Runner.Listener.exe", StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(entry.Name, "powershell.exe", StringComparison.OrdinalIgnoreCase)) {
                    result.Add(Read((int)entry.ProcessId, entry.Name));
                }
            } while (Process32NextW(snapshot, ref entry));
            int lastError = Marshal.GetLastWin32Error();
            if (lastError != 18) throw new Win32Exception(lastError);
            return result.ToArray();
        } finally { CloseHandle(snapshot); }
    }
}`;

export function windowsProcessQuery(pid?: number): { file: string; args: string[] } {
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error("Invalid runner PID");
  const command = pid === undefined
    ? "ConvertTo-Json -Compress -InputObject @([GhRunnerProcesses]::Find())"
    : `[GhRunnerProcesses]::Read(${pid}, $null).StartedAt`;
  const source = WINDOWS_PROCESS_SOURCE.replace(/^[ \t]+/gm, "");
  const script = `$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\nAdd-Type -TypeDefinition @'\n${source}\n'@\n${command}`;
  return {
    file: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  };
}
