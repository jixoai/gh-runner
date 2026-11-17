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
const RETRY_DELAYS_MS = [500, 1000, 2000];
const TRAY_METHODS = { icon: "setIcon", tooltip: "setTooltip", menu: "setMenu" } as const;

interface TrayState {
  icon: string;
  tooltip: string;
  menu: string;
  instanceIds: string[];
}

export interface TrayActions {
  openWindow(): void;
  openInstance(id: string): void;
  quit(): void;
}

function stateLabel(snapshot: Snapshot, index: number): string {
  const i = snapshot.instances[index]!;
  if (i.processState === "running" || i.processState === "starting") {
    if (i.connectionState === "conflict") return "会话冲突 · 重试中";
    if (i.connectionState === "unknown") return "连接待确认";
    if (i.connectionState !== "online") return "连接中…";
  }
  if (i.currentJob && i.processState === "running") return `↻ ${i.currentJob.job}`;
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
  // 托盘调用去重：2026-10-27 bisect 实证 setIcon/setTooltip/setMenu（含内容变化时）
  // 不会激活隐藏窗口（闪窗唯一根因是对隐藏窗口 evaluate，见 window.ts）——去重保留为
  // 调用卫生（省原生往返），不再承担闪窗修复职责。
  #platform: string = process.platform;
  #applied: Record<keyof typeof TRAY_METHODS, string | null> = { icon: null, tooltip: null, menu: null };
  #desired: TrayState | null = null;
  #updating: Promise<void> | null = null;
  #destroyed = false;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #resumeRetry: (() => void) | null = null;

  constructor(
    private readonly tray: CreateTrayHandle,
    private readonly actions: TrayActions,
  ) {}

  update(snapshot: Snapshot): Promise<void> {
    if (this.#destroyed) return Promise.resolve();
    const running = snapshot.instances.filter(
      (i) => i.processState === "running" && i.connectionState === "online",
    );
    const busy = running.filter((i) => i.currentJob !== null).length;
    const iconText = busy > 0 ? `▶${running.length}↻${busy}` : `▶${running.length}`;
    const tooltip = JSON.stringify({
      title: "GH Runner",
      description:
        snapshot.instances
          .map((_, index) => `${snapshot.instances[index]!.name}: ${stateLabel(snapshot, index)}`)
          .join("\n") || "尚无实例",
    });
    this.#desired = {
      icon: iconText,
      tooltip,
      menu: JSON.stringify(this.#menuOf(snapshot)),
      instanceIds: snapshot.instances.map((instance) => instance.id),
    };
    this.#updating ??= Promise.resolve().then(() => this.#flush());
    return this.#updating;
  }

  destroy(): void {
    this.#destroyed = true;
    this.#desired = null;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#resumeRetry?.();
    this.#resumeRetry = null;
  }

  async #flush(): Promise<void> {
    let retries = 0;
    try {
      while (!this.#destroyed && this.#desired) {
        const target = this.#desired;
        const failures = await this.#apply(target);
        if (this.#destroyed) return;
        if (failures.length > 0) {
          const delay = RETRY_DELAYS_MS[retries];
          if (delay === undefined) {
            throw new AggregateError(failures, `托盘同步失败（已重试 ${retries} 次）：${failures.map((error) => error.message).join("、")}`);
          }
          retries += 1;
          await new Promise<void>((resolve) => {
            this.#resumeRetry = resolve;
            this.#retryTimer = setTimeout(() => {
              this.#retryTimer = null;
              this.#resumeRetry = null;
              resolve();
            }, delay);
            this.#retryTimer.unref?.();
          });
        } else if (target === this.#desired) {
          return;
        }
      }
    } finally {
      this.#updating = null;
    }
  }

  async #apply(target: TrayState): Promise<Error[]> {
    const failures: Error[] = [];
    for (const field of ["icon", "tooltip", "menu"] as const) {
      if (this.#destroyed || target !== this.#desired) break;
      if (target[field] !== this.#applied[field]) {
        try {
          if (field === "icon") {
            const icon = this.#iconOf(target.icon);
            if (icon) await this.tray.setIcon(icon);
          } else if (field === "tooltip") {
            await this.tray.setTooltip(JSON.parse(target.tooltip));
          } else {
            await this.tray.setMenu(JSON.parse(target.menu));
          }
          if (this.#destroyed) break;
          this.#applied[field] = target[field];
        } catch (error) {
          this.#applied[field] = null;
          failures.push(new Error(`${TRAY_METHODS[field]} 更新失败`, { cause: error }));
        }
      }
      if (field === "menu" && target.menu === this.#applied.menu) this.#instanceIds = target.instanceIds;
    }
    return failures;
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
