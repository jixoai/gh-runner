/*
 * 平台资产名与包清单单测：actions/runner 官方资产命名映射、兼容性标注、包清单合并去重。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetNameFor, packageCompatible, osSegment, archSegment, basenameOf, isAbsolutePath } from "../src/platform.ts";
import { listPackages } from "../src/packages.ts";

const isolated = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/config.ts", async (original) => ({
  ...await original<typeof import("../src/config.ts")>(), configDir: () => isolated.root,
}));

beforeEach(async () => { isolated.root = await mkdtemp(join(tmpdir(), "runner-platform-")); });
afterEach(async () => { await rm(isolated.root, { recursive: true, force: true }); });

describe("platform 资产名映射", () => {
  it("darwin/arm64 → osx-arm64 tar.gz", () => {
    expect(assetNameFor("2.338.1", "darwin", "arm64")).toBe("actions-runner-osx-arm64-2.338.1.tar.gz");
  });
  it("win32/x64 → win-x64 zip", () => {
    expect(assetNameFor("2.338.1", "win32", "x64")).toBe("actions-runner-win-x64-2.338.1.zip");
  });
  it("linux/arm64 → linux-arm64 tar.gz；ia32 → x86", () => {
    expect(assetNameFor("2.339.0", "linux", "arm64")).toBe("actions-runner-linux-arm64-2.339.0.tar.gz");
    expect(assetNameFor("2.339.0", "linux", "ia32")).toBe("actions-runner-linux-x86-2.339.0.tar.gz");
  });
  it("兼容性判定按当前平台", () => {
    const self = `${osSegment()}-${archSegment()}`;
    expect(packageCompatible(assetNameFor("2.338.1"))).toBe(true);
    const other = self === "osx-arm64" ? "win-x64" : "osx-arm64";
    expect(packageCompatible(`actions-runner-${other}-2.338.1.zip`)).toBe(false);
  });
  it("路径工具", () => {
    expect(basenameOf("/a/b/actions-runner-5")).toBe("actions-runner-5");
    expect(basenameOf("C:\\a\\actions-runner-5")).toBe("actions-runner-5");
    expect(isAbsolutePath("/Volumes/x")).toBe(true);
    expect(isAbsolutePath("C:\\x")).toBe(process.platform === "win32");
    expect(isAbsolutePath("relative/path")).toBe(false);
  });
});

describe("listPackages", () => {
  it("列出 ARM 32 位包，去重并按本机兼容性标注", async () => {
    const dir = join(isolated.root, "packages");
    await mkdir(dir);
    const arm = join(dir, "actions-runner-linux-arm-2.338.2.tar.gz");
    const local = join(dir, assetNameFor("2.338.2"));
    await writeFile(arm, "arm");
    await writeFile(local, "native");
    const packages = await listPackages([local, arm]);
    expect(packages).toHaveLength(local === arm ? 1 : 2);
    expect(packages.find((pkg) => pkg.path === local)?.compatible).toBe(true);
    expect(packages.find((pkg) => pkg.path === arm)?.compatible).toBe(packageCompatible(basenameOf(arm)));
  });

  it("合并下载目录与导入路径并去重", async () => {
    // 空目录场景：只有导入路径（不存在的路径被过滤）
    const out = await listPackages(["/nonexistent/pkg.tar.gz"]);
    expect(out).toHaveLength(0);
  });
});
