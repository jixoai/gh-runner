import { afterEach, describe, expect, it, vi } from "vitest";
import { AppLifecycle } from "../src/lifecycle.ts";

afterEach(() => vi.useRealTimers());

describe("应用退出生命周期", () => {
  it("退出立即封锁重开，重复退出只清理一次，按顺序释放资源", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const reportError = vi.fn();
    const lifecycle = new AppLifecycle([
      () => { order.push("unsubscribe"); },
      async () => { order.push("fleet"); },
      async () => { order.push("window"); },
      async () => { order.push("tray"); },
    ], exit, reportError);
    const first = lifecycle.shutdown();
    expect(lifecycle.stopping).toBe(true);
    expect(lifecycle.shutdown()).toBe(first);
    await first;
    await lifecycle.shutdown();
    expect(order).toEqual(["unsubscribe", "fleet", "window", "tray"]);
    expect(reportError).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("原生连接已关闭导致部分清理失败时仍然完成退出", async () => {
    const failure = new Error("broker connection closed");
    const remainingCleanup = vi.fn(async () => {});
    const exit = vi.fn();
    const reportError = vi.fn();
    const lifecycle = new AppLifecycle([
      async () => { throw failure; },
      remainingCleanup,
    ], exit, reportError);
    await lifecycle.shutdown();
    expect(reportError).toHaveBeenCalledWith(failure);
    expect(remainingCleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("原生清理卡住时限时退出，迟到的完成不能二次退出或继续重建", async () => {
    vi.useFakeTimers();
    let finishCleanup!: () => void;
    const remainingCleanup = vi.fn(async () => {});
    const exit = vi.fn();
    const lifecycle = new AppLifecycle([
      () => new Promise<void>((resolve) => { finishCleanup = resolve; }),
      remainingCleanup,
    ], exit, vi.fn());
    const shutdown = lifecycle.shutdown();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    finishCleanup();
    await shutdown;
    expect(exit).toHaveBeenCalledOnce();
    expect(remainingCleanup).not.toHaveBeenCalled();
  });
});
