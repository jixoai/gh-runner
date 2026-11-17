import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransportTimeoutError, type CreateTrayHandle, type CreateTrayMenu, type Icon, type TrayTooltip } from "opentray";
import { TrayProjection } from "../src/tray.ts";
import type { InstanceView, Snapshot } from "../src/types.ts";

const projections: TrayProjection[] = [];

function instance(id: string, overrides: Partial<InstanceView> = {}): InstanceView {
  return {
    id, dir: `/runners/${id}`, name: id, agentId: 1, orgUrl: null, workFolder: null,
    configured: true, processState: "running", connectionState: "online", external: true,
    autoStart: false, pid: 1234, currentJob: null, lastResult: null, lastError: null,
    log: [], logTotal: 0, ...overrides,
  };
}

function snapshot(instances: InstanceView[] = []): Snapshot {
  return {
    seq: 1, now: "2026-11-17T01:00:00Z", platform: "win32", arch: "x64", instances,
    task: { kind: "none", status: "ok", message: null }, packages: [], download: null,
  };
}

function fixture() {
  const tray = {
    setIcon: vi.fn(async (_icon: Icon) => {}),
    setTooltip: vi.fn(async (_tooltip: TrayTooltip) => {}),
    setMenu: vi.fn(async (_menu: CreateTrayMenu) => {}),
  };
  const actions = { openWindow: vi.fn(), openInstance: vi.fn(), quit: vi.fn() };
  const projection = new TrayProjection(tray as unknown as CreateTrayHandle, actions);
  projections.push(projection);
  return { tray, actions, projection };
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  for (const projection of projections.splice(0)) projection.destroy();
  vi.useRealTimers();
});

