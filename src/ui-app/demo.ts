/*
 * 正交意图：演示数据源——无宿主桥（普通浏览器打开）时模拟 4 台实例 + 包/下载生命周期，
 * 驱动与真实宿主完全相同的 store 通道，供走查/截图/自动化验收。
 */

import { store, type UiCommand } from "./lib/host";
import type { AuthorizationState, DownloadState, RegistrationBatchState, RunnerOperationState, RunnerOperationRequest } from "../types.ts";
import { downloadTemplateError } from "../download-source.ts";
import { resolvePackageSelection, runnerPackageName } from "../runner-package.ts";

interface DemoInstance {
  id: string;
  dir: string;
  name: string;
  agentId: number | null;
  orgUrl: string | null;
  workFolder: string | null;
  configured: boolean;
  unregistered?: boolean;
  processState: "stopped" | "starting" | "running" | "stopping";
  external: boolean;
  autoStart: boolean;
  pid: number | null;
  currentJob: { job: string; startedAt: string } | null;
  lastResult: { job: string; outcome: string; at: string; durationMs: number } | null;
  lastError: string | null;
  log: string[];
  logTotal: number;
}

const now = Date.now();
const mk = (id: string, name: string, over: Partial<DemoInstance>): DemoInstance => ({
  id,
  dir: `/Volumes/bnqkl/Users/kzf/actions-runner${name === "mac-ext-01" ? "" : name.slice(-2)}`,
  name,
  agentId: 99 + Number(name.slice(-2)) - 1,
  orgUrl: "https://github.com/jixoai",
  workFolder: "/Volumes/bnqkl/Users/kzf/gh-runner-work",
  configured: true,
  processState: "stopped",
  external: false,
  autoStart: false,
  pid: null,
  currentJob: null,
  lastResult: null,
  lastError: null,
  log: [],
  logTotal: 0,
  ...over,
});

const instances: DemoInstance[] = [
  mk("actions-runner", "mac-ext-01", {
    processState: "running", external: true, pid: 75037, autoStart: true,
    currentJob: { job: "deploy", startedAt: new Date(now - 95_000).toISOString() },
    lastResult: { job: "build-win", outcome: "Succeeded", at: new Date(now - 12 * 60_000).toISOString(), durationMs: 118_000 },
    log: [
      "2026-10-24 11:39:46Z: Running job: deploy",
      "2026-10-24 11:41:36Z: Job deploy completed with result: Succeeded",
      "2026-10-24 11:57:17Z: Running job: lint-test-scan",
      "2026-10-24 11:58:07Z: Job lint-test-scan completed with result: Failed",
      "2026-10-24 12:10:36Z: Running job: lint-test-scan",
      "2026-10-24 12:13:04Z: Job lint-test-scan completed with result: Succeeded",
      "2026-10-24 12:18:02Z: Running job: deploy",
    ],
  }),
  mk("actions-runner-2", "mac-ext-02", {
    processState: "running", external: true, pid: 49420,
    lastResult: { job: "test（typecheck＋vitest＋build）", outcome: "Succeeded", at: new Date(now - 40 * 60_000).toISOString(), durationMs: 32_000 },
    log: ["2026-10-24 11:36:40Z: Listening for Jobs"],
  }),
  mk("actions-runner-03", "mac-ext-03", {
    processState: "running", external: true, pid: 50402,
    lastResult: { job: "核心门禁（cli / contracts / icons / hermes）", outcome: "Failed", at: new Date(now - 3 * 60_000).toISOString(), durationMs: 26_000 },
    log: [
      "2026-10-24 12:15:11Z: Running job: 核心门禁（cli / contracts / icons / hermes）",
      "2026-10-24 12:15:37Z: Job 核心门禁（cli / contracts / icons / hermes） completed with result: Failed",
      "2026-10-24 12:15:40Z: Listening for Jobs",
    ],
  }),
  mk("actions-runner-04", "mac-ext-04", { processState: "stopped" }),
];
for (const inst of instances) inst.logTotal = inst.log.length;
const logSent = new Map<string, number>();

