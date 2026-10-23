# Security Policy

## 报告安全问题

请通过 GitHub Security Advisories（仓库 -> Security -> Advisories -> Report a vulnerability）私下报告，不要在公开 issue 中披露细节。

- 支持范围：当前 main 分支与最近一个 release。
- 请附：受影响版本/commit、复现步骤、影响面、可能的修复方向。
- 我们会在 7 天内确认收到，并在修复发布后致谢（如你愿意署名）。

## 安全模型（摘要）

- **手机本机模式**：DSH Worker 运行在 WKWebView 内；静态资源由 127.0.0.1 本地服务提供（固定端口 52019，仅回环、校验 Host、路径穿越防护）。
- **桌面连接模式**：`desktop/gateway.mjs` 默认只监听 127.0.0.1；鉴权使用 Bearer 配对令牌（timingSafeEqual），Host/Origin 白名单，鉴权失败限流，请求体与导入文件大小受限；对外错误信息脱敏。
- **令牌与凭据**：API Key 仅保存在本机（localStorage / 设置），不随仓库分发；连接器 token 只写本机私有目录，可用 `node tools/remote.mjs --rotate` 轮换。
- **隧道**：cloudflared 快速隧道在 Cloudflare 边缘终止 TLS；Bearer 令牌是唯一访问控制，请勿外传 endpoint+token 组合。
- **构建产物**：CI 固定 Action SHA 与 Xcode 版本，构建后校验资源与版本号，并生成 SLSA provenance；无签名 IPA 需要自行重签名，校验 sha256 后再安装。

## 已知边界

- 未签名的 IPA 只能侧载，安装链路的安全性依赖你信任的签名工具。
- 手机端 localStorage 受 WebView 配额限制；敏感信息不要长期留在会话记录里。
