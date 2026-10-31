export const RUNNER_TARGETS = [
  { id: "osx-arm64", label: "macOS · Apple 芯片 (ARM64)", platform: "darwin", arch: "arm64" },
  { id: "osx-x64", label: "macOS · Intel (x64)", platform: "darwin", arch: "x64" },
  { id: "win-x64", label: "Windows · x64", platform: "win32", arch: "x64" },
  { id: "win-arm64", label: "Windows · ARM64", platform: "win32", arch: "arm64" },
  { id: "linux-x64", label: "Linux · x64", platform: "linux", arch: "x64" },
  { id: "linux-arm64", label: "Linux · ARM64", platform: "linux", arch: "arm64" },
  { id: "linux-arm", label: "Linux · ARM (32 位)", platform: "linux", arch: "arm" },
] as const;

export type RunnerPackageTarget = typeof RUNNER_TARGETS[number]["id"];

export interface RunnerPackageSelection {
  target?: RunnerPackageTarget;
  version?: string;
}

export function recommendedRunnerTarget(platform: string, arch: string): RunnerPackageTarget | undefined {
  return RUNNER_TARGETS.find((target) => target.platform === platform && target.arch === arch)?.id;
}

export function resolvePackageSelection(selection: RunnerPackageSelection = {}, defaultTarget?: RunnerPackageTarget): { target: RunnerPackageTarget; version: string } {
  const target = selection.target ?? defaultTarget;
  if (!RUNNER_TARGETS.some((entry) => entry.id === target)) throw new Error("没有适配的 runner 平台，请手动选择受支持的操作系统和架构");
  const version = (selection.version ?? "latest").trim().replace(/^v(?=\d)/, "");
  if (version !== "latest" && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("版本号格式应为 2.338.2 或 v2.338.2；留在最新版选项可自动查询");
  return { target: target!, version };
}

export function runnerPackageName(target: RunnerPackageTarget, version: string): string {
  return `actions-runner-${target}-${version}.${target.startsWith("win-") ? "zip" : "tar.gz"}`;
}
