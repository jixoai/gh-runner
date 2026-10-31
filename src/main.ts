/*
 * 原始需求（2026-10-24）：多开 GitHub self-hosted runner 的托盘管理工具
 * （表单配置 → 实例启动/关闭；按运行日志实时分析最近动作成败；界面实时响应）。
 *
 * 正交意图：
 * 1. 组装：Fleet（领域编排） + TrayProjection（菜单栏投影） + UiHost（appMode 窗口推送）。
 * 2. 生命周期：SIGINT/SIGTERM 优雅退出；受管 runner detached 存活、下次启动自动重连。
 * 3. 验证模式：--dry-run 无头打印快照；--smoke 起真实托盘+窗口并等待页面 hello/ack 后落盘诊断。
 */

import { stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTray, type OpenTrayRuntimeOptions } from "opentray";
import { attachDialog } from "@opentray/ext-dialog";
import { attachOpener } from "@opentray/ext-opener";
import { configDir } from "./config.ts";
import { Fleet } from "./fleet.ts";
import { TrayProjection } from "./tray.ts";
import { UiHost, extendWebview } from "./window.ts";
import { appIcon } from "./branding.ts";
import { APP_VERSION } from "./version.ts";
import { AppLifecycle } from "./lifecycle.ts";

const APP_ID = "com.jixoai.gh-runner";

// 显式包身份：opentray 0.36.0 运行时支持 packageRoot（connectLocalBroker 首选读取）但
// 类型未声明。不提供时 darwin 会从入口目录向上遍历 package.json——npx 缓存根是 npm
// 生成的无名 manifest，readManifestIdentity 对"存在但缺 name"硬抛 OpenTrayPackageIdentityError
//（Owner 2026-10-27 全新 Mac npx 启动即崩实证；Windows 不走该分支所以无恙）。
// dist/main.mjs 的上一级即本包根，manifest 恒有 name。
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 导入本地分发包：系统文件选择器（ext-dialog；darwin NSOpenPanel / win32 对话框）。 */
async function pickPackageFile(tray: Awaited<ReturnType<typeof createTray>>): Promise<string | null> {
  try {
    const dialog = attachDialog(tray);
    const picked = await dialog.pickFile({
      filters: [{ name: "runner 包", extensions: ["gz", "zip"] }],
    });
    return typeof picked === "string" ? picked : null;
  } catch (err) {
    console.error("[gh-runner] 包选择失败:", err);
    reportPickerFailure(
      "本地包选择",
      err,
      "可直接用「下载最新」获取官方包；或把包路径所在目录提前导入",
    );
    return null;
  }
}

/** 选择器失败要可见：UI 经 fleet task 通道 toast（受限环境/桥接失败时用户不再面对无响应按钮）。 */
let reportPickerFailure: (what: string, err: unknown, hint?: string) => void = () => {};

/** --probe：探明真实窗口里注入的页面桥形态。三通道取证：页面 ipc 上行 / 宿主 evaluate 内省 +
 *  titlechange 回传 / loadstate 时机观测。 */
