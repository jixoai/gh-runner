/*
 * 原始需求（2026-10-24）：挂在托盘里面的工具——菜单栏常驻，图标反映在跑数量，
 * 菜单直达每个实例（点击打开面板）与主窗口/退出。
 *
 * 正交意图：
 * 1. 快照 → 托盘图标文案 + tooltip + 菜单的投影。
 * 2. 菜单事件路由：实例项 id ↔ 实例 id 映射收在本类内。
 */

import type { CreateTrayHandle, CreateTrayMenu } from "opentray";
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

/** 快照 → 托盘投影器。每次 update() 全量重画图标/tooltip/菜单。 */
export class TrayProjection {
  #instanceIds: string[] = [];

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
    await this.tray.setIcon({
      "text-only": busy > 0 ? `▶${running.length}↻${busy}` : `▶${running.length}`,
    });
    await this.tray.setTooltip({
      title: "GH Runner",
      description:
        snapshot.instances
          .map((_, index) => `${snapshot.instances[index]!.name}: ${stateLabel(snapshot, index)}`)
          .join("\n") || "尚无实例",
    });
    await this.tray.setMenu(this.#menuOf(snapshot));
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
