# @jixoai/gh-runner

菜单栏（托盘）工具：在一台 Mac 或 Windows 机器上管理多台 GitHub Actions self-hosted runner——
自动发现、表单注册（**下载官方最新包 / 导入本地包**）、一键启动/关闭、按运行日志实时分析最近一个
作业（动作）的成功/失败。

基于 [opentray](https://github.com/jixoai/opentray)（托盘 + appMode WebView 窗口 + 原生对话框）。

## 使用

```bash
npx @jixoai/gh-runner          # 或：pnpm dlx @jixoai/gh-runner / npm i -g @jixoai/gh-runner && gh-runner
```

启动后菜单栏出现 `▶N` 图标（N=在跑数，作业中带 `↻M`），控制面板窗口自动打开。

- **自动发现**：扫描配置的 `searchDirs`（默认 macOS `/Volumes/bnqkl/Users/kzf`；Windows
  `C:\actions-runner` 与用户目录）下所有含 `.runner` 的子目录。外部终端/launchd 启动的
  runner 也会被识别（「外部」徽章），可查看状态与日志分析。
- **注册新实例**：`＋ 注册新实例` → 填实例目录（空目录）、名称、org 页面生成的一次性 Token、
  work 目录 → 在「分发包」中选择来源：
  - `⤓ 最新`：从 [actions/runner](https://github.com/actions/runner/releases) 官方 release
    下载当前平台最新包（带进度条，缓存到 `gh-runner/packages/`）；
  - `导入…`：系统文件选择框选择本地已有包（`tar.gz` / `zip`）；
  - 选择列表中此前下载/导入的任意包。
  解包 →（macOS）去隔离 → `config.sh`（Windows 走 `Runner.Listener configure`）注册 → 自动启动。
- **启动/停止**：卡片按钮。作业中强停会弹确认（作业将被 GitHub 标记为失败）。
- **日志分析**：右侧面板实时滚动所选实例的 `_diag` 控制台行；绿=成功、红=失败、蓝=作业开始，
  时间戳恒为中性灰。卡片上常驻「最近动作」的结果与耗时。
- **托盘菜单**：每实例直达（状态一览）、打开面板、退出。

受管 runner 以独立进程运行：退出本工具不会停掉 runner（与终端里跑等价），下次启动自动重连。

## 平台支持

| | macOS | Windows |
|---|---|---|
| 托盘 + WebView 窗口 | ✅ WKWebView | ✅ WebView2 |
| 包格式 | tar.gz / zip | zip / tar.gz |
| 注册入口 | `config.sh` | `Runner.Listener configure` |
| 启动入口 | `run.sh` | `Runner.Listener.exe run` |
| 进程发现/终止 | pgrep + lsof(cwd) / 进程组信号 | PowerShell CIM(ExecutablePath) / `taskkill /T` |

Linux：opentray 的 ext-webview/dialog 不发布 Linux 原生运行时，暂不支持。

## 开发与验证

```bash
pnpm install
pnpm typecheck && pnpm test     # 单测 + mock-runner 全链路 E2E（隔离 HOME，不触碰真实 runner）
pnpm dev                        # 无头：只读打印真实实例状态快照
pnpm smoke                      # 起真实托盘+窗口，验证 host→page→host 闭环 → /tmp/gh-runner-smoke.json
```

架构与实测教训（WKWebView evaluate 体积上限、.runner BOM、spawn 失败三律、lsof realpath 等）
见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 发布

推送 `v*` 标签触发 `release.yml`：CI 门禁 → 构建产物 → npm 可信发布（OIDC，environment
`npm-publish`，带 provenance）。

## License

MIT
