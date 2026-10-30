import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrayActions } from "../src/tray.ts";

const mocks = vi.hoisted(() => {
  vi.stubGlobal("__APP_VERSION__", "0.0.0-test");
  const tray = {
    destroy: vi.fn(async () => {}),
    onMenuClick: vi.fn((_handler: (event: { itemId: number }) => void) => vi.fn()),
    onConnectionDead: vi.fn((_handler: (error: Error) => void) => vi.fn()),
  };
  return {
    tray,
    createTray: vi.fn(async (_options: unknown, _runtime: unknown) => tray),
    actions: null as TrayActions | null,
    fleet: {
      boot: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
      onSnapshot: vi.fn((_handler: (snapshot: never) => void) => vi.fn()),
      reportPickerFailure: vi.fn(),
    },
    ui: { open: vi.fn(async () => {}), destroy: vi.fn(async () => {}), push: vi.fn() },
    projection: { update: vi.fn(async () => {}), handleMenuClick: vi.fn() },
  };
});

vi.mock("opentray", () => ({ createTray: mocks.createTray }));
vi.mock("@opentray/ext-dialog", () => ({ attachDialog: vi.fn() }));
vi.mock("@opentray/ext-opener", () => ({ attachOpener: () => ({}) }));
vi.mock("../src/branding.ts", () => ({ appIcon: () => [] }));
vi.mock("../src/config.ts", () => ({ configDir: () => "/test/config" }));
vi.mock("../src/fleet.ts", () => ({ Fleet: class { constructor() { return mocks.fleet; } } }));
vi.mock("../src/window.ts", () => ({
  UiHost: class { constructor() { return mocks.ui; } },
  extendWebview: () => ({}),
}));
vi.mock("../src/tray.ts", () => ({
  TrayProjection: class {
    constructor(_tray: unknown, actions: TrayActions) {
      mocks.actions = actions;
      return mocks.projection;
    }
  },
}));

const originalArgv = process.argv;
let previousSignals: Map<"SIGINT" | "SIGTERM", ReturnType<typeof process.listeners>>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.argv = [process.execPath, "/test/gh-runner.mjs"];
  previousSignals = new Map(["SIGINT", "SIGTERM"].map((signal) => [
    signal as "SIGINT" | "SIGTERM", process.listeners(signal),
  ]));
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgv;
  for (const [signal, existing] of previousSignals) {
    for (const listener of process.listeners(signal)) {
      if (!existing.includes(listener)) process.removeListener(signal, listener);
    }
  }
  vi.restoreAllMocks();
});

describe("真实入口退出接线", () => {
  it("禁用底层复活，系统退出导致连接关闭时同时结束宿主", async () => {
    await import("../src/main.ts");
    await vi.waitFor(() => expect(mocks.tray.onConnectionDead).toHaveBeenCalledOnce());
    expect(mocks.createTray.mock.calls[0]?.[1]).toMatchObject({ recovery: { enabled: false } });
    const onDead = mocks.tray.onConnectionDead.mock.calls[0]![0];
    onDead(new Error("broker connection closed"));
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledExactlyOnceWith(0));
    expect(mocks.fleet.destroy).toHaveBeenCalledOnce();
    expect(mocks.ui.destroy).toHaveBeenCalledOnce();
    expect(mocks.tray.destroy).toHaveBeenCalledOnce();
  });

  it("退出菜单连点与迟到的打开事件不会重复清理或重新开窗", async () => {
    await import("../src/main.ts");
    await vi.waitFor(() => expect(mocks.tray.onConnectionDead).toHaveBeenCalledOnce());
    mocks.actions!.quit();
    mocks.actions!.openWindow();
    mocks.actions!.quit();
    mocks.tray.onConnectionDead.mock.calls[0]![0](new Error("broker connection closed"));
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledExactlyOnceWith(0));
    expect(mocks.ui.open).not.toHaveBeenCalled();
    expect(mocks.fleet.destroy).toHaveBeenCalledOnce();
    expect(mocks.ui.destroy).toHaveBeenCalledOnce();
    expect(mocks.tray.destroy).toHaveBeenCalledOnce();
    for (const subscribe of [mocks.fleet.onSnapshot, mocks.tray.onMenuClick, mocks.tray.onConnectionDead]) {
      expect(subscribe.mock.results[0]!.value).toHaveBeenCalledOnce();
    }
  });
});
