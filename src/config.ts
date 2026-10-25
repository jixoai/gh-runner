/*
 * 原始需求（2026-10-24）：工具自身的实例清单（搜索目录、autoStart）需要跨启动持久化。
 *
 * 正交意图：
 * 1. 读写 ~/Library/Application Support/gh-runner/config.json（损坏时回退默认）。
 * 2. 注册新实例 / 更新实例配置的纯数据操作。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultSearchDirs, isAbsolutePath } from "./platform.ts";
import type { InstanceConfig, ToolConfig } from "./types.ts";

export const DEFAULT_SEARCH_DIRS = defaultSearchDirs();

export function configDir(): string {
  return join(homedir(), "Library", "Application Support", "gh-runner");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

/** 形状校验：损坏的实例项直接丢弃（手编配置/撕裂写的容错），不让 boot 崩掉。 */
function validInstance(item: unknown): item is InstanceConfig {
  return (
    typeof item === "object" && item !== null &&
    typeof (item as InstanceConfig).dir === "string" &&
    (item as InstanceConfig).dir.startsWith("/") &&
    typeof (item as InstanceConfig).id === "string"
  );
}

export async function loadConfig(): Promise<ToolConfig> {
  try {
    const raw = (await readFile(configPath(), "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Partial<ToolConfig>;
    const searchDirs = Array.isArray(parsed.searchDirs)
      ? parsed.searchDirs.filter((d): d is string => typeof d === "string" && isAbsolutePath(d))
      : [];
    const instances = Array.isArray(parsed.instances)
      ? parsed.instances.filter((i): i is InstanceConfig => validInstance(i))
      : [];
    const importedPackages = Array.isArray(parsed.importedPackages)
      ? parsed.importedPackages.filter((p): p is string => typeof p === "string")
      : [];
    return {
      searchDirs: searchDirs.length > 0 ? searchDirs : DEFAULT_SEARCH_DIRS,
      instances,
      importedPackages,
    };
  } catch {
    return { searchDirs: DEFAULT_SEARCH_DIRS, instances: [], importedPackages: [] };
  }
}

/** 原子写：tmp + rename，杜绝撕裂写（损坏的 config 会 brick 启动路径）。 */
export async function saveConfig(config: ToolConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  const path = configPath();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export function upsertInstance(
  config: ToolConfig,
  instance: InstanceConfig,
): ToolConfig {
  const rest = config.instances.filter((i) => i.id !== instance.id && i.dir !== instance.dir);
  return { ...config, instances: [...rest, instance] };
}