describe("托盘状态同步", () => {
  it("成功后按内容去重，不重复调用原生接口", async () => {
    const { tray, projection } = fixture();
    await projection.update(snapshot([instance("runner")]));
    await projection.update(snapshot([instance("runner")]));
    expect(tray.setIcon).toHaveBeenCalledOnce();
    expect(tray.setTooltip).toHaveBeenCalledOnce();
    expect(tray.setMenu).toHaveBeenCalledOnce();
  });

  it.each(["setIcon", "setTooltip", "setMenu"] as const)("%s 超时后自动重试，不要求新快照", async (method) => {
    const { tray, projection } = fixture();
    tray[method].mockRejectedValueOnce(new TransportTimeoutError("tray-test", 5000));
    const pending = projection.update(snapshot([instance("runner")]));
    await vi.advanceTimersByTimeAsync(0);
    for (const operation of Object.values(tray)) expect(operation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(499);
    expect(tray[method]).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(tray[method]).toHaveBeenCalledTimes(2);
    for (const [name, operation] of Object.entries(tray)) {
      if (name !== method) expect(operation).toHaveBeenCalledOnce();
    }
  });

  it("并发快照共用串行更新，跳过中间状态并最终应用最新状态", async () => {
    const { tray, projection } = fixture();
    let releaseIcon!: () => void;
    tray.setIcon.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseIcon = resolve; }));
    const first = projection.update(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    const second = projection.update(snapshot([instance("old")]));
    const latest = projection.update(snapshot([instance("latest-one"), instance("latest-two")]));
    expect(second).toBe(first);
    expect(latest).toBe(first);
    expect(tray.setIcon).toHaveBeenCalledOnce();
    expect(tray.setTooltip).not.toHaveBeenCalled();
    expect(tray.setMenu).not.toHaveBeenCalled();
    releaseIcon();
    await first;
    expect(tray.setIcon).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(tray.setIcon.mock.calls.at(-1))).toContain("▶2");
    expect(tray.setTooltip).toHaveBeenCalledOnce();
    expect(tray.setMenu).toHaveBeenCalledOnce();
    const menu = JSON.stringify(tray.setMenu.mock.calls[0]);
    expect(menu).toContain("latest-one");
    expect(menu).toContain("latest-two");
    expect(menu).not.toContain("old");
  });

  it("退避期间收到新快照时重试最新内容，而不是失败的旧状态", async () => {
    const { tray, projection } = fixture();
    tray.setIcon.mockRejectedValueOnce(new TransportTimeoutError("icon-test", 5000));
    const pending = projection.update(snapshot([instance("old")]));
    await vi.advanceTimersByTimeAsync(0);
    const latest = projection.update(snapshot([instance("one"), instance("two")]));
    expect(latest).toBe(pending);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(tray.setIcon).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(tray.setIcon.mock.calls.at(-1))).toContain("▶2");
    expect(JSON.stringify(tray.setMenu.mock.calls.at(-1))).toContain("two");
  });

  it("持续失败最多重试三次，错误保留具体操作和原始超时，之后仍可重新同步", async () => {
    const { tray, projection } = fixture();
    const timeout = new TransportTimeoutError("menu-timeout", 5000);
    tray.setMenu.mockRejectedValue(timeout);
    const failed = projection.update(snapshot([instance("runner")])).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await failed;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw error;
    expect(error.message).toContain("setMenu");
    expect(error.message).toContain("已重试 3 次");
    expect(error.errors[0].cause).toBe(timeout);
    expect(tray.setMenu).toHaveBeenCalledTimes(4);
    expect(tray.setIcon).toHaveBeenCalledOnce();
    expect(tray.setTooltip).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    tray.setMenu.mockResolvedValue(undefined);
    await projection.update(snapshot([instance("runner")]));
    expect(tray.setMenu).toHaveBeenCalledTimes(5);
  });

  it("失败期间持续收到快照不会重置重试预算", async () => {
    const { tray, projection } = fixture();
    tray.setIcon.mockRejectedValue(new TransportTimeoutError("icon-timeout", 5000));
    const pending = projection.update(snapshot()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    for (const [index, delay] of [500, 1000, 2000].entries()) {
      void projection.update(snapshot([instance(`runner-${index}`)])).catch(() => {});
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(await pending).toBeInstanceOf(AggregateError);
    expect(tray.setIcon).toHaveBeenCalledTimes(4);
  });

  it("多个字段同时失败时逐项报告原因，成功字段不重复写入", async () => {
    const { tray, projection } = fixture();
    const iconTimeout = new TransportTimeoutError("icon-timeout", 5000);
    const menuTimeout = new TransportTimeoutError("menu-timeout", 5000);
    tray.setIcon.mockRejectedValue(iconTimeout);
    tray.setMenu.mockRejectedValue(menuTimeout);
    const failed = projection.update(snapshot()).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await failed;
    if (!(error instanceof AggregateError)) throw error;
    expect(error.message).toContain("setIcon");
    expect(error.message).toContain("setMenu");
    expect(error.errors.map((failure: Error) => failure.cause)).toEqual([iconTimeout, menuTimeout]);
    expect(tray.setIcon).toHaveBeenCalledTimes(4);
    expect(tray.setTooltip).toHaveBeenCalledOnce();
    expect(tray.setMenu).toHaveBeenCalledTimes(4);
  });

  it("超时可能已修改原生状态，因此回到历史值时仍然重新写入", async () => {
    const { tray, projection } = fixture();
    await projection.update(snapshot());
    tray.setIcon.mockRejectedValueOnce(new TransportTimeoutError("uncertain-icon", 5000));
    const pending = projection.update(snapshot([instance("runner")]));
    await vi.advanceTimersByTimeAsync(0);
    void projection.update(snapshot());
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(tray.setIcon).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(tray.setIcon.mock.calls.at(-1))).toContain("▶0");
  });

  it("菜单尚未确认时保留原有实例点击映射，成功后再切换", async () => {
    const { tray, actions, projection } = fixture();
    await projection.update(snapshot([instance("old")]));
    tray.setMenu.mockRejectedValueOnce(new TransportTimeoutError("menu-test", 5000));
    const pending = projection.update(snapshot([instance("latest")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(projection.handleMenuClick(100)).toBe(true);
    expect(actions.openInstance).toHaveBeenLastCalledWith("old");
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    projection.handleMenuClick(100);
    expect(actions.openInstance).toHaveBeenLastCalledWith("latest");
  });

  it("菜单文字相同但实例身份变化时仍然更新点击映射", async () => {
    const { tray, actions, projection } = fixture();
    await projection.update(snapshot([instance("old", { name: "same-name" })]));
    await projection.update(snapshot([instance("latest", { name: "same-name" })]));
    expect(tray.setMenu).toHaveBeenCalledOnce();
    projection.handleMenuClick(100);
    expect(actions.openInstance).toHaveBeenCalledWith("latest");
  });

  it("退出取消退避计时器，之后不再触碰原生托盘", async () => {
    const { tray, projection } = fixture();
    tray.setIcon.mockRejectedValue(new TransportTimeoutError("stop-retry", 5000));
    const pending = projection.update(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    projection.destroy();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    await projection.update(snapshot([instance("late")]));
    await vi.advanceTimersByTimeAsync(10000);
    expect(tray.setIcon).toHaveBeenCalledOnce();
    expect(tray.setTooltip).toHaveBeenCalledOnce();
    expect(tray.setMenu).toHaveBeenCalledOnce();
  });

  it("退出时正在进行的请求无论成功还是失败，都不会继续更新其他字段", async () => {
    for (const rejected of [false, true]) {
      const { tray, projection } = fixture();
      let finishIcon!: () => void;
      tray.setIcon.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
        finishIcon = rejected ? () => reject(new Error("connection closed")) : resolve;
      }));
      const pending = projection.update(snapshot());
      await vi.advanceTimersByTimeAsync(0);
      projection.destroy();
      finishIcon();
      await pending;
      expect(tray.setTooltip).not.toHaveBeenCalled();
      expect(tray.setMenu).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("打开与退出菜单保持正常路由，未知菜单项不被误消费", async () => {
    const { actions, projection } = fixture();
    expect(projection.handleMenuClick(1)).toBe(true);
    expect(actions.openWindow).toHaveBeenCalledOnce();
    expect(projection.handleMenuClick(2)).toBe(true);
    expect(actions.quit).toHaveBeenCalledOnce();
    expect(projection.handleMenuClick(999)).toBe(false);
  });
});
