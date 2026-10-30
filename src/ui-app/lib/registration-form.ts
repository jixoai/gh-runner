import { parseRunnerTarget } from "../../github-target.ts";

export interface RunnerDraft {
  key: number;
  name: string;
  dir: string;
  workFolder: string;
}

export function joinFolder(parent: string, name: string): string {
  const separator = parent.includes("\\") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`;
}

export function runnerPaths(root: string, runner: RunnerDraft): { dir: string; workFolder: string } {
  return {
    dir: runner.dir.trim() || joinFolder(root, runner.name.trim()),
    workFolder: runner.workFolder.trim() || joinFolder(root, `${runner.name.trim()}-work`),
  };
}

export function nextRunner(base: string, usedNames: string[], key: number): RunnerDraft {
  const used = new Set(usedNames.map((name) => name.toLowerCase()));
  let index = 1;
  while (used.has(`${base}-${String(index).padStart(2, "0")}`.toLowerCase())) index += 1;
  return { key, name: `${base}-${String(index).padStart(2, "0")}`, dir: "", workFolder: "" };
}

export function registrationError(targetUrl: string, root: string, runners: RunnerDraft[]): string | null {
  try { parseRunnerTarget(targetUrl); } catch (error) { return (error as Error).message; }
  const absolute = (value: string) => value.startsWith("/") || /^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\");
  if (!absolute(root)) return "请选择绝对路径作为存放位置，例如 /Users/你的用户名/actions-runners 或 C:\\actions-runners";
  if (!runners.length || runners.length > 10) return "每批可创建 1–10 个 runner";
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const runner of runners) {
    const name = runner.name.trim();
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(name)) return "实例名称请使用字母、数字、短横线、下划线或点，且不要以点开头";
    if (names.has(name.toLowerCase())) return `实例名称重复：${name}`;
    names.add(name.toLowerCase());
    for (const path of Object.values(runnerPaths(root, runner))) {
      if (!absolute(path)) return `${name} 的目录必须是绝对路径`;
      const normalized = path.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
      if (paths.has(normalized)) return "实例目录和 Work 目录不能重复，请为每个 runner 使用独立目录";
      paths.add(normalized);
    }
  }
  return null;
}
