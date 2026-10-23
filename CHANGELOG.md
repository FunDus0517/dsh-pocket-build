# Changelog

本文件记录用户可见的变更。版本号以 package.json 为唯一来源（scripts/version.mjs 同步与校验）。

## [0.1.36] - 2026-10-23

### 修复
- App 每次冷启动清除 WKWebView 缓存 / 加时间戳强制走网络，解决「服务器皮肤更新了、App 里还是旧页面」；
- 原生注入兜底：页面若是缓存旧版（没有内联皮肤），自动补加载 custom.css/custom.js；
- 清掉历史遗留 Service Worker；回前台超过 90 秒自动刷新页面；下拉刷新改为忽略缓存。

## [0.1.35] - 2026-10-23

### 修复
- 上次构建漏拷贝鲸鱼图标（脚本语法错误未执行）：本次真正替换 AppIcon/LaunchLogo 并重新构建。

## [0.1.34] - 2026-10-23

### 图标与交互
- 桌面图标换成 DeepSeek 鲸鱼标志（白底黑鲸，1024 全幅；启动图同步换成鲸鱼）；
- 手机端去掉左上角三横杆：改为从屏幕左边缘向右滑调出菜单，菜单内 X / 点右侧空白 / 左滑关闭；

## [0.1.33] - 2026-10-23

### 修复
- ATS：官方界面地址是 http，`NSAllowsArbitraryLoads` 因同时存在 `NSAllowsLocalNetworking` 在 iOS 10+ 被系统忽略，导致 WKWebView 报「App Transport Security policy requires the use of a secure connection」。新增 `NSAllowsArbitraryLoadsInWebContent`，WebView 的 http 加载放行。

## [0.1.32] - 2026-10-23

### 官方界面原生壳
- 修复 `RemoteGUIConfig` 只接受 https 导致 http 官方界面地址被忽略：现在 http/https 都直接加载；
- 原生启动图（`UILaunchScreen` 白底 + 居中 Logo），冷启动不再白屏/闪网页；
- 首次进入显示原生加载层，等页面真正渲染出内容后再无缝切换，避免「Loading plugins…」网页白屏；
- 加载失败改为原生「连接失败/重试」页面（不再注入 HTML 错误页），回到前台自动重试；
- 去掉长按链接预览、滚动条、点击高亮等网页痕迹；GUI 模式不再启动本地运行时。

## [0.1.31] - 2026-10-22

### 移动端优化
- 预置包连接弹窗精简：已内置地址时不再显示「重新发现电脑」和手动配置表单，只保留连接状态与一键重连；
- 记住上次运行位置（手机本机 / 桌面 DSH），重启 App 不再强制切回桌面；
- 连接信息文案针对预置模式调整（内置地址 + 自动重试）；

### 构建
- 个人工作流一次产出两个 IPA：`DSHPocket-mobile-*.ipa`（轻量手机 UI）与 `DSHPocket-guishell-*.ipa`（官方 Web UI 壳）；
- 中转链路开启 frp 代理压缩（`transport.useCompression`），实测资源下行从约 172 KB/s 提升到约 221 KB/s。
## [0.1.30] - 2026-10-22

### 新增
- 新增「官方 GUI 原生壳」模式：个人构建可通过 `DSHRemoteGUIURL` 让 App 直接加载云服务器上的官方 DSH Web GUI（同一份会话历史），带下拉刷新与失败提示；
- `personal-ipa.yml` 支持 `DSH_GUI_URL` secret 注入并校验 Info.plist；
- 公开构建不注入，行为不变。

### 说明
- 该模式是远程官方界面，链路慢时仍会受网络影响；轻量使用仍推荐原生「App 内自动更新」模式。
## [0.1.29] - 2026-10-22

### 新增
- App 内 Web 自动更新：`WebUpdater` 启动时拉取服务器 `files.json`，逐文件 sha256 校验后写入 `Documents/Web`，原子替换并自动刷新；
- `LocalWebServer` 优先服务 `Documents/Web`，无更新时回退内置包；
- 服务器端构建流水线：VPS 每 5 分钟跟随 GitHub main 构建 Web 包，Caddy 以 HTTPS 提供清单与静态资源；
- 预置配置持久化：地址/令牌/自动桌面标记写入 localStorage，Web 包更新后仍免配置。

### 说明
- 仅 Swift 壳改动需要重新打包/重签；Web 层（HTML/JS/Worker/UI）更新在 App 内自动完成。
## [0.1.28] - 2026-10-22

