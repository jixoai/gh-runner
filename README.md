# @jixoai/gh-runner

菜单栏（托盘）工具：在一台 Mac 或 Windows 机器上管理多台 GitHub Actions self-hosted runner——
自动发现、表单注册（**下载官方最新包 / 导入本地包**）、一键启动/关闭、按运行日志实时分析最近一个
作业（动作）的成功/失败。

基于 [opentray](https://github.com/jixoai/opentray)（托盘 + appMode WebView 窗口 + 原生对话框）。

## 使用

```bash
npx @jixoai/gh-runner          # 或：pnpm dlx @jixoai/gh-runner / npm i -g @jixoai/gh-runner && gh-runner
```

### 分发包下载与代理

添加 runner 时，「Runner 安装包」分为「在线下载」和「本地安装包」两条路径。
已有适配包时默认复用，不必重复下载；没有包时默认推荐当前系统与 CPU 架构的最新稳定版，点击「下载并使用」即可。
「下载选项」默认收起，需要时可调整平台、指定版本（如 `2.338.2` 或 `v2.338.2`）或设置自定义加速源。
手动平台支持 macOS（Apple 芯片 / Intel）、Windows（x64 / ARM64）、Linux（x64 / ARM64 / ARM 32 位）。
版本或平台没有对应官方资产时明确报错，不会静默改成其他包。
适配本机的包下载完成后自动选中，供本批所有 runner 共用；其他平台的包可下载留存，但不能在本机注册。
指定版本只决定初始安装包，不会禁用 runner 自身的自动更新。已有包可在「本地安装包」中选择或从电脑导入。
切换到在线下载或修改下载选项后，需下载就绪才能继续注册，不会悄悄使用此前的旧包。

查询最新版、下载包以及 GitHub 资产重定向共用同一套代理设置，不需要额外开启 Node 的代理参数。
匿名 GitHub API 额度耗尽（403 / 429）或 API 暂不可用时，自动从 GitHub 官方发布页解析版本，
不要求添加 PAT、不更改代理或自动改成直连。分发包下载阶段的 403 会单独提示，不能与 API 限流混为一谈。
有官方 SHA-256 时会校验下载内容，校验不通过拒绝使用；相同版本的缓存经校验后直接复用，避免重复下载。
每次开始下载时重新读取，优先级为：`GH_RUNNER_PROXY` → 环境变量 → macOS / Windows 系统静态代理 → 直连。
下载进度下会显示连接方式和代理主机/端口，不显示代理用户名或密码。

- 环境变量支持 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY`、`NO_PROXY` 及对应小写形式；小写优先。
  HTTPS 未单独配置时回退到 HTTP 代理；`ALL_PROXY` 作为缺省代理。`NO_PROXY` 支持域名、端口、通配符和 IP/CIDR。
- macOS 自动读取网络设置中的 HTTP / HTTPS 代理及绕过规则；Windows 读取当前用户 Internet Settings 的静态代理。
  Linux 请使用环境变量。PAC / WPAD、仅 SOCKS 代理不会被静默忽略，请改用代理客户端的 HTTP / 混合端口。
- 可用 `GH_RUNNER_PROXY=http://127.0.0.1:7890` 显式指定，或 `GH_RUNNER_PROXY=direct` 明确禁用下载代理。
  代理连接失败会报错，不会偷偷改为直连；修正设置后点击重新下载。

```bash
HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 pnpm start
```

以上设置仅控制本工具的分发包请求，不会修改系统代理或已启动 runner 的网络设置。

若大包下载本身仍慢或被下载服务器拒绝，可在注册面板展开「下载源与加速」，选择「自定义加速源」。
填写你信任的 HTTPS 服务地址模板（以下是格式示例，不是内置可用服务）：

- GitHub 下载代理：`https://你的加速服务/{url}`，将 `{url}` 替换为官方完整资产地址。
- 自建 CDN / 对象存储：`https://你的下载域名/runner/v{version}/{asset}`，按版本缓存官方原始分发包。

版本、平台和 SHA-256 始终从 GitHub 官方获取，只有大包经过所选加速源；不会将 GitHub 授权凭据发给它。
没有官方 SHA-256 时禁止使用加速源，校验失败拒绝落为可用包。加速源只允许 HTTPS，拒绝不安全跳转；
地址模板不允许嵌入认证信息或查询参数，不会自动切换到陌生公共镜像。配置仅用于本次下载。
速度取决于实际服务质量、缓存命中和网络，不保证任意代理都能提速。维护者如需开箱即用的稳定加速，
需要先部署并维护可信 CDN / 缓存源；本项目不内置未经维护者确认的第三方镜像。

### 管理实例

启动后菜单栏出现 `▶N` 图标（N=在跑数，作业中带 `↻M`），控制面板窗口自动打开。

- **自动发现**：扫描配置的 `searchDirs`（默认 macOS `/Volumes/bnqkl/Users/kzf`；Windows
  `C:\actions-runner` 与用户目录）下所有含 `.runner` 的子目录。外部终端/launchd 启动的
  runner 也会被识别（「外部」徽章），可查看状态与日志分析。
- **批量注册**：`＋ 注册新实例` → 填 GitHub 组织或仓库地址 → 用 `＋ 添加 runner` 添加实例
  （每批 1–10 个）。默认按本机名称递增命名，并为每个实例生成独立的实例目录和 Work 目录；
  可展开自定义。全批共用分发包与授权，选择来源：
  - `⤓ 最新`：从 [actions/runner](https://github.com/actions/runner/releases) 官方 release
    下载当前平台最新包（带进度条，缓存到 `gh-runner/packages/`）。支持暂停、继续和取消；
    暂停会断开下载连接，继续时在服务器支持 Range 与文件校验标识时断点续传，否则重新下载。
    取消或退出应用会清理未完成的 `.part` 文件，不影响已下载完成的包；
  - `导入…`：系统文件选择框选择本地已有包（`tar.gz` / `zip`）；
  - 选择列表中此前下载/导入的任意包。
  分发包准备好后，选择「手机 / 浏览器授权」：手机扫码打开 GitHub 官方设备授权页，输入
  验证码并确认；也可在本机浏览器操作。一次确认后逐个解包、注册并启动，逐项显示结果。
  可取消尚未完成的授权；部分失败不影响已成功的实例，并可返回编辑失败项。
  也保留「已有注册 Token」方式（有效期 1 小时，不是 PAT）。
- **启动/停止**：卡片按钮。作业中强停会弹确认（作业将被 GitHub 标记为失败）。
- **注销 runner**：卡片「注销…」→ 弹出确认框，核对目标与目录、选择是否清理本地文件 → 下一步授权注销，使用手机 / 浏览器重新授权，或填写 GitHub
  移除页面给出的**注销 Token**（不是注册 Token / PAT）。授权后停止实例并执行官方注销命令，
  同步移除 GitHub 注册、清理本机连接凭据。作业中禁止注销；外部终端或系统服务管理的实例需先停止。
- **保留与复用**：注销默认不勾选「同时清理本地实例文件」，仍会完成 GitHub 注销，保留运行程序、工作文件和日志，实例显示为「已注销 · 文件保留」，且关闭自启。
  「打开工作目录」可直接在文件管理器中查看、手动删除工作文件；目录已删除时会提示错误，不会自动删除其他路径。
  保留安装文件后可点击「重新注册」，重新授权、复用原目录和实例名称，无需再次解包，也不清空工作文件。
- **可选清理**：勾选后，仅在 GitHub 注销成功后永久删除该实例目录及其内部工作文件、日志，并移除本地实例记录。注销失败不会删除文件；实例目录外的工作文件、共享下载包不会删除。
  重新注册生成新的 GitHub runner 身份，完成后保持停止，由用户点击启动。若安装文件也已删除，需重新下载分发包并添加实例。
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
注销与重新注册同样不保存账号访问凭据；注销时申请独立的 remove-token，短期 Token 仅通过环境变量传给官方命令。
注销 runner 不等于撤销 GitHub App 的账号授权；工作文件可以包含仓库内容或任务生成的秘密，请按需自行清理。

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
通过托盘菜单或 macOS Dock 选择「退出」会关闭原生窗口和宿主进程，不会自动重新拉起。
当前关闭底层原生进程自动恢复，避免把系统退出误判为崩溃；原生进程异常结束时也会退出管理器，
需要手动重新启动。已启动的 runner 仍在后台独立运行。

架构与实测教训（WKWebView evaluate 体积上限、.runner BOM、spawn 失败三律、lsof realpath 等）
见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 发布

推送 `v*` 标签触发 `release.yml`：CI 门禁 → 构建产物 → npm 可信发布（OIDC，environment
`npm-publish`，带 provenance）。

## License

MIT
