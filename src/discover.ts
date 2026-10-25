/*
 * 原始需求（2026-10-24）：本机已有多台按约定目录部署的 runner（actions-runner*），
 * 工具要能自动发现并把它们的运行状态（含外部终端启动的）纳入统一视图。
 *
 * 正交意图：
 * 1. 读 .runner 元数据、扫描父目录发现实例目录。
 * 2. 通过 ps+lsof 探测 Runner.Listener 进程与其 cwd，识别"外部在跑"的实例。
 */

import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IS_WIN } from "./platform.ts";
import type { InstanceConfig } from "./types.ts";

const exec = promisify(execFile);

export interface RunnerMeta {
  agentId: number | null;
  agentName: string | null;
  gitHubUrl: string | null;
  workFolder: string | null;
  configured: boolean;
}

/** 读取 <dir>/.runner；缺失或损坏时返回未配置态。注意 GitHub 写入的文件带 UTF-8 BOM。 */
export async function readRunnerMeta(dir: string): Promise<RunnerMeta> {
  try {
    const raw = (await readFile(join(dir, ".runner"), "utf8")).replace(/^\uFEFF/, "");
    const json = JSON.parse(raw) as {
      agentId?: number;
      agentName?: string;
      gitHubUrl?: string;
      workFolder?: string;
    };
    return {
      agentId: typeof json.agentId === "number" ? json.agentId : null,
      agentName: json.agentName ?? null,
      gitHubUrl: json.gitHubUrl ?? null,
      workFolder: json.workFolder ?? null,
      configured: true,
    };
  } catch {
    return {
      agentId: null,
      agentName: null,
      gitHubUrl: null,
      workFolder: null,
      configured: false,
    };
  }
}

/** 扫描父目录集合，返回含 .runner 的一层子目录（绝对路径）。 */
export async function discoverRunnerDirs(searchDirs: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const parent of searchDirs) {
    let names: string[];
    try {
      const entries = await readdir(parent, { withFileTypes: true });
      names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(parent, name);
      try {
        await readFile(join(dir, ".runner"), "utf8");
        found.push(dir);
      } catch {
        /* 无 .runner，忽略 */
      }
    }
  }
  return found.sort();
}

/**
 * 全部 Runner.Listener 进程 → pid 身份（darwin/linux = cwd；win32 = 由 ExecutablePath 推导的
 * runner 目录）。身份与实例目录对账。
 */
export async function findListenerProcesses(): Promise<Map<number, string>> {
  if (IS_WIN) {
    const result = new Map<number, string>();
    try {
      const { stdout } = await exec(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`,
        ],
        { timeout: 15_000 },
      );
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^(\d+)\|(.+)$/.exec(line.trim());
        if (!m) continue;
        // …\actions-runner\bin\Runner.Listener.exe → runner 目录是 bin 的上一级
        result.set(Number(m[1]), dirname(dirname(m[2]!)));
      }
    } catch {
      /* 无匹配或 PowerShell 不可用 */
    }
    return result;
  }

  const result = new Map<number, string>();
  try {
    const { stdout } = await exec("pgrep", ["-f", "Runner.Listener run"]);
    const pids = stdout
      .split("\n")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const { stdout: out } = await exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
          for (const line of out.split("\n")) {
            if (line.startsWith("n/")) {
              // lsof 报告解析后的真实路径（/private/var/...）；统一 realpath 后与实例目录对账。
              const raw = line.slice(1);
              result.set(pid, await realpath(raw).catch(() => raw));
            }
          }
        } catch {
          /* 进程刚好退出 */
        }
      }),
    );
  } catch {
    /* pgrep 无匹配时非零退出 */
  }
  return result;
}

/** 实例默认 id：目录名。 */
export function instanceIdOf(dir: string, _cfg?: InstanceConfig): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

/** 单个 pid 的身份（同 findListenerProcesses 口径；读不到返回 null）。供停止前的 pid 复用核验。 */
export async function pidIdentity(pid: number): Promise<string | null> {
  const all = await findListenerProcesses();
  return all.get(pid) ?? null;
}
