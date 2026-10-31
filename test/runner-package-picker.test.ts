import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunnerPackagePicker } from "../src/ui-app/components/runner-package-picker.tsx";
import type { DownloadState, PackageInfo } from "../src/types.ts";

const local: PackageInfo = { path: "/packages/actions-runner-osx-arm64-2.338.2.tar.gz", name: "actions-runner-osx-arm64-2.338.2.tar.gz", compatible: true, sizeBytes: 123, mtimeMs: 1 };

function render({ packages = [], value = "", download = null, platform = "darwin", arch = "arm64" }: { packages?: PackageInfo[]; value?: string; download?: DownloadState | null; platform?: string; arch?: string } = {}) {
  return renderToStaticMarkup(createElement(RunnerPackagePicker, { summary: { packages, platform, arch, download }, value, onValueChange: () => {} }));
}

describe("安装包来源界面", () => {
  it("新设备只展示本机推荐与下载入口，高级选项默认收起", () => {
    const html = render();
    expect(html).toContain("下载并使用");
    expect(html).toContain("最新稳定版");
    expect(html).toContain("macOS · Apple 芯片 (ARM64)");
    expect(html).not.toMatch(/<details[^>]*\sopen(?:[=\s>])/);
    expect(html).not.toContain("选择已有安装包");
    expect(html).not.toContain("通过分发包文件名识别");
    expect(html).not.toContain("slim");
  });

  it("已有适配包默认展示复用状态，不要求再次下载", () => {
    const html = render({ packages: [local], value: local.path });
    expect(html).toContain("选择已有安装包");
    expect(html).toContain("已就绪，无需重新下载");
    expect(html).toContain(local.name);
    expect(html).not.toContain("下载并使用");
  });

  it.each(["running", "paused", "cancelling"] as const)("%s 状态保留进度和控制，不显示重复下载按钮", (status) => {
    const html = render({ packages: [local], value: local.path, download: { status, pct: 37, message: "原始下载状态", network: "HTTP 127.0.0.1:7890" } });
    expect(html).toContain("37%");
    expect(html).toContain("取消下载");
    expect(html).toContain("文件与连接详情");
    expect(html).toContain("HTTP 127.0.0.1:7890");
    expect(html).not.toContain("选择已有安装包");
    expect(html).not.toContain("重新下载");
    if (status === "paused") expect(html).toContain("继续下载");
  });

  it("下载失败直接展示可恢复错误与重试入口，不藏进详情", () => {
    const html = render({ download: { status: "error", pct: 0, message: "GitHub HTTP 403，请更换代理节点" } });
    expect(html).toMatch(/role="alert"[^>]*>GitHub HTTP 403/);
    expect(html).toContain("重试下载");
  });

  it("未知设备自动展开选项，不会错误推荐 Linux x64", () => {
    const html = render({ platform: "freebsd", arch: "riscv64" });
    expect(html).toMatch(/<details[^>]*\sopen=""/);
    expect(html).toContain("暂时无法自动适配");
    expect(html).toContain("选择下载平台");
  });
});
