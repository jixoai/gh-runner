/*
 * 原始需求（2026-10-24）：表单配置必要信息后，即可把一个 runner 当实例注册并启动
 * （参考 Owner 的多开手册：解包既有 tarball、去隔离、config.sh --unattended）。
 *
 * 正交意图：
 * 1. 注册流水线：空目录 → 解包 runner 包 → 去 quarantine → config.sh 注册 → 校验 .runner。
 * 2. 每步产出人类可读的进度行（回传 UI），失败即中止并给出可操作信息。
 */

import { spawn } from "node:child_process";
import { readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRunnerMeta } from "./discover.ts";

export interface RegisterRequest {
  dir: string;
  name: string;
  token: string;
  labels: string;
  orgUrl: string;
  workFolder: string;
  /** 可空：空则自动在 searchDirs 里探测 actions-runner-osx-arm64-*.tar.gz。 */
  tarball: string | null;
}

export type ProgressSink = (line: string) => void;

export interface RegisterResult {
  ok: boolean;
  error: string | null;
  runnerDir: string;
}

async function runStep(
  title: string,
  cmd: string,
  args: string[],
  cwd: string,
  onProgress: ProgressSink,
  timeoutMs = 120_000,
): Promise<void> {
  onProgress(`$ ${title}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${title} 超时（${timeoutMs / 1000}s）`));
    }, timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    for (const stream of [child.stdout!, child.stderr!]) {
      let partial = "";
      stream.on("data", (chunk: string) => {
        partial += chunk;
        const lines = partial.split(/\r?\n/);
        partial = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) onProgress(`  ${l.trim()}`);
      });
    }
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`${title} 启动失败: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${title} 退出码 ${code}`));
    });
  });
}

/** 在 searchDirs 中探测可复用的 runner 分发包。 */
export async function findTarball(searchDirs: string[]): Promise<string | null> {
  for (const parent of searchDirs) {
    // 约定：包在 actions-runner/ 目录内（Owner 现机布局）。
    for (const sub of ["actions-runner", "."]) {
      const dir = join(parent, sub);
      try {
        const names = await readdir(dir);
        const hit = names
          .filter((n) => /^actions-runner-osx-(arm64|x64)-.*\.tar\.gz$/.test(n))
          .sort()
          .at(-1);
        if (hit) return join(dir, hit);
      } catch {
        /* 目录不存在 */
      }
    }
  }
  return null;
}

export async function registerRunner(
  req: RegisterRequest,
  searchDirs: string[],
  onProgress: ProgressSink,
): Promise<RegisterResult> {
  const dir = req.dir;
  try {
    if (!dir || !dir.startsWith("/")) throw new Error("实例目录必须是绝对路径");
    if (!req.name.trim()) throw new Error("缺少实例名称");
    if (!req.token.trim()) throw new Error("缺少注册 Token（org 设置页每次生成、一次性）");

    let entries: string[] = [];
    if (existsSync(dir)) {
      entries = await readdir(dir);
      if (entries.some((e) => e !== ".DS_Store")) {
        throw new Error(`目录非空（${entries.length} 项）：注册必须是空目录；管理已有实例请直接 attach`);
      }
    } else {
      onProgress(`创建目录 ${dir}`);
      await mkdir(dir, { recursive: true });
    }

    const tarball = req.tarball?.trim() ? req.tarball.trim() : await findTarball(searchDirs);
    if (!tarball || !existsSync(tarball)) {
      throw new Error(
        "未找到 runner 分发包（actions-runner-osx-*.tar.gz）。请到 org runner 新建页下载后填入包路径。",
      );
    }
    onProgress(`使用分发包 ${tarball}`);

    await runStep("解包分发包", "tar", ["-xzf", tarball], dir, onProgress);
    await runStep(
      "移除 quarantine 隔离标记",
      "xattr",
      ["-rd", "com.apple.quarantine", "."],
      dir,
      onProgress,
    );
    await runStep(
      "config.sh 注册",
      "./config.sh",
      [
        "--url",
        req.orgUrl.trim() || "https://github.com/jixoai",
        "--token",
        req.token.trim(),
        "--name",
        req.name.trim(),
        "--labels",
        req.labels.trim() || "self-hosted,macOS,ARM64",
        "--work",
        req.workFolder.trim(),
        "--unattended",
      ],
      dir,
      onProgress,
      300_000,
    );

    const meta = await readRunnerMeta(dir);
    if (!meta.configured) throw new Error("注册后未找到 .runner，注册疑似失败，请查看上方 config.sh 输出");
    onProgress(`✔ 注册成功：${meta.agentName}（agentId=${meta.agentId}）`);
    return { ok: true, error: null, runnerDir: dir };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress(`✘ 注册失败：${message}`);
    return { ok: false, error: message, runnerDir: dir };
  }
}
