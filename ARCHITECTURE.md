# @jixoai/gh-runner — 架构规格

> 原始需求（2026-10-24）：多开 GitHub self-hosted runner（本机已有 mac-ext-01..04），
> 做一个挂在托盘里的管理工具——表单配置后可把 runner 当实例启动/关闭；
> 根据运行日志实时分析最近的一个动作是成功还是失败；界面实时响应和显示。

## 拓扑

```
┌─────────────────────────── node 单进程（dist/main.mjs）───────────────────────────┐
│                                                                                   │
│  ┌── Fleet（领域编排，无托盘依赖，可无头测试）──┐      ┌── 投影 ──────────────┐   │
│  │                                             │      │ TrayProjection       │   │
│  │  config.json ◄─► #syncInstances()           │      │  图标文案 ▶N↻M       │   │
│  │                 │ 磁盘发现 ∪ 配置实例        │      │  tooltip            │   │
│  │                 ▼                            │      │  菜单（直达实例）    │   │
│  │  Rt{meta,processState,currentJob,           │──┬──►│ UiHost(appMode 窗口)│   │
│  │      lastResult,log环形缓冲,logTotal}        │  │   │  summary 推送        │   │
│  │     ▲            ▲                           │  │   │  log 增量分包推送    │   │
│  │     │            │                           │  │   └──────────┬──────────┘   │
│  │  ┌──┴───┐   ┌────┴─────┐                     │  │              │ evaluate     │
│  │  │tailer│   │supervisor│                     │  │      ┌───────▼────────┐     │
│  │  │(diag)│   │ spawn/kill│                    │  │      │ WKWebView 页面 │     │
│  │  └──┬───┘   └────┬─────┘                     │  │      │ (vanilla UI)   │     │
│  └─────┼────────────┼───────────────────────────┘  │      └───────┬────────┘     │
│        │            │                              │              │ ipc          │
└────────┼────────────┼──────────────────────────────┼──────────────┼──────────────┘
         ▼            ▼                              ▼              ▼
  _diag/Runner_*.log  run.sh(进程组)              菜单栏图标      navigator.opentray.ipc
  (轮转感知 tail)     detached：工具退出仍存活     (macOS 状态栏)   hello/ack/start/stop/register
```

## 关键判定

1. **日志是权威事件源**：`_diag/Runner_*.log` 的 `WRITE LINE` 控制台行（`Running job: X` /
   `Job X completed with result: Y` / `Listening for Jobs`）对「外部启动的 runner」同样生效，
   因此作业状态机只吃这一路；受管实例的 stdout 仅用于即时回显与启动确认，经归一化去重合流。
2. **外部进程对账**：每 2s `pgrep -f "Runner.Listener run"` + `lsof -d cwd`，双侧 realpath 归一
   （/var ↔ /private/var）后按 cwd 匹配实例目录。工具重启后自动重连 detached 幸存的受管实例。
   停止外部实例前对该 pid 复核 cwd（防 pid 复用误杀）。
3. **包获取三通道**：GitHub actions/runner 官方 release（api.github.com 最新版 → 流式下载
   tmp→rename 原子落盘，进度经 snapshot.download 推送）∪ 本地导入（ext-dialog 系统文件选择框，
   路径登记进 config.importedPackages 不复制）∪ 下载缓存目录；统一 `tar -xf` 解包（bsdtar 同时
   支持 tar.gz/zip，三平台内置）。Windows 注册走 `Runner.Listener configure` 动词、启动直跑
   `Runner.Listener.exe run`，进程发现用 PowerShell CIM 的 ExecutablePath、终止用 `taskkill /T`。
4. **推送协议（实测教训）**：单次 evaluate ~100KB 全量快照在 WKWebView 路径上**静默失败**
   （promise resolve 但页面未执行）。故拆为 `summary`（KB 级）+ `log` 增量（按字节 ≤24KB/包）双通道；
   推送单飞串行（hello 与去抖推送并发交错会重复投递）；页面 hello → 宿主 offset 清零全量重推；
   ack 单调记录（smoke 以此判定闭环）。
5. **spawn 失败三律**（对抗式复核实证）：error 事件必须先于 pid 判空挂监听（否则 uncaught 崩托盘）；
   spawn 失败只发 error+close 不发 exit（必须用 close 收尾，否则永久卡「启动中」）；
   config.json 形状损坏必须容错（合法 JSON + 缺字段即 brick 启动）。