### 修复
- 预置构建优先级修复：内置地址/令牌会覆盖旧版本残留在 localStorage / sessionStorage 里的配置，升级安装后仍然免配置；
- 预置构建启动时把内置地址写回本地存储，避免旧值干扰后续操作；
- 自动连接失败改为 5s / 15s / 30s 退避重试，直到连上或切换到手机本机模式；
- 关于页增加「个人预置版」标识。
## [0.1.27] - 2026-10-22

### 新增
- 支持个人预置构建：CI 通过 `VITE_DSH_LAN_ENDPOINT` / `VITE_DSH_RELAY_ENDPOINT` / `VITE_DSH_RELAY_TOKEN` 把地址与令牌编入 App，安装后免配置、启动自动连接；
- 新增 `.github/workflows/personal-ipa.yml`：手动触发的个人 IPA 构建，只上传 Artifact（不公开 Release）；
- App 预置配置时默认进入桌面模式并自动连接（失败可手动重试）；备用地址默认填中转地址。

### 文档
- README 增加「个人一键构建（免配置 IPA）」步骤与安全提示。
## [0.1.26] - 2026-10-22

### 新增
- 连接器 `--relay <url>`：把自建 frp 中转地址加入手机候选，并自动加入 Host 白名单；
- `tools/endpoints.mjs` 支持 relay 候选（排序：局域网 → 中转 → Cloudflare），新增单测；
- 新增 `tools/relay-supervisor.ps1`：frpc + 连接器守护脚本（计划任务登录自启，30 秒自检）；
- README 增加「公网中转（自建 VPS + frp）」部署步骤。

### 说明
- 这是可选方案，默认仍可用纯局域网或 Cloudflare；frp 二进制不随仓库分发。
## [0.1.25] - 2026-10-22

### 移除
- 移除 Tailscale 集成：`--tailscale` / `--tailscale-direct`、MagicDNS 工具与单测全部删除，连接器不再依赖 Tailscale。

### 变更
- 连接器默认模式改为 `auto`：局域网 + Cloudflare 双地址（家里优先局域网，外出自动用 Cloudflare）；
- `--lan` 仅提供局域网地址；`--cloudflare` 仅提供公网 HTTPS；`endpoints` 候选同步调整；
- README 与 App 注释同步更新；App 多地址自动切换逻辑（v0.1.24）保持不变。
## [0.1.24] - 2026-10-22

### 新增
- 连接器 `--auto`：同时监听局域网与 Tailscale 接口，终端按优先级输出多个手机端地址（家里优先 192.168.x.x，外出用 100.x.x.x）。
- 连接器 `--lan`：只提供局域网地址，不需要 Tailscale。
- `tools/endpoints.mjs`：候选地址生成/排序纯函数 + 5 个单测（Tailscale CGNAT 识别、局域网优先级、去重、端口校验）。
- App「桌面 DSH → 手动配置」新增「备用地址」（每行一个），连接时自动探测首个可达地址。
- App 监听 `online` 与可见性变化：Wi-Fi ↔ 流量切换后自动换到可用地址，失败静默保留现有连接。

### 变更
- 连接器配置与 state 增加 `endpoints` 列表（保留 `endpoint` 兼容字段）；`--stop` 行为不变。
- 文档更新为 --auto 推荐用法；多地址自动切换需要 App v0.1.24+。
## [0.1.23] - 2026-10-22

### 新增
- 双运行时：手机本机 DSH 与桌面 DSH 可同时运行；切换「运行位置」不再销毁另一侧运行时，也不会打断另一边正在生成的回答。
- 手机端与桌面端各自维护 busy/状态/AbortController/流式缓冲，两边可以并行对话。

### 变更
- 断开桌面连接只销毁桌面运行时；手机本机运行时保持。
- 新建会话只停止目标模式正在生成的请求。
- 「运行位置」与「关于」文案更新，说明双模式可同时工作。
## [0.1.22] - 2026-10-22

### 修复
- 连接器 ACL 收紧不再使用 @BT@icacls /inheritance:r@BT@（该参数会让之后创建的子文件丢失 ACL，导致 @BT@--tailscale@BT@ 首次运行 EPERM）；改为仅授予当前用户完全控制，并在写文件后补授权。
- @BT@state.json@BT@/配置文件写入增加 ACL 损坏时的删除重建兜底。
- Windows 下 @BT@where dsh@BT@ 可能先返回无扩展名 shim，导致 spawn ENOENT；优先 .cmd/.exe，并增加全局 npm 安装路径探测。
- 启动前清理占用 3090/3096 的遗留子进程，避免强杀父进程后端口被占。

