/*
 * 原始需求（2026-10-26）：支持 Windows——runner 包名、config/run 入口、进程发现/终止、
 * 目录揭示在平台间都不同；集中在一处做平台分支，其余模块只面向这里的抽象。
 *
 * 正交意图：
 * 1. 平台常量：runner 包资产名、config/run 启动命令、labels 默认值。
 * 2. 平台分支的进程/路径操作（揭示目录等）由 discover/supervisor 按需引用。
 */

import { platform, arch, homedir } from "node:os";
import { join, isAbsolute as nodeIsAbsolute } from "node:path";

export const IS_WIN = platform() === "win32";
export const PLATFORM = platform();
export const ARCH = arch();

/** actions/runner release 资产的平台段：darwin→osx, win32→win, linux→linux。 */
export function osSegment(p: NodeJS.Platform = PLATFORM): "osx" | "win" | "linux" {
  if (p === "darwin") return "osx";
  if (p === "win32") return "win";
  return "linux";
}

/** arch 段：ia32→x86, arm64→arm64, 其余→x64。 */
export function archSegment(a: string = ARCH): "x86" | "x64" | "arm64" {
  if (a === "ia32") return "x86";
  if (a === "arm64") return "arm64";
  return "x64";
}

/** 官方 release 资产名，如 actions-runner-osx-arm64-2.338.1.tar.gz / actions-runner-win-x64-2.338.1.zip。 */
export function assetNameFor(version: string, p: NodeJS.Platform = PLATFORM, a: string = ARCH): string {
  const ext = osSegment(p) === "win" ? "zip" : "tar.gz";
  return `actions-runner-${osSegment(p)}-${archSegment(a)}-${version}.${ext}`;
}

/** 包文件是否与当前平台匹配（供 UI 把不兼容包置灰）。 */
export function packageCompatible(fileName: string): boolean {
  const seg = `${osSegment()}-${archSegment()}`;
  return fileName.includes(`-${seg}-`);
}

/** runner 启动入口：darwin/linux 用 run.sh；win32 直接跑 Listener.exe（run.cmd 只是它的薄包装）。 */
export function runnerSpawn(dir: string): { file: string; args: string[] } {
  if (IS_WIN) return { file: join(dir, "bin", "Runner.Listener.exe"), args: ["run"] };
  return { file: join(dir, "run.sh"), args: [] };
}

/** 注册命令：darwin/linux 走 ./config.sh；win32 用 Listener 的 configure 动词（避免 cmd.exe 转义坑）。 */
export function registerSpawn(dir: string): { file: string; prefixArgs: string[] } {
  if (IS_WIN) return { file: join(dir, "bin", "Runner.Listener.exe"), prefixArgs: ["configure"] };
  return { file: "./config.sh", prefixArgs: [] };
}

/** labels 默认值（UI 预填）。 */
export function defaultLabels(): string {
  if (PLATFORM === "darwin") return "self-hosted,macOS,ARM64";
  if (IS_WIN) return `self-hosted,Windows,${archSegment().toUpperCase()}`;
  return `self-hosted,Linux,${archSegment().toUpperCase()}`;
}

/** 实例目录的默认父目录（UI placeholder 与初始 searchDirs）。 */
export function defaultSearchDirs(): string[] {
  if (PLATFORM === "darwin") return ["/Volumes/bnqkl/Users/kzf"];
  if (IS_WIN) return ["C:\\actions-runner", homedir()];
  return [homedir()];
}

/** 平台路径分段（win32 反斜杠）。 */
export function basenameOf(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

/** 平台无关的绝对路径判定。 */
export function isAbsolutePath(p: string): boolean {
  if (IS_WIN) return /^[A-Za-z]:[\\/]/.test(p) || nodeIsAbsolute(p);
  return nodeIsAbsolute(p);
}
