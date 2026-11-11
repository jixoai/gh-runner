import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { Fleet } from "./fleet.ts";
import { githubClientId } from "./github-auth.ts";
import { parseRunnerTarget } from "./github-target.ts";
import { defaultLabels } from "./platform.ts";

const execFile = promisify(execFileCallback);
const NAME_RE = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/;

function help(): void {
  console.log(`GH Runner CLI

Usage:
  gh-runner [cli] [command]

Commands:
  (no command)                 Interactive setup/menu
  register                     Register one or more runners interactively
  list [--json]                List discovered runners
  start <name|id>              Start a runner
  stop <name|id>               Stop a runner
  remove <name|id>             Unregister a runner from GitHub
  autostart enable <name|id>   Install and enable a systemd user service
  autostart disable <name|id>  Disable and remove its systemd user service

Registration supports GitHub device authorization (phone/browser) or a short-lived
runner registration token entered interactively. Do not pass tokens as arguments.`);
}

async function ask(prompt: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
    return answer || fallback || "";
  } finally {
    rl.close();
  }
}

async function askSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("安全输入 Token 需要交互式 TTY；请改用 GitHub 设备授权");
  }
  stdout.write(`${prompt}: `);
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    for await (const chunk of stdin) {
      const text = String(chunk);
      for (const char of text) {
        if (char === "\u0003") throw new Error("已取消");
        if (char === "\r" || char === "\n") {
          stdout.write("\n");
          return value;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    }
    return value;
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

function printSnapshot(snapshot: ReturnType<Fleet["snapshot"]>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(snapshot.instances.map((item) => ({
      id: item.id,
      name: item.name,
      dir: item.dir,
      target: item.orgUrl,
      status: item.processState,
      configured: item.configured,
      autoStart: item.autoStart,
      pid: item.pid,
      job: item.currentJob?.job ?? null,
      lastResult: item.lastResult,
      error: item.lastError,
    })), null, 2));
    return;
  }
  if (!snapshot.instances.length) {
    console.log("没有发现 runner。运行 `gh-runner register` 开始配置。 ");
    return;
  }
  console.log("NAME\tSTATUS\tAUTO-START\tID\tDIRECTORY");
  for (const item of snapshot.instances) {
    console.log(`${item.name}\t${item.processState}${item.currentJob ? ` (${item.currentJob.job})` : ""}\t${item.autoStart ? "yes" : "no"}\t${item.id}\t${item.dir}`);
  }
}

function findRunner(fleet: Fleet, selector: string) {
  const matches = fleet.snapshot().instances.filter((item) => item.id === selector || item.name === selector || item.dir === selector);
  if (matches.length !== 1) throw new Error(matches.length ? `名称不唯一，请使用 ID：${selector}` : `找不到 runner：${selector}`);
  return matches[0]!;
}

