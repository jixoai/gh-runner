/*
 * 原始需求（2026-10-24）：挂在托盘里面的工具——菜单栏常驻，图标反映在跑数量，
 * 菜单直达每个实例（点击打开面板）与主窗口/退出。
 *
 * 正交意图：
 * 1. 快照 → 托盘图标文案 + tooltip + 菜单的投影。
 * 2. 菜单事件路由：实例项 id ↔ 实例 id 映射收在本类内。
 */

import type { CreateTrayHandle, CreateTrayMenu, Icon } from "opentray";
import { trayColorPath, trayTemplatePath } from "./branding.ts";
import type { Snapshot } from "./types.ts";

const ITEM_OPEN = 1;
const ITEM_QUIT = 2;
const ITEM_INSTANCE_BASE = 100;

export interface TrayActions {
  openWindow(): void;
  openInstance(id: string): void;
  quit(): void;
}

function stateLabel(snapshot: Snapshot, index: number): string {
  const i = snapshot.instances[index]!;
  if (i.currentJob) return `↻ ${i.currentJob.job}`;
  switch (i.processState) {
    case "running":
      return "空闲";
    case "stopped":
      return "已停止";
    case "starting":
      return "启动中…";
    case "stopping":
      return "停止中…";
    default:
      return i.processState;
  }
}

/** 快照 → 托盘投影器。原生托盘接口按内容去重——内容未变绝不重复调用。 */
export class TrayProjection {
  #instanceIds: string[] = [];
  // 重复调用原生 setIcon/setTooltip/setMenu 会让应用被反复激活，appMode 窗口随之
  // "闪出来"（Owner 2026-10-26 实证：一有动静窗口就跳前台）。内容未变时必须静默。
  #lastIcon: string | null = null;
  #platform: string = process.platform;
  #lastTooltip: string | null = null;
  #lastMenu: string | null = null;

  constructor(
    private readonly tray: CreateTrayHandle,
    private readonly actions: TrayActions,
  ) {}

  async update(snapshot: Snapshot): Promise<void> {
    this.#instanceIds = snapshot.instances.map((i) => i.id);
    const running = snapshot.instances.filter(
      (i) => i.processState === "running" || i.processState === "starting",
    );
    const busy = running.filter((i) => i.currentJob !== null).length;
    const iconText = busy > 0 ? `▶${running.length}↻${busy}` : `▶${running.length}`;
    if (iconText !== this.#lastIcon) {
      this.#lastIcon = iconText;
      const icon = this.#iconOf(iconText);
      if (icon) await this.tray.setIcon(icon);
    }
    const tooltip = JSON.stringify({
      title: "GH Runner",
      description:
        snapshot.instances
          .map((_, index) => `${snapshot.instances[index]!.name}: ${stateLabel(snapshot, index)}`)
          .join("\n") || "尚无实例",
    });
    if (tooltip !== this.#lastTooltip) {
      this.#lastTooltip = tooltip;
      await this.tray.setTooltip(JSON.parse(tooltip));
    }
    const menu = JSON.stringify(this.#menuOf(snapshot));
    if (menu !== this.#lastMenu) {
      this.#lastMenu = menu;
      await this.tray.setMenu(JSON.parse(menu));
    }
  }

  #iconOf(text: string): Icon | null {
    if (this.#platform === "darwin") {
      return { "darwin-icon-text": { type: "file", path: trayTemplatePath(), isTemplate: true, text } };
    }
    if (this.#platform === "win32") {
      return { "win32-icon-text": { type: "file", path: trayColorPath(), text } };
    }
    return { "text-only": text };
  }

  /** onMenuClick 事件入口；返回是否已消费。 */
  handleMenuClick(itemId: number): boolean {
    if (itemId === ITEM_OPEN) {
      this.actions.openWindow();
      return true;
    }
    if (itemId === ITEM_QUIT) {
      this.actions.quit();
      return true;
    }
    const index = itemId - ITEM_INSTANCE_BASE;
    const id = this.#instanceIds[index];
    if (id) {
      this.actions.openInstance(id);
      return true;
    }
    return false;
  }

  #menuOf(snapshot: Snapshot): CreateTrayMenu {
    const items: CreateTrayMenu["items"] = [
      { type: "item", id: ITEM_OPEN, title: "打开控制面板", primaryEvent: true },
    ];
    if (snapshot.instances.length > 0) items.push({ type: "separator" });
    snapshot.instances.forEach((instance, index) => {
      items.push({
        type: "item",
        id: ITEM_INSTANCE_BASE + index,
        title: `${instance.name} — ${stateLabel(snapshot, index)}`,
      });
    });
    items.push({ type: "separator" });
    items.push({ type: "item", id: ITEM_QUIT, title: "退出 GH Runner" });
    return { items };
  }
}
