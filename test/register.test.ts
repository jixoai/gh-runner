/*
 * 注册流水线 E2E：伪造一个最小 runner 分发包（tar.gz），走完整
 * 选包 → 解包 → 去隔离 → 注册（记录参数）→ 校验 .runner 流水线。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, readFile, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRunner, type ProgressSink } from "../src/register.ts";

const exec = promisify(execFile);

let work: string;
let pkgPath: string;
let targetDir: string;

const lines: string[] = [];
const onProgress: ProgressSink = (l) => lines.push(l);

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "rf-reg-pkg-"));
  // 伪造包内容：actions-runner/{bin/run.sh, config.sh}；config.sh 把参数写进文件并生成 .runner
  const staging = join(work, "staging", "actions-runner");
  await mkdir(join(staging, "bin"), { recursive: true });
  await writeFile(
    join(staging, "bin", "run.sh"),
    "#!/bin/bash\nwhile true; do sleep 1; done\n",
  );
  await chmod(join(staging, "bin", "run.sh"), 0o755);
  await writeFile(
    join(staging, "config.sh"),
    [
      "#!/bin/bash",
      'args_file="$(pwd)/config-args.txt"',
      'echo "$@" > "$args_file"',
      'cat > "$(pwd)/.runner" <<EOF',
      '{"agentId": 777, "agentName": "pkg-ext-77", "gitHubUrl": "https://github.com/jixoai", "workFolder": "/tmp/pkg-work"}',
      "EOF",
    ].join("\n"),
  );
  await chmod(join(staging, "config.sh"), 0o755);
  pkgPath = join(work, "actions-runner-osx-arm64-2.338.1.tar.gz");
  // 官方包形态：内容在归档根部（无顶层目录）
  await exec("tar", ["-czf", pkgPath, "-C", staging, "."]);
  targetDir = join(work, "instance");
  await mkdir(targetDir, { recursive: true });
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true }).catch(() => {});
});

describe("registerRunner 流水线", () => {
  it("选定包 → 解包 → 注册 → .runner 就位", async () => {
    const result = await registerRunner(
      {
        dir: targetDir,
        name: "pkg-ext-77",
        token: "TESTTOKEN123",
        labels: "self-hosted,macOS,ARM64",
        orgUrl: "https://github.com/jixoai",
        workFolder: "/tmp/pkg-work",
        packagePath: pkgPath,
      },
      [],
      onProgress,
    );
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();

    const entries = await readdir(targetDir);
    expect(entries).toContain("bin");
    expect(entries).toContain("config.sh");
    expect(entries).toContain(".runner");

    const meta = JSON.parse(await readFile(join(targetDir, ".runner"), "utf8"));
    expect(meta.agentName).toBe("pkg-ext-77");

    const args = (await readFile(join(targetDir, "config-args.txt"), "utf8")).split(/\s+/);
    expect(args).toContain("--token");
    expect(args).toContain("TESTTOKEN123");
    expect(args).toContain("--work");
    expect(args).toContain("/tmp/pkg-work");

    expect(lines.some((l) => l.includes("✔ 注册成功"))).toBe(true);
  }, 30_000);

  it("非空目录直接拒绝", async () => {
    await writeFile(join(targetDir, "some-file"), "x");
    const result = await registerRunner(
      {
        dir: targetDir, name: "x", token: "t", labels: "", orgUrl: "",
        workFolder: "/tmp/w", packagePath: pkgPath,
      },
      [],
      onProgress,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("目录非空");
  });

  it("缺少 Token 直接拒绝", async () => {
    const result = await registerRunner(
      {
        dir: targetDir, name: "x", token: " ", labels: "", orgUrl: "",
        workFolder: "/tmp/w", packagePath: pkgPath,
      },
      [],
      onProgress,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Token");
  });
});
