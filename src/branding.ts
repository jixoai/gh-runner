/*
 * 正交意图：品牌资产的运行时解析——App 图标目录（Dock/任务栏）与菜单栏模板图，
 * 路径随 npm 包分发（dist/assets），按 import.meta.url 就近解析。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppIcon } from "opentray";

export const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "assets");

/** 内核 manifest → 运行时 AppIcon（manifest 内相对路径 → 绝对）。 */
export function appIcon(): AppIcon {
  const manifest = JSON.parse(readFileSync(join(assetsDir, "manifest.json"), "utf8")) as {
    appIcon: { platform: string; format: string; source: { type: string; path: string }; size?: number }[];
  };
  return manifest.appIcon.map((asset) => ({
    ...asset,
    source: { type: "file", path: join(assetsDir, asset.source.path) },
  })) as AppIcon;
}

/** 菜单栏模板图（darwin：纯黑剪影 isTemplate 系统着色）。 */
export function trayTemplatePath(): string {
  return join(assetsDir, "tray-template.png");
}

/** 菜单栏彩色图（win32）。 */
export function trayColorPath(): string {
  return join(assetsDir, "tray-color.png");
}
