/*
 * 窗口门控回归（2026-10-27 闪窗事故）：
 * 对隐藏窗口 evaluate 会把它重新显示并抢焦点（bisect 实证：evaluate 是唯一有此副作用
 * 的宿主原语）。Windows 上 X 关闭可能不发 visibleChange，所以门控必须 fail-closed——
 * 每轮推送前以原生 isVisible() 实证，隐藏期推送/命令轮询全静默，仅 1s 慢轮询探测复显。
 * 本测试用假窗口句柄模拟「事件缺位」场景，锁死该行为。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Snapshot } from "../src/types.ts";

vi.stubGlobal("__APP_VERSION__", "0.0.0-test");
// open() 读取打包期注入的 dist/ui/index.html；门控测试与页面内容无关。
vi.mock("node:fs/promises", () => ({ readFile: vi.fn(async () => "<html>gating-test</html>") }));

type Listener = (event: { payload: unknown }) => void;

/** 假窗口句柄：evaluate 计数即"窗口被激活的风险次数"。 */
function fakeWindow() {
  const listeners = new Map<string, Listener[]>();
  const evaluated: string[] = [];
  const state = { visible: true, connectionDead: false };
  const win = {
    connectionDead: state.connectionDead, // UiHost 读的是属性快照，测试里手动同步
    show: vi.fn(async () => {}),
    focus: vi.fn(async () => {}),
    setMinimumSize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    isVisible: vi.fn(async () => state.visible),
    evaluate: vi.fn(async (js: string) => {
      if (!state.visible) throw new Error("evaluate on hidden window must never happen");
      evaluated.push(js);
    }),
    drainIpcMessages: vi.fn(async () => [] as unknown[]),
    listen: (type: string, cb: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), cb]);
    },
  };
  return {
    win,
    state,
    evaluated,
    fire(type: string, payload: unknown) {
      for (const cb of listeners.get(type) ?? []) cb({ payload });
    },
  };
}

function fakeFleet() {
  return {
    view: () => null,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    setAutoStart: vi.fn(async () => {}),
    register: vi.fn(async () => {}),
    downloadLatest: vi.fn(async () => {}),
    importPackage: vi.fn(async () => {}),
  } as never;
}

function snapshot(seq = 1): Snapshot {
  return {
    seq,
    now: new Date().toISOString(),
    platform: "darwin",
    arch: "arm64",
    instances: [],
    task: { kind: "none", status: "ok", message: null },
    packages: [],
    download: null,
  };
}

const flushDebounce = () => vi.advanceTimersByTimeAsync(200);

describe("UiHost 可见性门控（闪窗回归）", () => {
  let UiHost: (typeof import("../src/window.ts"))["UiHost"];

  beforeEach(async () => {
    vi.useFakeTimers();
    ({ UiHost } = await import("../src/window.ts"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

    const makeHost = async () => {
      const f = fakeWindow();
      const ui = new UiHost(
        fakeFleet(),
        { createWebviewWindow: () => f.win } as never,
        () => {},
        async () => null,
        async () => null,
        async () => {},
      );
      await ui.open();
      await vi.advanceTimersByTimeAsync(200); // 首屏推送走完 120ms 去抖
      return { f, ui };
    };

  it("事件缺位（Windows X 关闭）：隐藏后推送前 isVisible 实证拦截，绝不 evaluate", async () => {
    const { f, ui } = await makeHost();

    // 模拟 Windows：句柄实际已隐藏，但 visibleChange 事件缺位
    f.state.visible = false;
    f.win.isVisible.mockClear();

    ui.push(snapshot(2));
    await flushDebounce();
    expect(f.win.isVisible).toHaveBeenCalled(); // fail-closed：推送前实证
    expect(f.evaluated.length).toBe(0); // 零 evaluate → 零激活

    // 持续动静也不再触碰
    ui.push(snapshot(3));
    await flushDebounce();
    expect(f.evaluated.length).toBe(0);
  });

  it("visibleChange 事件路径（macOS）：事件到达即刻静默", async () => {
    const { f, ui } = await makeHost();
    f.fire("visibleChange", { visible: false });
    ui.push(snapshot(2));
    await flushDebounce();
    expect(f.evaluated.length).toBe(0);
  });

  it("closed 事件：视为隐藏", async () => {
    const { f, ui } = await makeHost();
    f.fire("closed", { visible: false });
    ui.push(snapshot(2));
    await flushDebounce();
    expect(f.evaluated.length).toBe(0);
  });

  it("可见时推送正常发生（对照：门控不误伤）", async () => {
    const { f, ui } = await makeHost();
    ui.push(snapshot(2));
    await flushDebounce();
    expect(f.evaluated.length).toBeGreaterThan(0);
    expect(f.evaluated.at(-1)).toContain('"kind":"summary"');
  });

  it("复显探测：隐藏期 1s 慢轮询发现 isVisible 翻真后全量重推", async () => {
    const { f, ui } = await makeHost();
    f.state.visible = false; // 事件缺位式隐藏
    ui.push(snapshot(2));
    await flushDebounce();
    expect(f.evaluated.length).toBe(0);

    f.state.visible = true; // 用户从任务栏/Alt-Tab 自行复显
    await vi.advanceTimersByTimeAsync(1_200); // 150ms ×7 轮询阈值
    expect(f.evaluated.length).toBeGreaterThan(0); // 恢复推送
    const summary = f.evaluated.at(-1)!;
    expect(summary).toContain('"kind":"summary"');
  });

  it("隐藏期命令轮询静默：drainIpcMessages 不再每 150ms 打原生往返", async () => {
    const { f, ui } = await makeHost();
    // 先经一次推送实证让缓存翻转（与真实时序一致：动静发现隐藏，此后全静默）
    f.state.visible = false;
    ui.push(snapshot(2));
    await flushDebounce();
    f.win.drainIpcMessages.mockClear();
    f.win.isVisible.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.win.drainIpcMessages.mock.calls.length).toBe(0); // 全静默
    expect(f.win.isVisible.mock.calls.length).toBeGreaterThan(0); // 但复显探测仍在
  });

  it("批量授权等待时 IPC 仍可接收取消命令，不记录或保留命令中的 Token", async () => {
    const f = fakeWindow();
    const fleet = { registerBatch: vi.fn(() => new Promise<void>(() => {})), cancelAuthorization: vi.fn() };
    const ui = new UiHost(fleet as never, { createWebviewWindow: () => f.win } as never, () => {}, async () => null, async () => null, async () => {});
    await ui.open();
    const command = { type: "register-batch", method: "token", clientId: "", token: "DO_NOT_LOG", targetUrl: "https://github.com/acme", packagePath: "/tmp/pkg", runners: [] };
    f.win.drainIpcMessages.mockResolvedValueOnce([{ payload: command }]);
    await vi.advanceTimersByTimeAsync(160);
    expect(fleet.registerBatch).toHaveBeenCalledOnce();
    expect(command.token).toBe("");
    f.win.drainIpcMessages.mockResolvedValueOnce([{ payload: { type: "cancel-authorization" } }]);
    await vi.advanceTimersByTimeAsync(160);
    expect(fleet.cancelAuthorization).toHaveBeenCalledOnce();
    await ui.destroy();
  });
});
