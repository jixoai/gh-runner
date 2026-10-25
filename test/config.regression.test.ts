/*
 * Windows 数据丢失事故回归（v0.2.2 实证）：win32 盘符路径的实例项曾被 startsWith("/")
 * 全量误杀并回写空清单。校验必须平台无关。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rf-cfg-"));
  process.env.HOME = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
});
afterEach(async () => {
  delete process.env.HOME;
  delete process.env.APPDATA;
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe("config：Windows 路径实例项不得被误杀", () => {
  it("win32 盘符路径实例项在 loadConfig 后保留", async () => {
    const { configDir, loadConfig, saveConfig } = await import("../src/config.ts");
    await mkdir(configDir(), { recursive: true });
    const cfg = {
      searchDirs: ["C:\\actions-runner"],
      instances: [
        { id: "actions-runner-5", dir: "C:\\actions-runner-5", autoStart: true },
        { id: "actions-runner-6", dir: "C:/actions-runner-6", autoStart: false },
      ],
      importedPackages: [],
    };
    await writeFile(join(configDir(), "config.json"), JSON.stringify(cfg));
    const loaded = await loadConfig();
    expect(loaded.instances).toHaveLength(2);
    expect(loaded.instances.map((i) => i.id).sort()).toEqual(["actions-runner-5", "actions-runner-6"]);
    // 保存→再读：写回不丢
    await saveConfig(loaded);
    const reread = JSON.parse(await readFile(join(configDir(), "config.json"), "utf8"));
    expect(reread.instances).toHaveLength(2);
  });

  it("损坏项仍被丢弃，合法项共存", async () => {
    const { configDir, loadConfig } = await import("../src/config.ts");
    await mkdir(configDir(), { recursive: true });
    await writeFile(
      join(configDir(), "config.json"),
      JSON.stringify({
        searchDirs: ["/Volumes/bnqkl/Users/kzf"],
        instances: [{ autoStart: true }, { id: "ok", dir: "/tmp/ok-runner", autoStart: false }],
        importedPackages: [],
      }),
    );
    const loaded = await loadConfig();
    expect(loaded.instances).toHaveLength(1);
    expect(loaded.instances[0]!.id).toBe("ok");
  });
});
