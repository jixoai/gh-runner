import { describe, expect, it } from "vitest";
import { RUNNER_TARGETS, parseRunnerPackageName, recommendedRunnerTarget, resolvePackageSelection, runnerPackageName, type RunnerPackageTarget } from "../src/runner-package.ts";

describe("runner 下载目标", () => {
  it.each(RUNNER_TARGETS)("$id 按真实平台和 CPU 推荐", ({ id, platform, arch }) => {
    expect(recommendedRunnerTarget(platform, arch)).toBe(id);
    expect(resolvePackageSelection({}, id)).toEqual({ target: id, version: "latest" });
    expect(runnerPackageName(id, "2.338.2")).toBe(`actions-runner-${id}-2.338.2.${platform === "win32" ? "zip" : "tar.gz"}`);
    expect(parseRunnerPackageName(` ${runnerPackageName(id, "2.338.2")} `)).toEqual({ target: id, version: "2.338.2" });
  });

  it.each([["freebsd", "x64"], ["darwin", "riscv64"], ["linux", "ia32"], ["win32", "arm"]])("未知平台 %s/%s 不会伪装成 Linux x64", (platform, arch) => {
    expect(recommendedRunnerTarget(platform, arch)).toBeUndefined();
    expect(() => resolvePackageSelection({})).toThrow("没有适配");
  });

  it("显式跨平台选择覆盖本机默认值，v 前缀归一化", () => {
    expect(resolvePackageSelection({ target: "win-arm64", version: " v2.338.2 " }, "osx-arm64")).toEqual({ target: "win-arm64", version: "2.338.2" });
  });

  it.each(["", "2.338", "2.338.2-rc1", "../latest", "2.338.2?x=1", "vlatest"])("拒绝非法版本 %s", (version) => {
    expect(() => resolvePackageSelection({ target: "linux-x64", version })).toThrow("版本号格式");
  });

  it("拒绝不存在的系统 / 架构组合，即使本机有默认值", () => {
    expect(() => resolvePackageSelection({ target: "osx-arm" as RunnerPackageTarget }, "osx-arm64")).toThrow("没有适配");
  });

  it.each(["ubuntu-slim", "ubuntu-latest", "windows-latest", "macos-latest"])("%s 不能被当作本地安装包", (name) => {
    expect(() => parseRunnerPackageName(name)).toThrow("GitHub 托管环境标签");
  });

  it.each(["runner-slim", "../actions-runner-linux-x64-2.338.2.tar.gz", "https://example.com/actions-runner-linux-x64-2.338.2.tar.gz", "actions-runner-linux-x64-2.338.2.tar.gz;echo test"])("不从未知名字或路径猜测下载源 %s", (name) => {
    expect(() => parseRunnerPackageName(name)).toThrow("完整的官方分发包文件名");
  });

  it.each(["actions-runner-linux-x64-2.338.2.zip", "actions-runner-win-arm64-2.338.2.tar.gz"])("%s 扩展名必须匹配平台", (name) => {
    expect(() => parseRunnerPackageName(name)).toThrow("扩展名与目标平台不匹配");
  });

  it("不接受不存在的官方系统与架构组合", () => {
    expect(() => parseRunnerPackageName("actions-runner-osx-arm-2.338.2.tar.gz")).toThrow("没有适配");
  });
});
