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
- **批量注册**：`＋ 注册新实例` → 填 GitHub 组织或仓库地址 → 用 `＋ 添加 runner` 添加实例
  （每批 1–10 个）。默认按本机名称递增命名，并为每个实例生成独立的实例目录和 Work 目录；
  可展开自定义。全批共用分发包与授权，选择来源：
  - `⤓ 最新`：从 [actions/runner](https://github.com/actions/runner/releases) 官方 release
    下载当前平台最新包（带进度条，缓存到 `gh-runner/packages/`）；
  - `导入…`：系统文件选择框选择本地已有包（`tar.gz` / `zip`）；
  - 选择列表中此前下载/导入的任意包。
  分发包准备好后，选择「手机 / 浏览器授权」：手机扫码打开 GitHub 官方设备授权页，输入
  验证码并确认；也可在本机浏览器操作。一次确认后逐个解包、注册并启动，逐项显示结果。
  可取消尚未完成的授权；部分失败不影响已成功的实例，并可返回编辑失败项。
  也保留「已有注册 Token」方式（有效期 1 小时，不是 PAT）。
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

## GitHub 授权配置与安全边界

手机授权需要**本项目自己的 GitHub App**，不是 OAuth App，也不借用 GitHub CLI 的身份。
首次由维护者完成以下设置，普通用户不需要自行创建 App：

1. 由本工具维护者在 GitHub 的 Developer settings → GitHub Apps 创建统一的公开应用，
   开启 **Device Flow**，并将 **Where can this GitHub App be installed?** 设置为 **Any account**。
   正式应用面向第三方组织，不使用 **Only on this account**；各组织无需自行创建 App 或配置 Client ID。
2. 按用途设置权限：组织级 runner 为组织 `Self-hosted runners: Read and write`；
   仓库级 runner 为仓库 `Administration: Read and write`。只管理组织级 runner 时，不要额外申请仓库管理权限。
3. 每个目标组织首次使用时，由有相应权限的管理员安装这个统一 App；后续设备复用该安装。
   **Any account** 只是允许其他账号安装，不会自动授予组织权限，也不代替设备授权。
   使用者仍需有对应目标的管理权限，组织策略或 SSO 可能要求额外批准。
4. 工具已内置公开 **Client ID** `Iv23liwxZ2AQwKPeyeYF`，正常使用和发布均无需额外配置。
   维护者如需临时切换应用，可设置运行时环境变量 `GH_RUNNER_GITHUB_CLIENT_ID`，
   或通过同名仓库 Actions variable 覆盖发布构建默认值；运行时环境变量优先。
   空值或纯空白不会禁用内置应用。注册界面的「GitHub App 配置」也可用于当前会话的临时覆盖。
   Client ID 不是 App ID、Client Secret、私钥或 PAT。

本机无需安装 `gh`，也不使用 `gh auth login`。GitHub Device Flow 要求通过官方网页确认，
可在手机完成，但**不保证出现 GitHub Mobile 推送**。
若选择在本机浏览器登录 GitHub，浏览器可能保留登录会话，需用户自行退出；工具不会自动清理浏览器会话。

凭据生命周期：账号访问 Token / Refresh Token 不落盘、不进入前端或注册子进程，
只用于为本批申请 runner 注册 Token；申请完即释放引用，再开始本机注册。注册 Token
仅存在于内存，通过 `ACTIONS_RUNNER_INPUT_TOKEN` 传给配置进程，不出现在命令行参数中；
工具屏蔽进度输出中的该 Token，成功、失败或取消后均清理临时引用。
不会读写用户已有的 `gh` 凭据、系统凭据库或浏览器登录状态。

这里的清理是**本地释放引用，不是 GitHub 服务端撤销**，也不承诺 JavaScript 物理内存立即清零。
GitHub 上的应用授权及已签发 Token 仍按 GitHub 规则有效，用户可在 GitHub 设置中自行撤销。
已注册 runner 保留自身连接凭据并继续运行；本机管理权限、恶意软件、崩溃转储与不可信工作流仍是安全边界。
批量创建只覆盖同一目标；增加不同目标的 runner 需要单独发起注册。

参考：[GitHub App Device Flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
及 [self-hosted runners REST API](https://docs.github.com/en/rest/actions/self-hosted-runners)。

## 开发与验证

```bash
pnpm install
pnpm build && pnpm start         # 本地真实应用（通过菜单栏图标打开控制面板）
pnpm typecheck && pnpm test     # 单测 + mock-runner 全链路 E2E（隔离 HOME，不触碰真实 runner）
pnpm dev                        # 无头：只读打印真实实例状态快照
pnpm smoke                      # 起真实托盘+窗口，验证 host→page→host 闭环 → /tmp/gh-runner-smoke.json
```

原生控制面板首次打开允许最多 30 秒冷启动；期间重复点击共用一次初始化。
如果打开失败，进程不会因此退出，可再次点击菜单栏图标重试，已有 runner 不受影响。

架构与实测教训（WKWebView evaluate 体积上限、.runner BOM、spawn 失败三律、lsof realpath 等）
见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 发布

推送 `v*` 标签触发 `release.yml`：CI 门禁 → 构建产物 → npm 可信发布（OIDC，environment
`npm-publish`，带 provenance）。

## License

MIT
