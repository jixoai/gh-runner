import { describe, expect, it } from "vitest";
import { joinFolder, nextRunner, registrationError, runnerPaths } from "../src/ui-app/lib/registration-form.ts";

describe("批量 runner 表单", () => {
  it("添加实例跳过现有名称，大小写不敏感", () => {
    expect(nextRunner("build", ["BUILD-01", "build-03"], 4)).toMatchObject({ key: 4, name: "build-02" });
  });
  it("生成跨平台的独立实例和工作目录", () => {
    const runner = nextRunner("build", [], 1);
    expect(runnerPaths("/Users/me/runners/", runner)).toEqual({ dir: "/Users/me/runners/build-01", workFolder: "/Users/me/runners/build-01-work" });
    expect(runnerPaths("C:\\runners\\", runner)).toEqual({ dir: "C:\\runners\\build-01", workFolder: "C:\\runners\\build-01-work" });
    expect(joinFolder("\\\\server\\share", "runner")).toBe("\\\\server\\share\\runner");
  });
  it("名称变更自动更新默认路径，但保留显式自定义目录", () => {
    expect(runnerPaths("/tmp/runners", { key: 1, name: "new-name", dir: "/custom", workFolder: "" })).toEqual({ dir: "/custom", workFolder: "/tmp/runners/new-name-work" });
  });
  it("拒绝重复名字、目录、相对路径和路径穿越名称", () => {
    const first = nextRunner("build", [], 1);
    expect(registrationError("https://github.com/acme", "/tmp/runners", [first, { ...first, key: 2 }])).toContain("重复");
    expect(registrationError("https://github.com/acme", "/tmp/runners", [first, { ...first, key: 2, name: "other", dir: "/tmp/runners/build-01" }])).toContain("目录不能重复");
    expect(registrationError("https://github.com/acme", "relative", [first])).toContain("绝对路径");
    expect(registrationError("https://github.com/acme", "/tmp/runners", [{ ...first, name: "../outside" }])).toContain("实例名称");
  });
  it("完整的多实例配置可直接继续授权", () => {
    expect(registrationError("https://github.com/acme/repo", "/tmp/runners", [nextRunner("build", [], 1), nextRunner("build", ["build-01"], 2)])).toBeNull();
  });
});