async function registerInteractive(fleet: Fleet): Promise<void> {
  const targetUrl = await ask("GitHub 组织或仓库 URL（例如 https://github.com/acme）");
  parseRunnerTarget(targetUrl);
  const countRaw = await ask("要配置几个 runner（1–10）", "1");
  const count = Number(countRaw);
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("runner 数量必须为 1–10");
  const defaultRoot = join(homedir(), "actions-runners");
  const root = resolve(await ask("runner 根目录", defaultRoot));
  const base = await ask("runner 名称前缀", hostname().replace(/[^a-zA-Z0-9_-]/g, "-") || "runner");
  const runners = [];
  for (let index = 0; index < count; index++) {
    const suggested = count === 1 ? base : `${base}-${String(index + 1).padStart(2, "0")}`;
    const name = await ask(`第 ${index + 1} 个 runner 名称`, suggested);
    if (!NAME_RE.test(name)) throw new Error(`runner 名称不合法：${name}`);
    const dir = resolve(await ask(`${name} 安装目录`, join(root, name)));
    const workFolder = resolve(await ask(`${name} Work 目录`, join(root, `${name}-work`)));
    const labels = await ask(`${name} labels`, defaultLabels());
    runners.push({ name, dir, workFolder, labels });
  }

  console.log("\n正在下载当前 Linux 平台适配的官方 Runner 包…");
  const done = fleet.downloadLatest();
  let last = "";
  const stop = fleet.onSnapshot((snapshot) => {
    const state = snapshot.download;
    if (!state) return;
    const line = `${state.status}: ${state.message}${state.pct ? ` (${state.pct}%)` : ""}`;
    if (line !== last) {
      console.log(line);
      last = line;
    }
  });
  try {
    await done;
  } finally {
    stop();
  }
  const downloadState = fleet.snapshot().download;
  if (downloadState?.status !== "ok") throw new Error(downloadState?.message || "官方 Runner 包下载失败");
  const packagePath = fleet.snapshot().packages.find((item) => item.compatible)?.path;
  if (!packagePath) throw new Error("官方 Runner 包下载失败或没有生成可用包");

  const method = (await ask("授权方式：1) 手机/浏览器 GitHub 授权  2) 输入 runner 注册 Token", "1")) === "2" ? "token" : "github";
  const token = method === "token" ? await askSecret("输入短期 runner registration token（非 PAT）") : "";
  const input = {
    method,
    clientId: githubClientId(),
    token,
    targetUrl,
    packagePath,
    runners,
  } as const;
  let previousCode = "";
  let previousMessage = "";
  const stopProgress = fleet.onSnapshot((snapshot) => {
    const auth = snapshot.authorization;
    if (auth?.userCode && auth.userCode !== previousCode) {
      previousCode = auth.userCode;
      console.log(`\n请在手机或浏览器打开 ${auth.verificationUri} 并输入验证码：${auth.userCode}`);
    }
    const message = snapshot.task.message;
    if (message && message !== previousMessage) {
      previousMessage = message;
      console.log(message);
    }
    for (const item of snapshot.registrationBatch?.items ?? []) {
      const line = `${item.name}: ${item.status} — ${item.message}`;
      if (line !== previousMessage) {
        console.log(line);
        previousMessage = line;
      }
    }
  });
  try {
    await fleet.registerBatch({ ...input, runners: [...runners] });
  } finally {
    stopProgress();
  }
  const result = fleet.snapshot().registrationBatch;
  if (result?.items.some((item) => item.status === "error")) process.exitCode = 1;
  const registered = result?.items.filter((item) => item.status === "ok") ?? [];
  if (process.platform === "linux" && registered.length > 0 && (await ask("将成功注册的 runner 配置为 systemd 开机自启动？", "no")).toLowerCase() === "yes") {
    for (const item of registered) {
      try {
        await configureAutostart(fleet, item.dir, true);
      } catch (error) {
        console.error(`${item.name} 自启动配置失败：${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    }
  }
}

function systemdUnitName(id: string): string {
  return `gh-runner-${id.replace(/[^a-zA-Z0-9_.-]/g, "-")}.service`;
}

function systemdEscape(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll(/\$/g, () => "$$")}"`;
}

export function renderSystemdUnit(dir: string): string {
  return `[Unit]\nDescription=GitHub Actions runner managed by GH Runner (${dir})\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdEscape(dir)}\nExecStart=/bin/bash ${systemdEscape(join(dir, "run.sh"))}\nRestart=always\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=60\n\n[Install]\nWantedBy=default.target\n`;
}

async function configureAutostart(fleet: Fleet, selector: string, enable: boolean): Promise<void> {
  if (process.platform !== "linux") throw new Error("systemd 自启动命令仅支持 Linux");
  const runner = findRunner(fleet, selector);
  if (!runner.configured) throw new Error("Runner 尚未注册，无法配置自启动");
  const unit = systemdUnitName(runner.id);
  const unitDir = join(process.env.XDG_CONFIG_HOME?.startsWith("/") ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config"), "systemd", "user");
  await mkdir(unitDir, { recursive: true, mode: 0o700 });
  if (enable) {
    if (runner.processState === "running" || runner.processState === "starting") {
      await fleet.stop(runner.id);
      const stopped = fleet.view(runner.id);
      if (stopped?.processState === "running" || stopped?.processState === "starting" || stopped?.processState === "stopping") {
        throw new Error("Runner 尚未停止，未切换到 systemd 管理；请稍后重试");
      }
    }
    await writeFile(join(unitDir, unit), renderSystemdUnit(runner.dir), { mode: 0o600 });
    await execFile("systemctl", ["--user", "daemon-reload"]);
    await execFile("systemctl", ["--user", "enable", "--now", unit]);
    await fleet.setAutoStart(runner.id, true);
    console.log(`已启用 ${unit}。若需退出登录后仍在开机时启动，请管理员执行：sudo loginctl enable-linger ${process.env.USER ?? "<username>"}`);
  } else {
    if (await access(join(unitDir, unit)).then(() => true, () => false)) {
      await execFile("systemctl", ["--user", "disable", "--now", unit]);
    }
    await rm(join(unitDir, unit), { force: true });
    await execFile("systemctl", ["--user", "daemon-reload"]);
    await fleet.setAutoStart(runner.id, false);
    console.log(`已停用 ${unit}`);
  }
}

async function serviceIsInstalled(id: string): Promise<boolean> {
  const dir = process.env.XDG_CONFIG_HOME?.startsWith("/") ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config");
  return access(join(dir, "systemd", "user", systemdUnitName(id))).then(() => true, () => false);
}

async function runAction(fleet: Fleet, id: string, action: "start" | "stop"): Promise<void> {
  if (process.platform === "linux" && await serviceIsInstalled(id)) {
    await execFile("systemctl", ["--user", action, systemdUnitName(id)]);
  } else {
    await (action === "start" ? fleet.start(id) : fleet.stop(id));
  }
}

async function removeRunner(fleet: Fleet, selector: string): Promise<void> {
  const runner = findRunner(fleet, selector);
  if (runner.currentJob) throw new Error("Runner 正在执行作业，请等作业结束后再注销");
  if (await serviceIsInstalled(runner.id)) {
    await configureAutostart(fleet, selector, false);
  }
  if (runner.processState === "running" || runner.processState === "starting") {
    const answer = await ask(`Runner 当前正在运行。先停止再注销？输入 yes 确认`);
    if (answer.toLowerCase() !== "yes") return;
    await fleet.stop(runner.id);
  }
  const method = (await ask("注销授权方式：1) GitHub 手机/浏览器授权  2) 输入 remove token", "1")) === "2" ? "token" : "github";
  const token = method === "token" ? await askSecret("输入短期 runner remove token（非 PAT）") : "";
  const deleteFiles = (await ask("注销后同时删除本地 runner 和 Work 文件？（不可恢复）输入 yes 确认", "no")).toLowerCase() === "yes";
  const stopProgress = fleet.onSnapshot((snapshot) => {
    const state = snapshot.runnerOperation;
    if (state?.id === runner.id) console.log(state.message);
  });
  try {
    await fleet.operateRunner({ requestId: `cli-${Date.now()}`, id: runner.id, action: "unregister", method, token, deleteLocalFiles: deleteFiles });
  } finally {
    stopProgress();
  }
  const state = fleet.snapshot().runnerOperation;
  if (state?.status === "error") throw new Error(state.message);
  console.log(`Runner ${runner.name} 已从 GitHub 注销${deleteFiles ? "并删除本地文件" : "；本地文件已保留"}`);
}

async function interactiveMenu(fleet: Fleet): Promise<void> {
  while (true) {
    console.log("\n1) 列出 runners  2) 注册 runners  3) 启动  4) 停止  5) 注销/删除  6) 配置自启动  0) 退出");
    const choice = await ask("请选择", "1");
    if (choice === "0") return;
    if (choice === "1") printSnapshot(fleet.snapshot(), false);
    else if (choice === "2") await registerInteractive(fleet);
    else if (choice === "3" || choice === "4" || choice === "5" || choice === "6") {
      printSnapshot(fleet.snapshot(), false);
      const selector = await ask("输入 runner 名称或 ID");
      if (choice === "3") await runAction(fleet, findRunner(fleet, selector).id, "start");
      if (choice === "4") await runAction(fleet, findRunner(fleet, selector).id, "stop");
      if (choice === "5") await removeRunner(fleet, selector);
      if (choice === "6") {
        const action = (await ask("自启动操作：enable / disable", "enable")).toLowerCase();
        await configureAutostart(fleet, selector, action === "enable");
      }
    } else console.log("无法识别的选项");
  }
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const [command = "", ...rest] = args;
  if (command === "help" || command === "--help" || command === "-h") return help();
  const fleet = new Fleet();
  await fleet.boot({ autoStart: false });
  try {
    if (!command) return await interactiveMenu(fleet);
    if (command === "register") return await registerInteractive(fleet);
    if (command === "list" || command === "ls") return printSnapshot(fleet.snapshot(), rest.includes("--json"));
    if (command === "start" || command === "stop") {
      if (!rest[0]) throw new Error(`用法：gh-runner ${command} <name|id>`);
      const runner = findRunner(fleet, rest[0]);
      await runAction(fleet, runner.id, command);
      console.log(`${runner.name}: ${command} 请求已提交`);
      return;
    }
    if (command === "remove" || command === "unregister") {
      if (!rest[0]) throw new Error("用法：gh-runner remove <name|id>");
      return await removeRunner(fleet, rest[0]);
    }
    if (command === "autostart") {
      const [action, selector] = rest;
      if ((action !== "enable" && action !== "disable") || !selector) throw new Error("用法：gh-runner autostart <enable|disable> <name|id>");
      return await configureAutostart(fleet, selector, action === "enable");
    }
    help();
    throw new Error(`未知命令：${command}`);
  } finally {
    await fleet.destroy();
  }
}