const packages = [
  { path: "/Volumes/bnqkl/Users/kzf/actions-runner/actions-runner-osx-arm64-2.338.1.tar.gz", name: "actions-runner-osx-arm64-2.338.1.tar.gz", sizeBytes: 214 * 1024 * 1024, mtimeMs: now - 3600_000, compatible: true },
  { path: "/Users/kzf/Downloads/actions-runner-win-x64-2.339.0.zip", name: "actions-runner-win-x64-2.339.0.zip", sizeBytes: 198 * 1024 * 1024, mtimeMs: now - 86_400_000, compatible: false },
];
let download: DownloadState | null = null;
let downloadTimer: ReturnType<typeof setInterval> | null = null;
let authorization: AuthorizationState | null = null;
let registrationBatch: RegistrationBatchState | null = null;
let pendingBatch: Extract<UiCommand, { type: "register-batch" }> | null = null;
let runnerOperation: RunnerOperationState | null = null;
let pendingOperation: RunnerOperationRequest | null = null;

const task = { kind: "none", status: "ok", message: null } as {
  kind: "none" | "register" | "unregister" | "reregister";
  status: "ok" | "running" | "error";
  message: string | null;
};

function ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
}

function addLog(inst: DemoInstance, line: string): void {
  inst.log.push(line);
  inst.logTotal += 1;
}

function sink(): void {
  store.sink({
    kind: "summary",
    seq: Math.floor(Math.random() * 1e9),
    now: new Date().toISOString(),
    platform: "darwin",
    arch: "arm64",
    task: { ...task },
    instances: instances.map(({ log: _log, ...rest }) => structuredClone(rest)),
    packages: structuredClone(packages),
    download: download ? { ...download } : null,
    authorization: authorization ? { ...authorization } : null,
    registrationBatch: structuredClone(registrationBatch),
    runnerOperation: runnerOperation ? { ...runnerOperation } : null,
    registrationDefaults: { parentDir: "/Users/demo/actions-runners", name: "mac-build", clientId: "demo-github-app" },
  });
  for (const inst of instances) {
    const sent = logSent.get(inst.id) ?? 0;
    if (inst.logTotal > sent) {
      store.sink({ kind: "log", seq: Math.floor(Math.random() * 1e9), id: inst.id, from: sent, truncated: false, lines: inst.log.slice(sent) });
      logSent.set(inst.id, inst.logTotal);
    }
  }
}

