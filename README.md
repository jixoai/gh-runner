# Runner Fleet

macOS 菜单栏（托盘）工具：在一台 Mac 上管理多台 GitHub Actions self-hosted runner——
表单注册新实例、一键启动/关闭、按运行日志实时分析最近一个作业（动作）的成功/失败。

基于 [opentray](https://github.com/jixoai/opentray)（托盘 + appMode WebView 窗口）。

## 使用

```bash
pnpm install
pnpm start        # 构建并启动（托盘出现 ▶N 图标，自动打开控制面板）
```

- **自动发现**：默认扫描 `/Volumes/bnqkl/Users/kzf` 下所有含 `.runner` 的子目录
  （可用配置文件增改：`~/Library/Application Support/runner-fleet/config.json` 的 `searchDirs`）。
  外部终端启动的 runner 也会被识别（标「外部」），可查看状态但由其原终端控制或点停止接管。
- **注册新实例**：`＋ 注册新实例` → 填实例目录（空目录）、名称、org 页面新生成的一次性
  Token、Labels、work 目录 → 自动复用本机已有的 `actions-runner-osx-*.tar.gz` 解包、
  去隔离、`config.sh --unattended` 注册，成功后自动启动。
- **启动/停止**：卡片按钮。作业中强停会弹确认（作业将被 GitHub 标记为失败）。
- **日志分析**：右侧面板实时滚动所选实例的 `_diag` 控制台行；
  绿行=作业成功、红行=作业失败、蓝行=作业开始。卡片上常驻显示「最近动作」的结果与耗时。
- **托盘菜单**：每实例直达（状态一览）、打开面板、退出。

受管 runner 以独立进程组运行：退出本工具不会停掉 runner（与终端里跑等价），下次启动自动重连。

## 验证模式

```bash
node dist/main.mjs --dry-run 2   # 无头：只读打印真实实例状态快照
node dist/main.mjs --smoke       # 起真实托盘+窗口，验证 host→page→host 闭环 → /tmp/runner-fleet-smoke.json
pnpm test                        # 单测 + mock-runner 全链路 E2E（隔离 HOME，不触碰真实 runner）
```

架构与实测教训（WKWebView evaluate 体积上限、.runner BOM、lsof realpath 等）见 [ARCHITECTURE.md](ARCHITECTURE.md)。
