import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportTimeoutError, type TrayExtensionContext } from "opentray";
import { WebviewExt } from "@opentray/ext-webview";
import { UiHost, extendWebview } from "../src/window.ts";

vi.hoisted(() => vi.stubGlobal("__APP_VERSION__", "0.0.0-test"));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn(async () => "<html>startup-test</html>") }));

function makeHost() {
  const win = {
    show: vi.fn(async () => {}),
    focus: vi.fn(async () => {}),
    setMinimumSize: vi.fn(async () => {}),
    listen: vi.fn(),
  };
  const createWebviewWindow = vi.fn(() => win);
  const ui = new UiHost(
    {} as never,
    { createWebviewWindow } as never,
    () => {},
    async () => null,
    async () => null,
    async () => {},
  );
  return { ui, win, createWebviewWindow };
}

afterEach(() => vi.restoreAllMocks());

describe("窗口启动恢复", () => {
  it("连续点击在首次 show 完成前共用一次初始化", async () => {
    const { ui, win, createWebviewWindow } = makeHost();
    let finishShow!: () => void;
    win.show.mockImplementationOnce(() => new Promise<void>((resolve) => { finishShow = resolve; }));
    try {
      const first = ui.open();
      const second = ui.open();
      expect(first).toBe(second);
      await vi.waitFor(() => expect(win.show).toHaveBeenCalledOnce());
      finishShow();
      await Promise.all([first, second]);
      expect(createWebviewWindow).toHaveBeenCalledOnce();
      expect(win.focus).not.toHaveBeenCalled();
      expect(win.setMinimumSize).toHaveBeenCalledOnce();
    } finally {
      await ui.destroy();
    }
  });

  it("首次显示超时后允许重新初始化，不复用半初始化窗口", async () => {
    const { ui, win, createWebviewWindow } = makeHost();
    win.show.mockRejectedValueOnce(new TransportTimeoutError("show-test", 30_000));
    try {
      await expect(ui.open()).rejects.toBeInstanceOf(TransportTimeoutError);
      await ui.open();
      expect(createWebviewWindow).toHaveBeenCalledTimes(2);
      expect(win.setMinimumSize).toHaveBeenCalledOnce();
      expect(win.focus).not.toHaveBeenCalled();
    } finally {
      await ui.destroy();
    }
  });

  it("已创建窗口的临时 show 超时不触发重建", async () => {
    const { ui, win, createWebviewWindow } = makeHost();
    try {
      await ui.open();
      win.show.mockRejectedValueOnce(new TransportTimeoutError("restore-test", 5_000));
      await expect(ui.open()).rejects.toBeInstanceOf(TransportTimeoutError);
      expect(createWebviewWindow).toHaveBeenCalledOnce();
      await ui.open();
      expect(createWebviewWindow).toHaveBeenCalledOnce();
      expect(win.focus).toHaveBeenCalledOnce();
    } finally {
      await ui.destroy();
    }
  });
});

describe("原生 WebView 启动预算", () => {
  it("仅延长 bootstrap show 的预算，不改变普通调用、关闭或更长的预算", async () => {
    let wrappedContext!: TrayExtensionContext;
    vi.spyOn(WebviewExt, "extend").mockImplementation((_tray, context) => {
      wrappedContext = context;
      return {} as never;
    });
    const request = vi.fn(async () => ({ kind: "immediate", events: [] }));
    const context = { request } as unknown as TrayExtensionContext;
    const tray = {
      extend: vi.fn((extension: typeof WebviewExt) => extension.extend({} as never, context, undefined)),
    };
    extendWebview(tray as never);
    const show = { type: "show", html: "<html></html>" };
    await wrappedContext.request(show, { deadlineMs: 10_000 });
    expect(request).toHaveBeenLastCalledWith(show, { deadlineMs: 30_000 });
    await wrappedContext.request(show, { deadlineMs: 60_000 });
    expect(request).toHaveBeenLastCalledWith(show, { deadlineMs: 60_000 });
    await wrappedContext.request({ type: "show" });
    expect(request).toHaveBeenLastCalledWith({ type: "show" }, undefined);
    await wrappedContext.request({ type: "evaluate", js: "1" }, { deadlineMs: 5_000 });
    expect(request).toHaveBeenLastCalledWith({ type: "evaluate", js: "1" }, { deadlineMs: 5_000 });
    await wrappedContext.request({ type: "destroy" }, { deadlineMs: 2_000 });
    expect(request).toHaveBeenLastCalledWith({ type: "destroy" }, { deadlineMs: 2_000 });
  });
});