export const demoHost = {
  authorize(): void {
    if (pendingOperation) {
      const command = pendingOperation;
      pendingOperation = null;
      authorization = { status: "registering", message: "正在处理 runner（演示）" };
      sink();
      setTimeout(() => {
        const inst = instances.find((item) => item.id === command.id);
        if (!inst || !runnerOperation) return;
        inst.configured = command.action === "reregister";
        inst.unregistered = !inst.configured;
        inst.processState = "stopped";
        inst.currentJob = null;
        inst.pid = null;
        inst.autoStart = false;
        inst.agentId = inst.configured ? 5001 : null;
        runnerOperation.status = "ok";
        runnerOperation.message = inst.configured ? "已重新注册，文件保持不变（演示）" : "已从 GitHub 注销，工作文件已保留（演示）";
        authorization = { status: "cleared", message: "临时凭据已清理（演示）" };
        task.status = "ok";
        task.message = runnerOperation.message;
        sink();
      }, 600);
      return;
    }
    const command = pendingBatch;
    if (!command || !registrationBatch) return;
    pendingBatch = null;
    authorization = { status: "registering", message: "演示：临时账号凭据已释放，正在逐个创建…" };
    let index = 0;
    const advance = () => {
      const item = registrationBatch?.items[index];
      const runner = command.runners[index];
      if (!item || !runner) {
        command.token = "";
        if (registrationBatch) registrationBatch.credentialsCleared = true;
        authorization = { status: "cleared", message: "演示：本机临时凭据已清理" };
        task.status = "ok";
        task.message = `${command.runners.length} 个 runner 已创建（演示）`;
        sink();
        return;
      }
      item.status = "registering";
      item.message = "解包并注册（演示）…";
      sink();
      setTimeout(() => {
        const fresh = mk(`demo-${Date.now()}-${index}`, runner.name, {});
        fresh.processState = "running";
        fresh.external = false;
        fresh.pid = 42000 + index;
        fresh.dir = runner.dir;
        fresh.workFolder = runner.workFolder;
        fresh.orgUrl = command.targetUrl;
        instances.push(fresh);
        item.status = "ok";
        item.message = "已注册并启动（演示）";
        index += 1;
        advance();
      }, 600);
    };
    advance();
  },
  command(cmd: UiCommand): void {
    if (cmd.type === "ack" || cmd.type === "hello") return;
    const inst = "id" in cmd ? instances.find((i) => i.id === cmd.id) : undefined;
    if (cmd.type === "open-work-dir") {
      task.kind = "none";
      task.status = "ok";
      task.message = "演示模式不会打开本机文件夹";
    }
    if (cmd.type === "runner-operation" && inst) {
      pendingOperation = { ...cmd, token: "" };
      cmd.token = "";
      runnerOperation = { requestId: cmd.requestId, id: cmd.id, action: cmd.action, status: "running", message: "等待授权（演示）" };
      task.kind = cmd.action;
      task.status = "running";
      task.message = runnerOperation.message;
      authorization = { status: "waiting", userCode: "DEMO-2026", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 900_000, message: "请使用模拟确认按钮" };
      if (cmd.method === "token") demoHost.authorize();
    }
    if (cmd.type === "cancel-authorization" && pendingOperation && runnerOperation) {
      pendingOperation = null;
      runnerOperation.status = "error";
      runnerOperation.message = "授权已取消，未执行操作（演示）";
      authorization = { status: "cancelled", message: runnerOperation.message };
      task.status = "error";
      task.message = runnerOperation.message;
    }
    if (cmd.type === "start" && inst) {
      inst.processState = "running";
      addLog(inst, ts() + " Listening for Jobs");
      setTimeout(() => {
        if (inst.processState !== "running") return;
        inst.currentJob = { job: "lint-test-scan", startedAt: new Date().toISOString() };
        addLog(inst, ts() + " Running job: lint-test-scan");
        sink();
        setTimeout(() => {
          if (!inst.currentJob) return;
          const ok = Math.random() > 0.35;
          inst.lastResult = { job: inst.currentJob.job, outcome: ok ? "Succeeded" : "Failed", at: new Date().toISOString(), durationMs: 21_000 };
          addLog(inst, ts() + ` Job ${inst.currentJob.job} completed with result: ${inst.lastResult.outcome}`);
          inst.currentJob = null;
          addLog(inst, ts() + " Listening for Jobs");
          sink();
        }, 8000);
      }, 1200);
    }
    if (cmd.type === "stop" && inst) {
      inst.processState = "stopped";
      inst.currentJob = null;
      inst.pid = null;
      inst.external = false;
    }
    if (cmd.type === "set-auto-start" && inst) inst.autoStart = cmd.value;
    if (cmd.type === "register-batch") {
      task.kind = "register";
      task.status = "running";
      task.message = "等待手机授权（演示）";
      registrationBatch = { requestId: cmd.requestId, credentialsCleared: false, items: cmd.runners.map((runner) => ({ name: runner.name, dir: runner.dir, status: "pending", message: "等待注册" })) };
      pendingBatch = { ...cmd, token: "" };
      cmd.token = "";
      authorization = { status: "waiting", userCode: "DEMO-2026", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 900_000, message: "演示：请使用模拟确认按钮" };
      if (cmd.method === "token") demoHost.authorize();
    }
    if (cmd.type === "cancel-authorization" && pendingBatch) {
      pendingBatch = null;
      authorization = { status: "cancelled", message: "授权已取消（演示）" };
      if (registrationBatch) {
        registrationBatch.credentialsCleared = true;
        for (const item of registrationBatch.items) {
          item.status = "error";
          item.message = "已取消，未创建（演示）";
        }
      }
      task.status = "error";
      task.message = "授权已取消（演示）";
    }
    if (cmd.type === "download-latest") {
      if (download && ["running", "paused", "cancelling"].includes(download.status)) return;
      const problem = downloadTemplateError(cmd.sourceTemplate ?? "");
      if (problem) {
        download = { status: "error", pct: 0, message: problem };
        sink();
        return;
      }
      let selection;
      try { selection = resolvePackageSelection(cmd.selection, "osx-arm64"); }
      catch (error) {
        download = { status: "error", pct: 0, message: error instanceof Error ? error.message : String(error) };
        sink();
        return;
      }
      const name = runnerPackageName(selection.target, selection.version === "latest" ? "2.340.0" : selection.version);
      const path = `/Users/kzf/Library/Application Support/gh-runner/packages/${name}`;
      const compatible = selection.target === "osx-arm64";
      download = { status: "running", pct: 0, message: `下载 ${name}（演示）`, network: "系统代理 · HTTPS 127.0.0.1:7890 · HTTP 127.0.0.1:7890（演示）", source: cmd.sourceTemplate?.trim() ? "自定义加速源 · 官方 SHA-256 校验（演示）" : "GitHub 官方（演示）" };
      let pct = 0;
      downloadTimer = setInterval(() => {
        if (download?.status !== "running") return;
        pct = Math.min(100, pct + 2);
        download = { ...download, status: "running", pct, message: `下载 ${name}（演示）` };
        if (pct >= 100) {
          if (downloadTimer) clearInterval(downloadTimer);
          downloadTimer = null;
          download = { status: "ok", pct: 100, message: `已下载 ${name}（演示）`, packagePath: path };
          const existing = packages.findIndex((pkg) => pkg.path === path);
          if (existing >= 0) packages.splice(existing, 1);
          packages.unshift({ path, name, sizeBytes: 221 * 1024 * 1024, mtimeMs: Date.now(), compatible });
        }
        sink();
      }, 400);
    }
    if (cmd.type === "pause-download" && download?.status === "running") {
      download = { ...download, status: "paused", message: "已暂停；继续时优先断点续传，服务器不支持时重新下载（演示）" };
    }
    if (cmd.type === "resume-download" && download?.status === "paused") {
      download = { ...download, status: "running", message: "继续下载分发包（演示）" };
    }
    if (cmd.type === "cancel-download" && download && ["running", "paused"].includes(download.status)) {
      if (downloadTimer) clearInterval(downloadTimer);
      downloadTimer = null;
      download = { ...download, status: "cancelled", message: "已取消，未完成的下载已清理（演示）" };
    }
    if (cmd.type === "import-package") {
      packages.unshift({ path: "/Users/kzf/Downloads/actions-runner-osx-arm64-2.341.0.tar.gz", name: "actions-runner-osx-arm64-2.341.0.tar.gz", sizeBytes: 223 * 1024 * 1024, mtimeMs: Date.now(), compatible: true });
    }
    if (cmd.type === "register") {
      task.kind = "register";
      task.status = "running";
      task.message = "（演示）开始注册…";
      const lines = ["$ 解包分发包", "  x actions-runner/", "  x actions-runner/bin/", "$ 移除 quarantine 隔离标记", "$ config.sh 注册", "  √ Connected to GitHub", "  √ Runner successfully added"];
      let i = 0;
      const t = setInterval(() => {
        if (i < lines.length) {
          task.status = "running";
          task.message = lines[i++] ?? null;
        } else {
          clearInterval(t);
          const fresh = mk("actions-runner-5", cmd.name || "mac-ext-05", {});
          fresh.dir = cmd.dir || fresh.dir;
          instances.push(fresh);
          task.status = "ok";
          task.message = `${fresh.name} 注册成功（演示）` as string | null;
          demoHost.command({ type: "start", id: fresh.id });
        }
        sink();
      }, 700);
    }
    sink();
  },
};

// 周期性外部世界演化：mac-ext-02 每 15s 领一个新作业
setInterval(() => {
  const inst = instances.find((i) => i.name === "mac-ext-02");
  if (!inst || inst.processState !== "running" || inst.currentJob) return;
  const jobs = ["build-mac", "publish-feed", "deploy"];
  const job = jobs[Math.floor(Math.random() * jobs.length)]!;
  inst.currentJob = { job, startedAt: new Date().toISOString() };
  addLog(inst, ts() + ` Running job: ${job}`);
  sink();
  setTimeout(() => {
    if (!inst.currentJob) return;
    const ok = job !== "publish-feed";
    inst.lastResult = { job, outcome: ok ? "Succeeded" : "Failed", at: new Date().toISOString(), durationMs: 95_000 };
    addLog(inst, ts() + ` Job ${job} completed with result: ${inst.lastResult.outcome}`);
    inst.currentJob = null;
    sink();
  }, 9000);
}, 15000);

sink();
