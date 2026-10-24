/*
 * 原始需求（2026-10-24）：把 runner 当实例启动或者关闭——即对 <dir>/run.sh 的受控拉起与整组终止。
 *
 * 正交意图：
 * 1. 以独立进程组 spawn run.sh，捕获 stdout/stderr 行；提供优雅 TERM→限时 KILL 的停止。
 * 2. 进程存活性核对（pid 复用防御），不负责状态机（归 fleet）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface SpawnedRunner {
  pid: number;
  child: ChildProcess;
}

export type OutputLineSink = (stream: "stdout" | "stderr", line: string) => void;

const ANSI = /\x1b\[[0-9;]*m/g;

function stripAnsi(line: string): string {
  return line.replaceAll(ANSI, "").trimEnd();
}

function splitLines(chunk: string): string[] {
  return chunk.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

/**
 * 拉起 <dir>/run.sh（detached：随工具退出继续存活，与"终端里跑"等价）。
 * 返回 null 表示 run.sh 不存在。
 */
export function startRunner(dir: string, onLine: OutputLineSink): SpawnedRunner | null {
  const runSh = join(dir, "run.sh");
  if (!existsSync(runSh)) return null;

  const child = spawn(join(dir, "run.sh"), [], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUNNER_MANUALLY_TRAP_SIG: "1" },
  });
  const pid = child.pid!;
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]!.setEncoding("utf8");
    child[stream]!.on("data", (chunk: string) => {
      for (const line of splitLines(chunk)) onLine(stream, stripAnsi(line));
    });
  }
  child.unref();
  return { pid, child };
}

/** pid 是否仍是存活进程（防 pid 复用：核对 pid 恒存在即可，调用方负责匹配 cwd）。 */
export async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 终止一个进程组：SIGTERM → graceMs 后仍存活则 SIGKILL。
 * 返回是否成功终止（进程已消失也算成功）。
 */
export async function stopProcessGroup(pid: number, graceMs = 8000): Promise<boolean> {
  const exists = async (): Promise<boolean> => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!(await exists())) return true;

  // 负 pid = 整组（spawn detached 时子进程自成组长）。
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* 已消失 */
      }
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (!(await exists())) return true;
  }
  signal("SIGKILL");
  await new Promise((r) => setTimeout(r, 500));
  return !(await exists());
}