async function runProbe(): Promise<void> {
  const tray = await createTray(
    { id: APP_ID, icon: { "text-only": "probe" } },
    { appId: APP_ID, appName: "GH Runner Probe", recovery: { enabled: false } },
  );
  const webviewTray = extendWebview(tray);
  const win = webviewTray.createWebviewWindow({
    html: `<script>
      window.__probeState = { started: true };
      try {
        navigator.opentray.ipc.postMessage({ t: "probe-ipc", ok: true,
          opentray: Object.keys(navigator.opentray) });
      } catch (e) { window.__probeState.ipcError = String(e); }
    </script>`,
    width: 500,
    height: 200,
    nativeWindowApi: true,
    titleSync: { documentToWindow: true },
  });
  const report: Record<string, unknown> = { ipc: "none", loadstate: [], titlechange: "none" };
  const finish = async (): Promise<void> => {
    await writeFile("/tmp/gh-runner-probe.json", JSON.stringify(report, null, 2), "utf8");
    await win.destroy();
    await tray.destroy();
    process.exit(0);
  };
  win.listen("loadstate", (event) => {
    const phase = (event.payload as { phase?: string })?.phase ?? "unknown";
    report.loadstate = [...(report.loadstate as unknown[]), phase];
    if (phase === "loaded") {
      void win
        .evaluate(
          `document.title = "PROBE:" + JSON.stringify({
            opentray: (typeof navigator.opentray !== "undefined") ? Object.keys(navigator.opentray) : null,
            ipc: !!navigator.opentray?.ipc,
            opentrayWindow: (typeof navigator.opentrayWindow !== "undefined") ? Object.keys(navigator.opentrayWindow) : null
          })`,
        )
        .catch((err) => { report.evaluateError = String(err); });
    }
  });
  win.listen("titlechange", (event) => {
    if (event.payload.title.startsWith("PROBE:")) {
      report.titlechange = event.payload.title.slice(6);
      void finish();
    }
  });
  await win.show();
  const drain = setInterval(() => {
    void win
      .drainIpcMessages()
      .then((msgs) => {
        for (const m of msgs) {
          if ((m.payload as { t?: string })?.t === "probe-ipc") {
            report.ipc = m.payload;
            void finish();
          }
        }
      })
      .catch(() => {});
  }, 200);
  drain.unref?.();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  await finish();
}

