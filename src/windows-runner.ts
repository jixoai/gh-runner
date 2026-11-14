import { randomUUID } from "node:crypto";

const CONSOLE_HOST = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class GhRunnerConsole {
    private const uint CREATE_NEW_CONSOLE = 0x00000010;
    private const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const ushort SW_HIDE = 0;
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo {
        public uint Size;
        public IntPtr Reserved;
        public IntPtr Desktop;
        public IntPtr Title;
        public uint PositionX;
        public uint PositionY;
        public uint Width;
        public uint Height;
        public uint CharacterWidth;
        public uint CharacterHeight;
        public uint FillAttribute;
        public uint Flags;
        public ushort ShowWindow;
        public ushort ReservedSize;
        public IntPtr ReservedData;
        public IntPtr StandardInput;
        public IntPtr StandardOutput;
        public IntPtr StandardError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo {
        public IntPtr ProcessHandle;
        public IntPtr ThreadHandle;
        public uint ProcessId;
        public uint ThreadId;
    }
    private delegate bool ConsoleHandler(uint signal);
    private static readonly ConsoleHandler IgnoreSignal = signal => true;
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern void GetStartupInfo(out StartupInfo startup);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll")] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern bool FreeConsole();
    [DllImport("kernel32.dll")] private static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll")] private static extern bool GenerateConsoleCtrlEvent(uint signal, uint processGroupId);
    [DllImport("kernel32.dll")] private static extern bool SetConsoleCtrlHandler(ConsoleHandler handler, bool add);
    [DllImport("kernel32.dll")] private static extern bool SetConsoleOutputCP(uint codePage);
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);

    private static async Task Pump(Stream source, Stream destination) {
        byte[] buffer = new byte[8192];
        bool writable = true;
        int count;
        while ((count = await source.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0) {
            if (!writable) continue;
            try {
                await destination.WriteAsync(buffer, 0, count).ConfigureAwait(false);
                await destination.FlushAsync().ConfigureAwait(false);
            } catch (IOException) {
                writable = false;
            }
        }
    }

    public static int Bootstrap(string directory, string command, string pipeName, Func<string, int> detachedLaunch) {
        var startup = new StartupInfo {
            Size = (uint)Marshal.SizeOf(typeof(StartupInfo)),
            Flags = STARTF_USESHOWWINDOW,
            ShowWindow = SW_HIDE
        };
        var process = new ProcessInfo();
        Environment.SetEnvironmentVariable("GH_RUNNER_CONSOLE_COMMAND", null);
        Environment.SetEnvironmentVariable("GH_RUNNER_CONSOLE_PIPE", null);
        using (var output = new NamedPipeServerStream(pipeName + "-out", PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
        using (var error = new NamedPipeServerStream(pipeName + "-err", PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous)) {
        try {
            string executable = Process.GetCurrentProcess().MainModule.FileName;
            var arguments = new StringBuilder("\"" + executable + "\" -NoLogo -NoProfile -NonInteractive -EncodedCommand " + command);
            if (!CreateProcess(executable, arguments, IntPtr.Zero, IntPtr.Zero, false, CREATE_NEW_CONSOLE | CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, directory, ref startup, out process)) {
                int failure = Marshal.GetLastWin32Error();
                if (failure != 5) throw new Win32Exception(failure, "Cannot start hidden runner console");
                process.ProcessId = (uint)detachedLaunch(arguments.ToString());
                process.ProcessHandle = OpenProcess(0x00101001, false, process.ProcessId);
                if (process.ProcessHandle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open detached runner host");
            }
            Task[] connections = { output.WaitForConnectionAsync(), error.WaitForConnectionAsync() };
            if (!Task.WaitAll(connections, 15000)) {
                TerminateProcess(process.ProcessHandle, 1);
                throw new TimeoutException("Runner output pipes did not connect");
            }
            Task outputTask = Pump(output, Console.OpenStandardOutput());
            Task errorTask = Pump(error, Console.OpenStandardError());
            if (WaitForSingleObject(process.ProcessHandle, uint.MaxValue) != 0) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot wait for runner host");
            }
            Task.WaitAll(outputTask, errorTask);
            uint code;
            if (!GetExitCodeProcess(process.ProcessHandle, out code)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read runner host exit code");
            }
            return unchecked((int)code);
        } finally {
            if (process.ThreadHandle != IntPtr.Zero) CloseHandle(process.ThreadHandle);
            if (process.ProcessHandle != IntPtr.Zero) CloseHandle(process.ProcessHandle);
        }
        }
    }

    public static int Run(string directory, string pipeName) {
        using (var output = new NamedPipeClientStream(".", pipeName + "-out", PipeDirection.Out))
        using (var error = new NamedPipeClientStream(".", pipeName + "-err", PipeDirection.Out)) {
            output.Connect(15000);
            error.Connect(15000);
            return RunWithOutput(directory, output, error);
        }
    }

    public static int Run(string directory) {
        Stream output = Console.OpenStandardOutput();
        Stream error = Console.OpenStandardError();
        return RunWithOutput(directory, output, error);
    }

    private static int RunWithOutput(string directory, Stream output, Stream error) {
        try {
            return RunListener(directory, output, error);
        } catch (Exception exception) {
            byte[] message = Encoding.UTF8.GetBytes("[runner host error] " + exception + Environment.NewLine);
            try {
                error.Write(message, 0, message.Length);
                error.Flush();
            } catch (IOException) {}
            return 1;
        }
    }

    private static int RunListener(string directory, Stream output, Stream error) {
        StartupInfo startup;
        GetStartupInfo(out startup);
        if ((startup.Flags & STARTF_USESHOWWINDOW) == 0 || startup.ShowWindow != SW_HIDE || GetConsoleWindow() == IntPtr.Zero) {
            throw new InvalidOperationException("Runner host requires a console created hidden at startup");
        }
        ShowWindow(GetConsoleWindow(), SW_HIDE);
        SetConsoleOutputCP(65001);
        if (!SetConsoleCtrlHandler(IgnoreSignal, true)) throw new InvalidOperationException("Cannot install runner console handler");
        var settings = new ProcessStartInfo {
            FileName = Path.Combine(directory, "bin", "Runner.Listener.exe"),
            Arguments = "run --startuptype manual",
            WorkingDirectory = directory,
            UseShellExecute = false,
            CreateNoWindow = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using (var listener = Process.Start(settings)) {
            listener.StandardInput.Close();
            byte[] ready = Encoding.UTF8.GetBytes("[gh-runner host ready] " + Process.GetCurrentProcess().Id + Environment.NewLine);
            output.Write(ready, 0, ready.Length);
            output.Flush();
            Task outputTask = Pump(listener.StandardOutput.BaseStream, output);
            Task errorTask = Pump(listener.StandardError.BaseStream, error);
            listener.WaitForExit();
            Task.WaitAll(outputTask, errorTask);
            return listener.ExitCode;
        }
    }

    public static bool Stop(uint processId, bool privateConsole) {
        FreeConsole();
        if (!AttachConsole(processId)) return false;
        try {
            if (!SetConsoleCtrlHandler(IgnoreSignal, true)) return false;
            bool sent = GenerateConsoleCtrlEvent(1, privateConsole ? 0 : processId);
            System.Threading.Thread.Sleep(200);
            return sent;
        } finally {
            FreeConsole();
        }
    }
}`;

function consoleScript(command: string): string[] {
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${CONSOLE_HOST}\n'@\n${command}`;
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

export function windowsRunnerHost(dir: string, pipeName?: string): { file: string; args: string[] } {
  if (pipeName && !/^gh-runner-[a-f0-9-]+$/.test(pipeName)) throw new Error("Invalid runner pipe name");
  return {
    file: "powershell.exe",
    args: consoleScript(`exit [GhRunnerConsole]::Run('${dir.replaceAll("'", "''")}'${pipeName ? `, '${pipeName}'` : ""})`),
  };
}

export function windowsRunnerBootstrap(dir: string): { file: string; args: string[]; env: { GH_RUNNER_CONSOLE_COMMAND: string; GH_RUNNER_CONSOLE_PIPE: string } } {
  const pipeName = `gh-runner-${randomUUID()}`;
  const directory = dir.replaceAll("'", "''");
  const host = windowsRunnerHost(dir, pipeName);
  return {
    file: host.file,
    args: consoleScript(`$launch = [Func[string, int]] {
param($command)
$environment = [string[]]([Environment]::GetEnvironmentVariables().GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]16; EnvironmentVariables = $environment }
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command; CurrentDirectory = '${directory}'; ProcessStartupInformation = $startup }
if ($result.ReturnValue -ne 0) { throw "Cannot detach runner from terminal job: WMI error $($result.ReturnValue)" }
return [int]$result.ProcessId
}
exit [GhRunnerConsole]::Bootstrap('${directory}', $env:GH_RUNNER_CONSOLE_COMMAND, $env:GH_RUNNER_CONSOLE_PIPE, $launch)`),
    env: { GH_RUNNER_CONSOLE_COMMAND: host.args.at(-1)!, GH_RUNNER_CONSOLE_PIPE: pipeName },
  };
}

export function windowsRunnerStop(pid: number): { file: string; args: string[] } {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid runner PID");
  return {
    file: "powershell.exe",
    args: consoleScript(`$privateConsole = $false
$target = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"
if ($target.CommandLine -match '-EncodedCommand\\s+([a-zA-Z0-9+/=]+)') {
  $decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1]))
  $privateConsole = $decoded.Contains('exit [GhRunnerConsole]::Run(')
}
if ([GhRunnerConsole]::Stop(${pid}, $privateConsole)) { exit 0 } else { exit 1 }`),
  };
}

export function windowsRunnerHostDirectory(commandLine: string): string | null {
  const encoded = /-EncodedCommand\s+([a-zA-Z0-9+/=]+)/i.exec(commandLine)?.[1];
  if (!encoded) return null;
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  const directory = /\[GhRunnerConsole\]::Run\('((?:[^']|'')*)'(?:, 'gh-runner-[a-f0-9-]+')?\)/.exec(script)?.[1];
  return directory?.replaceAll("''", "'") ?? null;
}
