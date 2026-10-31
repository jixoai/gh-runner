/*
 * 原始需求（2026-10-24 表单注册；2026-10-26 扩展）：表单配置必要信息后，把一个 runner 注册为实例——
 * 分发包支持：选定的本地/已下载包 → 解包 →（darwin）去 quarantine → 注册（config.sh 或
 * Windows 下 Listener configure 动词）→ 校验 .runner。每步产出进度行回传 UI。
 *
 * 正交意图：
 * 1. 注册流水线（平台分支收敛在 platform.ts）。
 * 2. 统一 tar 解包（bsdtar 同时支持 tar.gz 与 zip，macOS/Linux/Win10+ 均内置）。
 */

import { spawn } from "node:child_process";
import { readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRunnerMeta } from "./discover.ts";
import {
  IS_WIN,
  PLATFORM,
  registerSpawn,
  unregisterSpawn,
  defaultLabels,
  basenameOf,
  isAbsolutePath,
} from "./platform.ts";

export interface RegisterRequest {
  dir: string;
  name: string;
  token: string;
  labels: string;
  orgUrl: string;
  workFolder: string;
  /** 选定的分发包（下载缓存或导入的本地路径）；null 时回退旧版自动探测（searchDirs 内）。 */
  packagePath: string | null;
  reusePackage?: boolean;
}

export type ProgressSink = (line: string) => void;

export interface RegisterResult {
  ok: boolean;
  error: string | null;
  runnerDir: string;
}

async function runStep(
  title: string,
  file: string,
  args: string[],
  cwd: string,
  onProgress: ProgressSink,
  token = "",
): Promise<void> {
  const timeoutMs = 300_000;
  onProgress(`$ ${title}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: token ? { ...process.env, ACTIONS_RUNNER_INPUT_TOKEN: token } : process.env,
    });
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
        for (const line of lines) {
          if (line.trim()) onProgress(`  ${token ? line.trim().replaceAll(token, "[已隐藏]") : line.trim()}`);
        }
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

/** 旧版回退：在 searchDirs 的约定位置（actions-runner/）探测既有分发包。 */
export async function findTarball(searchDirs: string[]): Promise<string | null> {
  for (const parent of searchDirs) {
    for (const sub of ["actions-runner", "."]) {
      const dir = join(parent, sub);
      try {
        const names = await readdir(dir);
        const hit = names
          .filter((n) => /^actions-runner-(osx|win|linux)-(x86|x64|arm64)-.*\.(tar\.gz|zip)$/.test(n))
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

export async function validateNewRunner(req: RegisterRequest, searchDirs: string[]): Promise<string> {
  if (!req.dir || !isAbsolutePath(req.dir)) throw new Error("实例目录必须是绝对路径");
  if (!req.name.trim()) throw new Error("缺少实例名称");
  if (!req.workFolder.trim() || !isAbsolutePath(req.workFolder)) throw new Error("Work 目录必须是独立的绝对路径");
  if (existsSync(req.dir)) {
    const entries = await readdir(req.dir);
    if (entries.some((entry) => entry !== ".DS_Store")) {
      throw new Error(`目录非空且无可用于全新注册的空目录（${req.dir}）：无法安全解包。已有实例请使用「导入 runner 目录」；否则请选择空目录。`);
    }
  }
  const pkg = req.packagePath?.trim() || await findTarball(searchDirs);
  if (!pkg || !existsSync(pkg)) throw new Error("未选定分发包：请下载最新版或导入本地包");
  return pkg;
}

export async function registerRunner(
  req: RegisterRequest,
  searchDirs: string[],
  onProgress: ProgressSink,
): Promise<RegisterResult> {
  const dir = req.dir;
  try {
    if (!dir || !isAbsolutePath(dir)) {
      throw new Error("实例目录必须是绝对路径");
    }

    // Attach 路径：目录已含 .runner（此前注册过的实例）→ 直接接入清单，
    // 不解包不重注册，也不需要 Token/名称/Work 目录（恢复丢失清单的官方路径）。
    if (existsSync(join(dir, ".runner"))) {
      onProgress(`检测到已注册实例（${dir}）→ 接入管理清单`);
      const meta = await readRunnerMeta(dir);
      if (!meta.configured) throw new Error(".runner 存在但无法解析（损坏？）");
      onProgress(
        `✔ 接入成功：${meta.agentName}（agentId=${meta.agentId}）` +
          (meta.workFolder ? `，work 目录已恢复：${meta.workFolder}` : ""),
      );
      return { ok: true, error: null, runnerDir: dir };
    }

    if (!req.token.trim()) throw new Error("缺少 runner 注册 Token（有效期 1 小时）");
    const pkg = req.reusePackage ? null : await validateNewRunner(req, searchDirs);
    if (!existsSync(dir)) {
      onProgress(`创建目录 ${dir}`);
      await mkdir(dir, { recursive: true });
    }

    if (pkg) {
      onProgress(`使用分发包 ${basenameOf(pkg)}`);

      // bsdtar 自动识别 tar.gz/zip（macOS、Linux、Win10+ 内置）
      await runStep("解包分发包", "tar", ["-xf", pkg], dir, onProgress);
      if (PLATFORM === "darwin") {
        // quarantine 仅存在于 macOS；Linux 无 xattr 命令，Windows 无此概念
        await runStep(
          "移除 quarantine 隔离标记",
          "xattr",
          ["-rd", "com.apple.quarantine", "."],
          dir,
          onProgress,
        );
      }
    }

    const reg = registerSpawn(dir);
    if (!existsSync(join(dir, reg.file.replace("./", ""))) && !IS_WIN) {
      throw new Error("解包结果缺少 config.sh：包内容与预期不符");
    }
    await runStep(
      IS_WIN ? "Listener configure 注册" : "config.sh 注册",
      reg.file,
      [
        ...reg.prefixArgs,
        "--url",
        req.orgUrl.trim() || "https://github.com/jixoai",
        "--name",
        req.name.trim(),
        "--labels",
        req.labels.trim() || defaultLabels(),
        "--work",
        req.workFolder.trim(),
        "--unattended",
      ],
      dir,
      onProgress,
      req.token.trim(),
    );

    const meta = await readRunnerMeta(dir);
    if (!meta.configured) throw new Error("注册后未找到 .runner，注册疑似失败，请查看上方输出");
    onProgress(`✔ 注册成功：${meta.agentName}（agentId=${meta.agentId}）`);
    return { ok: true, error: null, runnerDir: dir };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress(`✘ 注册失败：${message}`);
    return { ok: false, error: message, runnerDir: dir };
  }
}

export async function unregisterRunner(dir: string, token: string, onProgress: ProgressSink): Promise<void> {
  if (!isAbsolutePath(dir)) throw new Error("实例目录必须是绝对路径");
  if (!token.trim()) throw new Error("缺少 runner 注销 Token（不是注册 Token 或 PAT）");
  if (!existsSync(join(dir, ".runner"))) throw new Error("本机注册配置已缺失，请在 GitHub 设置中确认或移除线上 runner");
  const command = unregisterSpawn(dir);
  await runStep("注销 GitHub runner", command.file, [...command.prefixArgs, "--unattended"], dir, onProgress, token.trim());
  if (existsSync(join(dir, ".runner")) || existsSync(join(dir, ".credentials")) || existsSync(join(dir, ".credentials_rsaparams"))) {
    throw new Error("注销命令未清理本机连接配置，请检查日志；工作文件已保留");
  }
}
