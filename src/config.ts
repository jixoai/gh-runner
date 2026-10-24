/*
 * 原始需求（2026-10-24）：工具自身的实例清单（搜索目录、autoStart）需要跨启动持久化。
 *
 * 正交意图：
 * 1. 读写 ~/Library/Application Support/runner-fleet/config.json（损坏时回退默认）。
 * 2. 注册新实例 / 更新实例配置的纯数据操作。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InstanceConfig, ToolConfig } from "./types.ts";

export const DEFAULT_SEARCH_DIRS = ["/Volumes/bnqkl/Users/kzf"];

export function configDir(): string {
  return join(homedir(), "Library", "Application Support", "runner-fleet");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

export async function loadConfig(): Promise<ToolConfig> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ToolConfig>;
    return {
      searchDirs:
        Array.isArray(parsed.searchDirs) && parsed.searchDirs.length > 0
          ? parsed.searchDirs
          : DEFAULT_SEARCH_DIRS,
      instances: Array.isArray(parsed.instances) ? parsed.instances : [],
    };
  } catch {
    return { searchDirs: DEFAULT_SEARCH_DIRS, instances: [] };
  }
}

export async function saveConfig(config: ToolConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function upsertInstance(
  config: ToolConfig,
  instance: InstanceConfig,
): ToolConfig {
  const rest = config.instances.filter((i) => i.id !== instance.id && i.dir !== instance.dir);
  return { ...config, instances: [...rest, instance] };
}

export function removeInstance(config: ToolConfig, id: string): ToolConfig {
  return { ...config, instances: config.instances.filter((i) => i.id !== id) };
}

export function autoStartOf(config: ToolConfig, id: string): boolean {
  return config.instances.find((i) => i.id === id)?.autoStart ?? false;
}