async function runSmoke(uiHost: UiHost, shutdown: () => Promise<void>): Promise<void> {
  await uiHost.open();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && uiHost.ackedSeq === 0) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (uiHost.ackedSeq === 0) {
    // 对照实验：最小快照能否走通（区分"管道问题"与"大快照问题"）。
    console.error("[smoke] 全量快照未获 ack，尝试最小快照对照");
    await uiHost.debugPushMinimal();
    const t = Date.now();
    while (Date.now() - t < 5000 && uiHost.ackedSeq === 0) {
      await new Promise((r) => setTimeout(r, 250));
    }
    console.error(`[smoke] 最小快照 ackedSeq=${uiHost.ackedSeq}`);
  }
  const snap = uiHost.lastSnapshot;
  await writeFile(
    "/tmp/gh-runner-smoke.json",
    JSON.stringify(
      {
        ok: uiHost.ackedSeq > 0,
        ackedSeq: uiHost.ackedSeq,
        pushedSeq: snap?.seq ?? 0,
        instances: snap?.instances.map((i) => ({
          id: i.id,
          name: i.name,
          processState: i.processState,
          external: i.external,
          currentJob: i.currentJob,
          lastResult: i.lastResult,
          logLines: i.log.length,
        })) ?? [],
      },
      null,
      2,
    ),
    "utf8",
  );
  // RF_SMOKE_HOLD=<ms>：结果落盘后挂住窗口（供真实窗口截图验收）。
  const holdMs = Number(process.env.RF_SMOKE_HOLD ?? "0");
  if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  await shutdown();
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "";
  if (mode === "--probe") {
    await runProbe();
    return;
  }
  const fleet = new Fleet();
  reportPickerFailure = (what, err, hint) => fleet.reportPickerFailure(what, err, hint);
  // 验证模式（--dry-run/--smoke）绝不产生副作用：不 autoStart、不写配置。
  await fleet.boot(
    mode === "--dry-run" || mode === "--smoke"
      ? { autoStart: false, persist: false }
      : {},
  );

  if (mode === "--dry-run") {
    const iterations = Number(process.argv[3] ?? "3");
    await new Promise((r) => setTimeout(r, 3000)); // 宽限：首次日志回读 + 外部对账落位
    for (let i = 0; i < iterations; i++) {
      const snap = fleet.snapshot();
      console.log(
        JSON.stringify(
          snap.instances.map((inst) => ({
            id: inst.id,
            name: inst.name,
            state: inst.processState,
            external: inst.external,
            job: inst.currentJob?.job ?? null,
            last: inst.lastResult
              ? `${inst.lastResult.job}=${inst.lastResult.outcome}`
              : null,
            logLines: inst.log.length,
          })),
        ),
      );
      if (i < iterations - 1) await new Promise((r) => setTimeout(r, 3000));
    }
    await fleet.destroy();
    return;
  }

  const tray = await createTray(
    {
      id: APP_ID,
      icon: { "text-only": "▶…" },
      menu: { items: [{ type: "item", id: 1, title: "打开控制面板", primaryEvent: true }] },
    },
    { appId: APP_ID, appName: "GH Runner", appIcon: appIcon(), packageRoot, recovery: { enabled: false } } as OpenTrayRuntimeOptions,
  );

  const webviewTray = extendWebview(tray);
  const opener = attachOpener(tray);
  const uiHost = new UiHost(
    fleet,
    webviewTray,
    (id) => {
      const view = fleet.view(id);
      if (view) void opener.revealInFolder(`${view.dir}/_diag`).catch((err) => console.error("[gh-runner] 揭示目录失败:", err));
    },
    () => pickPackageFile(tray),
    async () => {
      try {
        return await attachDialog(tray).pickDirectory();
      } catch (err) {
        console.error("[gh-runner] 目录选择失败:", err);
        reportPickerFailure(
          "runner 目录选择",
          err,
          "可直接打开「注册新实例」，在目录栏粘贴 runner 目录路径（含 .runner 时自动接入，免 Token）",
        );
        return null;
      }
    },
    (url) => opener.open(url),
    async (id) => {
      const view = fleet.view(id);
      if (!view?.workFolder) throw new Error("实例没有工作目录记录");
      const path = resolve(view.dir, view.workFolder);
      if (!(await stat(path)).isDirectory()) throw new Error("工作目录不存在或不是文件夹");
      await opener.open(path);
    },
  );

  let stopSnapshots = () => {};
  let stopMenu = () => {};
  let stopConnectionDead = () => {};
  const lifecycle = new AppLifecycle(
    [
      () => { stopSnapshots(); stopMenu(); stopConnectionDead(); },
      () => fleet.destroy(),
      () => uiHost.destroy(),
      () => tray.destroy(),
    ],
    (code) => process.exit(code),
    (err) => console.error("[gh-runner] 退出清理失败:", err),
  );
  const shutdown = () => lifecycle.shutdown();
  const openWindow = (): void => {
    if (lifecycle.stopping) return;
    void uiHost.open().catch((err) => {
      if (lifecycle.stopping) return;
      console.error("[gh-runner] 打开控制面板失败，可再次点击托盘重试:", err);
      fleet.reportPickerFailure("打开控制面板", err, "可再次点击托盘重试；runner 不受影响");
    });
  };
  const projection = new TrayProjection(tray, {
    openWindow,
    openInstance: () => openWindow(),
    quit: () => void shutdown(),
  });
  stopSnapshots = fleet.onSnapshot((snap) => {
    if (lifecycle.stopping) return;
    void projection.update(snap).catch((err) => console.error("[gh-runner] 更新托盘失败:", err));
    uiHost.push(snap);
  });
  stopMenu = tray.onMenuClick(({ itemId }) => {
    if (lifecycle.stopping) return;
    if (!projection.handleMenuClick(itemId)) console.warn(`[tray] 未路由的菜单项 ${itemId}`);
  });
  stopConnectionDead = tray.onConnectionDead?.(() => void shutdown()) ?? (() => {});

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (mode === "--smoke") {
    await runSmoke(uiHost, shutdown);
    return;
  }
  console.log(`[gh-runner] v${APP_VERSION} 已启动（配置目录 ${configDir()}）`);
}

void main().catch((err) => {
  console.error("[gh-runner] 启动失败:", err);
  process.exit(1);
});
