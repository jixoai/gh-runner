const CONSOLE_HOST = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class GhRunnerConsole {
    private delegate bool ConsoleHandler(uint signal);
    private static readonly ConsoleHandler IgnoreSignal = signal => true;
    [DllImport("kernel32.dll")] private static extern bool AllocConsole();
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

    public static int Bootstrap(string directory, string command) {
        var settings = new ProcessStartInfo {
            FileName = "powershell.exe",
            Arguments = "-NoLogo -NoProfile -NonInteractive -EncodedCommand " + command,
            WorkingDirectory = directory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        settings.EnvironmentVariables.Remove("GH_RUNNER_CONSOLE_COMMAND");
        using (var host = Process.Start(settings)) {
            host.StandardInput.Close();
            Task output = Pump(host.StandardOutput.BaseStream, Console.OpenStandardOutput());
            Task error = Pump(host.StandardError.BaseStream, Console.OpenStandardError());
            host.WaitForExit();
            Task.WaitAll(output, error);
            return host.ExitCode;
        }
    }

    public static int Run(string directory) {
        Stream output = Console.OpenStandardOutput();
        Stream error = Console.OpenStandardError();
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
        FreeConsole();
        if (!AllocConsole()) throw new InvalidOperationException("Cannot allocate runner console");
        ShowWindow(GetConsoleWindow(), 0);
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

export function windowsRunnerHost(dir: string): { file: string; args: string[] } {
  return {
    file: "powershell.exe",
    args: consoleScript(`exit [GhRunnerConsole]::Run('${dir.replaceAll("'", "''")}')`),
  };
}

export function windowsRunnerBootstrap(dir: string): { file: string; args: string[]; env: Record<string, string> } {
  const host = windowsRunnerHost(dir);
  return {
    file: host.file,
    args: consoleScript(`exit [GhRunnerConsole]::Bootstrap('${dir.replaceAll("'", "''")}', $env:GH_RUNNER_CONSOLE_COMMAND)`),
    env: { GH_RUNNER_CONSOLE_COMMAND: host.args.at(-1)! },
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
  const directory = /\[GhRunnerConsole\]::Run\('((?:[^']|'')*)'\)/.exec(script)?.[1];
  return directory?.replaceAll("''", "'") ?? null;
}
