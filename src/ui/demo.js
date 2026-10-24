/*
 * 演示模式数据源（仅普通浏览器打开 index.html 时由 index.html 动态加载）：
 * 模拟 4 台实例的完整生命周期，按与真实宿主相同的 summary/log 双通道协议驱动渲染，
 * 供走查/截图/自动化验收。
 */
"use strict";
(function () {
  const now = Date.now();
  const mk = (id, name, over) => Object.assign({
    id, dir: `/Volumes/bnqkl/Users/kzf/actions-runner${name === "mac-ext-01" ? "" : name.slice(-2)}`,
    name, agentId: 99 + Number(name.slice(-2)) - 1, orgUrl: "https://github.com/jixoai",
    workFolder: "/Volumes/bnqkl/Users/kzf/gh-runner-work", configured: true,
    processState: "stopped", external: false, autoStart: false, pid: null,
    currentJob: null, lastResult: null, lastError: null, log: [], logTotal: 0,
  }, over);

  const instances = [
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
  const logSent = new Map();

  let seq = 0;
  function sink() {
    seq += 1;
    window.__rfSink({
      kind: "summary",
      seq,
      now: new Date().toISOString(),
      task: window.__demo.task,
      instances: instances.map(({ log: _log, ...rest }) => rest),
    });
    for (const inst of instances) {
      const sent = logSent.get(inst.id) ?? 0;
      if (inst.logTotal > sent) {
        seq += 1;
        window.__rfSink({
          kind: "log",
          seq,
          id: inst.id,
          from: sent,
          truncated: false,
          lines: inst.log.slice(sent),
        });
        logSent.set(inst.id, inst.logTotal);
      }
    }
  }

  function addLog(inst, line) {
    inst.log.push(line);
    inst.logTotal += 1;
  }

  const demo = (window.__demo = {
    task: { kind: "none", status: "ok", message: null },
    command(cmd) {
      const inst = instances.find((i) => i.id === cmd.id);
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
      if (cmd.type === "register") {
        demo.task = { kind: "register", status: "running", message: "（演示）开始注册…" };
        const lines = ["$ 解包分发包", "  x actions-runner/", "  x actions-runner/bin/", "$ 移除 quarantine 隔离标记", "$ config.sh 注册", "  √ Connected to GitHub", "  √ Runner successfully added"];
        let i = 0;
        const t = setInterval(() => {
          if (i < lines.length) {
            demo.task = { kind: "register", status: "running", message: lines[i++] };
            const dirInst = instances.find((x) => x.id === "actions-runner-04");
            addLog(dirInst, demo.task.message);
          } else {
            clearInterval(t);
            const dirInst = instances.find((x) => x.id === "actions-runner-04");
            dirInst.configured = true;
            dirInst.name = cmd.name || "mac-ext-05";
            dirInst.dir = cmd.dir;
            demo.task = { kind: "register", status: "ok", message: `${dirInst.name} 注册成功（演示）` };
            demo.command({ type: "start", id: dirInst.id });
          }
          sink();
        }, 700);
      }
      sink();
    },
  });

  function ts() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
  }

  // 周期性外部世界演化：让 mac-ext-02 每 15s 领一个新作业
  setInterval(() => {
    const inst = instances.find((i) => i.name === "mac-ext-02");
    if (!inst || inst.processState !== "running" || inst.currentJob) return;
    const jobs = ["build-mac", "publish-feed", "deploy"];
    const job = jobs[Math.floor(Math.random() * jobs.length)];
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
})();
