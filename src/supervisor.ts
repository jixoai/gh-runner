/*
 * 原始需求（2026-10-24）：把 runner 当实例启动或者关闭——即对 <dir>/run.sh 的受控拉起与整组终止。
 *
 * 正交意图：
 * 1. 以独立进程组 spawn run.sh，捕获 stdout/stderr 行；spawn 失败必须被捕获（error 事件）
 *    并同步暴露（pid 为空即失败），由调用方收尾——绝不让未处理 error 事件崩掉托盘进程。
 * 2. 优雅 TERM→限时 KILL 的整组终止；kill(2) 语义区分 ESRCH（已死）与 EPERM（存活但无权限），
 *    杜绝"假成功"；pid 复用防护由调用方以 cwd 核验承担。
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
 * 返回 null 表示 run.sh 不存在或无法 spawn（权限/解释器缺失——错误细节经 onLine(stderr) 回流）。
 */
export function startRunner(
  dir: string,
  onLine: OutputLineSink,
  onError?: (err: Error) => void,
): SpawnedRunner | null {
  const runSh = join(dir, "run.sh");
  if (!existsSync(runSh)) return null;

  const child = spawn(join(dir, "run.sh"), [], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUNNER_MANUALLY_TRAP_SIG: "1" },
  });
  // 先挂 error 再判 pid：spawn 失败（EACCES 等）时 pid 同步为 undefined，但 error 事件异步到达——
  // 监听缺失会以 uncaught exception 崩掉整个托盘进程。
  child.on("error", (err) => {
    onError?.(err);
    onLine("stderr", `[spawn error] ${err.message}`);
  });
  if (child.pid == null) {
    onLine("stderr", `[spawn error] 无法启动 run.sh（检查执行权限/解释器）`);
    return null;
  }
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]!.setEncoding("utf8");
    child[stream]!.on("data", (chunk: string) => {
      for (const line of splitLines(chunk)) onLine(stream, stripAnsi(line));
    });
  }
  child.unref();
  return { pid: child.pid, child };
}

/** kill(pid, 0) 的三态语义：dead=ESRCH，no-perm=EPERM（进程存活但无权限），alive=可管理。 */
export type PidExistence = "dead" | "alive" | "no-perm";

export function pidExists(pid: number): PidExistence {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" ? "no-perm" : "dead";
  }
}

/**
 * 终止一个进程组：SIGTERM → graceMs 后仍存活则 SIGKILL。
 * 返回 false 表示终止失败（进程未响应或无权限——EPERM 不算成功）。
 */
export async function stopProcessGroup(pid: number, graceMs = 8000): Promise<boolean> {
  const initial = pidExists(pid);
  if (initial === "dead") return true;

  // 负 pid = 整组（spawn detached 时子进程自成组长）；组信号失败退回单 pid。
  let signalError: NodeJS.ErrnoException | null = null;
  const signal = (sig: NodeJS.Signals): boolean => {
    signalError = null;
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      try {
        process.kill(pid, sig);
        return true;
      } catch (err) {
        signalError = err as NodeJS.ErrnoException;
        return false;
      }
    }
  };
  if (!signal("SIGTERM")) {
    // 信号根本没送达（EPERM）：不存在"等待生效"，直接判失败。
    return false;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (pidExists(pid) === "dead") return true;
  }
  if (!signal("SIGKILL")) return false;
  await new Promise((r) => setTimeout(r, 500));
  return pidExists(pid) === "dead";
}