### 新增
- @BT@--tailscale-direct@BT@：Serve 未启用时的回退模式，直连 Tailscale IPv4（WireGuard 加密、仅 tailnet 内可达）。
- 健康检查按实际绑定地址探测；@BT@--check@BT@ 同时打印两种模式与启用 Serve 的提示。
## [0.1.21] - 2026-10-21

### 新增
- 桌面连接器支持 Tailscale 模式：@BT@node tools/remote.mjs --tailscale@BT@ 通过 @BT@tailscale serve@BT@ 在 443 终止 TLS，手机走 tailnet 直接访问，无需公网/cloudflared。
- @BT@node tools/remote.mjs --check@BT@：只读检查 Tailscale 连接状态与本机 MagicDNS 名称。
- 新增 @BT@tools/tailscale-net.mjs@BT@ 纯函数 + 单测（MagicDNS 规范化、tailnet 通配 Host 推导）。

### 变更
- @BT@--stop@BT@ 在 Tailscale 模式下会清理 @BT@tailscale serve@BT@ 配置；@BT@--revoke@BT@ 一并清理。
- 连接器 Host 白名单按模式自动派生：@BT@*.tail0f283b.ts.net@BT@（Tailscale）或 @BT@*.trycloudflare.com@BT@（cloudflared）。
## [0.1.20] - 2026-10-21

### 安全
- 桌面网关默认只监听 127.0.0.1；非回环监听必须配置 DSH_MOBILE_TLS_CERT/KEY，除非显式设置 DSH_MOBILE_LAN=1。
- Host 白名单（非法 Host 返回 421）与 Origin 白名单（不再用请求 Host 回显构造可信源）。
- 鉴权失败按客户端地址限流（429）；server.maxConnections 上限；对外错误信息脱敏，细节只写服务端日志。
- 连接器 token 支持 --rotate / --revoke，不再写进 overlay YAML；Windows 用 icacls 收紧私有目录 ACL。
- cloudflared 固定版本 2026.10.3 + SHA256 校验后执行；支持 DSH_CLOUDFLARED_PATH。
- 本地静态服务增加 Host 校验、失败可重试、CSP/Referrer-Policy/X-Frame-Options 响应头；跨域下载不再写入 Documents。
- iOS 移除 UIBackgroundModes=audio 静音保活（App Review 2.5.4 风险），改为进入后台前主动 flush。

### 数据可靠性
- 聊天持久化升级为 v2：配额不足时按最旧优先裁剪重试，不再 removeItem 清空；解析失败先备份原始数据。
- 图片与 HTML 预览不再落盘；refreshBalance 超时定时器清理；编辑消息写入 overrides，重载后不再回滚/重复。

### 性能
- 流式输出改为 requestAnimationFrame 合批 + memo/useMemo，避免每个 token 全量重渲染。
- 模型目录先渲染 /models 列表，官方目录异步补全，不阻塞首屏（Worker 仍按需启动）。
- IndexedDB 持久化路径过滤改为按路径段匹配，token* 用户文件不再被误排除（文件预览仍是全量列表，后续继续优化）。

### 构建 / 发布
- GitHub Actions 全部固定 commit SHA；runner 升级到 macos-15 + Xcode 16.4（macos-14 将于 2026-11-02 下线）；新增 pull_request 触发与 concurrency 取消。
- 构建后校验 .app 内 Web 资源与 CFBundleShortVersionString/CFBundleVersion；新增 SLSA 构建来源证明。
- tag v* 自动创建 Release（IPA + sha256）；artifact 名带 commit SHA、保留 14 天。
- pack-runtime 所有锚点不匹配即失败；VFS 镜像尺寸门禁；finalize-web 二进制安全哈希、拷贝前清理目标目录。
- 新增 scripts/version.mjs 作为版本单一来源；新增 scripts/ensure-runtime.mjs 构建前置检查。

### 工程
- 新增 SECURITY.md、CODEOWNERS、dependabot.yml、CHANGELOG.md；删除 7 条失效 overrides。
- README 删除已废弃的 bore.pub 零配置流程，更新环境变量表与安装校验步骤。

## [0.1.19] - 2026-10-21

- 全屏 UI、加号菜单、回复来源与复制入口、键盘联动。
- 安全修复：私有 HTTPS 连接器、API Key 防抖/HTTPS、存储防白屏、改名/前缀/设置修复。
- 详见 README 的 v0.1.19 章节。