6. **停止语义**：受管实例杀进程组（TERM→8s→KILL）；外部实例 TERM 其 Listener pid（等价于
   终端里 Ctrl-C），pid 复用核验不过即放弃。kill(2) 区分 ESRCH/EPERM，EPERM=存活无权限=失败
   （sudo 启动的 runner 会得到明确错误而非假成功）。作业中强停会让 GitHub 把作业标记失败——
   UI 在此情形弹确认。
7. **受管 runner detached**：工具退出不杀 runner（与"终端里跑"等价），下次启动自动重连。
   验证模式（--dry-run/--smoke）以 `boot({autoStart:false, persist:false})` 保证零副作用。
8. **隐藏窗口零 evaluate（2026-10-27 闪窗事故）**：对隐藏窗口 `evaluate` 会把它**重新显示并
   抢焦点**——bisect 实证 evaluate 是唯一有此副作用的宿主原语（drainIpcMessages/setTooltip/
   setMenu/setIcon/isVisible/getBounds 均无辜）。Windows 上 X 关闭可能不发 `visibleChange`，
   所以可见性门控必须 fail-closed：每轮推送前以原生 `isVisible()` 实证（不信事件、缺形状
   兜底即视为隐藏），隐藏期推送/命令轮询全静默（唯一的 native 流量是 1s 慢轮询探测复显，
   复显即 offset 清零全量重推）；推送风暴中途发现隐藏立即中止余包。回归锁在
   `test/window-gating.test.ts`（假句柄模拟事件缺位）。教训：v0.1 的"修好"只是 macOS 上
   事件恰好工作；门控逻辑信任了事件而非事实，换平台即复发。
9. **显式包身份（2026-10-27 npx 启动崩溃）**：darwin 上 `createTray` 会从入口目录向上遍历
   找 package.json 推导包身份（`resolveOpenTrayPackageIdentity`），且 `readManifestIdentity`
   对"存在但缺 name"的 manifest **硬抛**而非跳过——npx 缓存根（`_npx/<hash>/package.json`）
   恰是 npm 生成的无名 manifest，于是 `npx @jixoai/gh-runner` 在全新 Mac 上启动即崩
   （Windows 不走此 darwin-only 分支，所以"Windows 跑不会"）。修法：runtimeOptions 传
   `packageRoot`（入口文件的上一级，本包 manifest 恒有 name；0.36.0 实现首选读取该显式
   身份、类型未声明，窄断言 + 注释）。该身份决定 `~/.opentray/apps/<encoded-name>/` 的
   稳定 bundle 路径，显式传入与既有解析结果一致，老安装不受影响。

## 文件意图

| 文件 | 正交意图 |
|---|---|
| types.ts | 领域模型唯一类型源（无 IO） |
| logparse.ts | 纯函数：控制台行 → 作业事件 |
| tailer.ts | 追加式文件跟随（stat 轮询，网络卷可靠） |
| discover.ts | .runner 元数据（含 BOM）、目录发现、进程对账 |
| supervisor.ts | run.sh 进程组拉起/终止 |
| config.ts | 工具配置持久化（~/Library/Application Support/runner-fleet） |
| register.ts | 注册流水线（解包→去隔离→config.sh→校验） |
| fleet.ts | 实例注册表 + 进程/日志两面编排 + 快照发射 |
| tray.ts | 快照 → 托盘图标/tooltip/菜单投影 |
| window.ts | appMode 窗口 + summary/log 双通道推送 + 命令路由 |
| main.ts | 组装、生命周期、--dry-run/--smoke/--probe 验证模式 |
| ui/index.html | 实例卡 + 实时日志面板 + 注册表单（无桥时进入演示模式） |

## 验证矩阵

| 门 | 命令 | 覆盖 |
|---|---|---|
| typecheck | `pnpm typecheck` | 类型安全 |
| 单测 | `pnpm test` | logparse（真实日志行样本）+ Fleet E2E（spawn→解析→停止→外部对账） |
| 真实数据 | `node dist/main.mjs --dry-run 2` | 4 台真实 runner 的发现/状态/最近结果（只读） |
| 真实闭环 | `node dist/main.mjs --smoke` | 真实托盘+窗口，hello/ack 协议闭环（/tmp/runner-fleet-smoke.json） |
| 桥探针 | `node dist/main.mjs --probe` | 页面桥真实形态取证（/tmp/runner-fleet-probe.json） |
| 视觉 | 浏览器演示模式 + 实机截图 | vision 子代理判读 |
