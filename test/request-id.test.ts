import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestId } from "../src/ui-app/lib/request-id.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("原生窗口请求标识", () => {
  it("不依赖安全上下文中的 crypto.randomUUID", () => {
    vi.stubGlobal("crypto", {});
    expect(createRequestId()).toMatch(/^\d+-\d+$/);
  });

  it("crypto 不存在时也能生成请求标识", () => {
    vi.stubGlobal("crypto", undefined);
    expect(createRequestId()).toMatch(/^\d+-\d+$/);
  });

  it("同一毫秒内连续操作或重新打开弹窗不重复", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const ids = Array.from({ length: 100 }, () => createRequestId());
    expect(new Set(ids).size).toBe(ids.length);
  });
});
