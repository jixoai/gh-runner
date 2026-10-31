import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRunner, unregisterRunner } from "../src/register.ts";
import { unregisterSpawn } from "../src/platform.ts";

let dir: string;
let lines: string[];
const metadata = { agentId: 42, agentName: "retained-runner", gitHubUrl: "https://github.com/alice/project", workFolder: "_work" };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rf-remove-"));
  lines = [];
  await mkdir(join(dir, "_work"));
  await mkdir(join(dir, "_diag"));
  await writeFile(join(dir, "_work", "keep.txt"), "WORK");
  await writeFile(join(dir, "_diag", "keep.log"), "LOG");
  await writeFile(join(dir, ".runner"), JSON.stringify(metadata));
  await writeFile(join(dir, ".credentials"), "SECRET");
  await writeFile(join(dir, ".credentials_rsaparams"), "KEY");
  await writeFile(join(dir, "config.sh"), `#!/bin/sh\nprintf '%s\\n' "$@" > command-args.txt\nprintf '%s' "$ACTIONS_RUNNER_INPUT_TOKEN" > command-token.txt\nprintf '%s\\n' "$ACTIONS_RUNNER_INPUT_TOKEN"\nif [ "$1" = remove ]; then\n  rm -f .runner .credentials .credentials_rsaparams\nelse\n  printf '%s' '${JSON.stringify(metadata)}' > .runner\nfi\n`);
  await chmod(join(dir, "config.sh"), 0o755);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("官方 runner 注销命令", () => {
  it("注销同步清理连接凭据，不删除工作文件或安装文件，Token 不进入 argv 和日志", async () => {
    await unregisterRunner(dir, "REMOVE_SECRET", (line) => lines.push(line));
    expect((await readFile(join(dir, "command-args.txt"), "utf8")).trim().split("\n")).toEqual(["remove", "--unattended"]);
    expect(await readFile(join(dir, "command-token.txt"), "utf8")).toBe("REMOVE_SECRET");
    expect(lines.join("\n")).not.toContain("REMOVE_SECRET");
    for (const file of [".runner", ".credentials", ".credentials_rsaparams"]) expect(existsSync(join(dir, file))).toBe(false);
    expect(await readFile(join(dir, "_work", "keep.txt"), "utf8")).toBe("WORK");
    expect(await readFile(join(dir, "_diag", "keep.log"), "utf8")).toBe("LOG");
    expect(existsSync(join(dir, "config.sh"))).toBe(true);
  });

  it("原目录重新注册不解包、不清空工作文件", async () => {
    await unregisterRunner(dir, "REMOVE_SECRET", () => {});
    const result = await registerRunner({ dir, name: metadata.agentName, orgUrl: metadata.gitHubUrl, token: "REGISTER_SECRET", labels: "", workFolder: join(dir, "_work"), packagePath: null, reusePackage: true }, [], (line) => lines.push(line));
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, ".runner"))).toBe(true);
    expect(await readFile(join(dir, "_work", "keep.txt"), "utf8")).toBe("WORK");
    expect(lines.join("\n")).not.toContain("解包");
    expect(lines.join("\n")).not.toContain("REGISTER_SECRET");
  });

  it("命令失败或未清理凭据时不能报告注销成功", async () => {
    await writeFile(join(dir, "config.sh"), "#!/bin/sh\nexit 1\n");
    await expect(unregisterRunner(dir, "REMOVE_SECRET", () => {})).rejects.toThrow("退出码 1");
    expect(existsSync(join(dir, ".runner"))).toBe(true);
    await writeFile(join(dir, "config.sh"), "#!/bin/sh\nexit 0\n");
    await expect(unregisterRunner(dir, "REMOVE_SECRET", () => {})).rejects.toThrow("未清理");
  });

  it("缺少 Token 或本机配置时不执行注销命令", async () => {
    await expect(unregisterRunner(dir, "", () => {})).rejects.toThrow("缺少");
    await rm(join(dir, ".runner"));
    await expect(unregisterRunner(dir, "TOKEN", () => {})).rejects.toThrow("配置已缺失");
    expect(existsSync(join(dir, "command-args.txt"))).toBe(false);
  });

  it("平台命令：Windows 直接使用 Listener remove，macOS 使用 config.sh remove", () => {
    expect(unregisterSpawn(dir, "win32")).toEqual({ file: join(dir, "bin", "Runner.Listener.exe"), prefixArgs: ["remove"] });
    expect(unregisterSpawn(dir, "darwin")).toEqual({ file: "./config.sh", prefixArgs: ["remove"] });
  });
});
