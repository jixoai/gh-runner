import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async (original) => {
  const { promisify } = await import("node:util");
  return { ...await original<typeof import("node:child_process")>(), execFile: Object.assign(vi.fn(), { [promisify.custom]: io.exec }) };
});
vi.mock("../src/platform.ts", () => ({ IS_WIN: false }));

import { processStartedAt } from "../src/discover.ts";

beforeEach(() => { vi.clearAllMocks(); });

describe("POSIX process start time", () => {
  it("解析 ps 的本地启动时间并固定输出语言", async () => {
    const started = "Sat Nov 14 14:19:31 2026";
    io.exec.mockResolvedValue({ stdout: `  ${started}\n` });
    expect(await processStartedAt(1234)).toBe(Date.parse(started));
    expect(io.exec).toHaveBeenCalledWith("ps", ["-p", "1234", "-o", "lstart="], expect.objectContaining({ timeout: 5000, env: expect.objectContaining({ LC_ALL: "C" }) }));
  });

  it.each(["", "invalid"])("缺少启动时间时返回 null：%s", async (stdout) => {
    io.exec.mockResolvedValue({ stdout });
    expect(await processStartedAt(1234)).toBeNull();
  });

  it("无法读取进程时返回 null", async () => {
    io.exec.mockRejectedValue(new Error("No such process"));
    expect(await processStartedAt(1234)).toBeNull();
  });
});
