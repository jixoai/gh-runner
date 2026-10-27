/*
 * 选择器失败可见性回归（2026-10-27 用户新 Mac 实证）：
 * ext-dialog 桥接失败（dialog_presentation_failed / bridge-output-unrecognized）此前只
 * console.error，UI 毫无响应。宿主侧失败必须写进 task 通道——UI 的 announceTask 会把
 * error 态 toast 出来。本测试锁死 reportPickerFailure 的快照语义。
 */
import { describe, it, expect } from "vitest";
import { Fleet } from "../src/fleet.ts";

describe("fleet.reportPickerFailure（选择器失败可见性）", () => {
  it("失败写进 task 通道并立即出快照（UI toast 数据源）", () => {
    const fleet = new Fleet();
    const seen: Array<{ kind: string; status: string; message: string | null }> = [];
    fleet.onSnapshot((s) => seen.push({ ...s.task }));
    fleet.reportPickerFailure("本地包选择", new Error("bridge died"), "试试别的路径");
    const snap = fleet.snapshot();
    expect(snap.task.kind).toBe("register");
    expect(snap.task.status).toBe("error");
    expect(snap.task.message).toContain("bridge died");
    expect(snap.task.message).toContain("试试别的路径");
    expect(seen.length).toBeGreaterThanOrEqual(2); // onSnapshot 初次推送 + emit
    expect(seen.at(-1)!.status).toBe("error");
  });

  it("非 Error 抛出物（字符串等）也能成句", () => {
    const fleet = new Fleet();
    fleet.reportPickerFailure("runner 目录选择", "boom-string");
    expect(fleet.snapshot().task.message).toContain("boom-string");
  });
});
