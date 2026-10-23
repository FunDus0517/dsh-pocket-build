import Foundation
import SwiftUI
import UIKit
import WebKit

/// 官方 DSH Web GUI 的原生壳：个人构建下 Info.plist 的 DSHRemoteGUIURL 非空时启用。
/// 直接加载服务器上的官方界面（同一个 DSH 进程、同一份会话历史），不再是浏览器标签页。
enum RemoteGUIConfig {
    static var url: URL? {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "DSHRemoteGUIURL") as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty,
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else {
            return nil
        }
        // 官方 UI 既可能部署在 https（带证书的域名/中转），也可能部署在 http（自建服务器/IP）。
        // 只接受 http(s)，其它 scheme（file/javascript/data…）一律回退本地模式。
        return url
    }
}

/// 原生壳的加载阶段：由 WKWebView 的导航回调 + 内容轮询驱动，SwiftUI 据此显示原生覆盖层。
enum RemoteGUILoadPhase: Equatable {
    case loading
    case ready
    case failed(String)
}

/// 原生壳状态容器。所有方法都在主线程调用（WebKit 回调与 SwiftUI 更新都在主线程）。
final class RemoteGUIModel: ObservableObject {
    @Published private(set) var phase: RemoteGUILoadPhase = .loading
    @Published private(set) var reloadToken = UUID()

    /// 回到加载态（首次加载、渲染进程崩溃自动恢复、用户点重试）。
    func markLoading() {
        if phase != .loading { phase = .loading }
    }

    func markReady() {
        if phase != .ready { phase = .ready }
    }

    /// 失败页只在「尚未加载成功」时显示，避免已有界面的下拉刷新抖动把整页换成错误页。
    func markFailed(_ message: String) {
        guard phase == .loading else { return }
        phase = .failed(message)
    }

    func retry() {
        phase = .loading
        reloadToken = UUID()
    }
}

/// 全屏原生壳：底层是官方 Web UI 的 WKWebView，上层是原生启动图 / 原生错误页。
/// 加载完成前只露原生启动画面，绝不出现网页白屏或 “Loading plugins”。
struct RemoteGUIHostView: View {
    let url: URL
    @StateObject private var model = RemoteGUIModel()

    init(url: URL) {
        self.url = url
    }

    var body: some View {
        ZStack {
            // 只让白色背景铺满全屏；WebView 内容尊重安全区，避免官方 UI 的菜单按钮被状态栏挡住、
            // 输入栏压到 Home 指示条。
            Color.white.ignoresSafeArea()

            RemoteGUIView(
                url: url,
                reloadToken: model.reloadToken,
                onLoading: { model.markLoading() },
                onReady: { model.markReady() },
                onFailure: { message in model.markFailed(message) }
            )
            .opacity(model.phase == .ready ? 1 : 0)

            if model.phase != .ready {
                RemoteGUILaunchView(phase: model.phase, retry: { model.retry() })
                    .transition(.opacity)
            }
        }
        .background(Color.white.ignoresSafeArea())
        .animation(.easeInOut(duration: 0.2), value: model.phase)
    }
}

/// 原生启动覆盖层：白底 + 居中 DSH 标志 + 小号进度指示；失败时换成原生错误页。
private struct RemoteGUILaunchView: View {
    let phase: RemoteGUILoadPhase
    let retry: () -> Void

    var body: some View {
        ZStack {
            Color.white
            switch phase {
            case .failed(let message):
                RemoteGUIErrorContent(message: message, retry: retry)
            case .loading, .ready:
                VStack(spacing: 18) {
                    Image("LaunchLogo")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 120, height: 120)
                        .accessibilityHidden(true)
                    ProgressView()
                        .progressViewStyle(.circular)
                        .controlSize(.small)
                    Text("正在连接 DSH…")
                        .font(.footnote)
                        .foregroundStyle(Color(.sRGB, white: 0.55, opacity: 1))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// 原生错误页：纯 SwiftUI，不加载任何 HTML，失败时给「重试」。
private struct RemoteGUIErrorContent: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 42, weight: .regular))
                .foregroundStyle(Color(.sRGB, white: 0.45, opacity: 1))
                .accessibilityHidden(true)
            Text("连接失败")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color(.sRGB, white: 0.08, opacity: 1))
            Text(message)
                .font(.footnote)
                .foregroundStyle(Color(.sRGB, white: 0.45, opacity: 1))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Button(action: retry) {
                Text("重试")
                    .font(.body.weight(.semibold))
                    .padding(.horizontal, 34)
                    .padding(.vertical, 11)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color(.sRGB, white: 0.12, opacity: 1))
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.white)
    }
}

/// 官方 Web UI 的 WKWebView 封装：只负责加载、清理网页痕迹，并把加载状态回调给宿主。
struct RemoteGUIView: UIViewRepresentable {
    let url: URL
    let reloadToken: UUID
    let onLoading: () -> Void
    let onReady: () -> Void
    let onFailure: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(url: url, onLoading: onLoading, onReady: onReady, onFailure: onFailure)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // 每次冷启动清掉 WKWebView 缓存，避免页面/皮肤一直用旧版本
        URLCache.shared.removeAllCachedResponses()
        WKWebsiteDataStore.default().removeData(
            ofTypes: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeOfflineWebApplicationCache],
            modifiedSince: .distantPast,
            completionHandler: {}
        )
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.websiteDataStore = .default()
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: RemoteGUIScripting.styles,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false
            )
        )
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: RemoteGUIScripting.noServiceWorker,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: RemoteGUIScripting.skinFallback,
                injectionTime: .atDocumentEnd,
                forMainFrameOnly: true
            )
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.backgroundColor = .white
        webView.scrollView.backgroundColor = .white
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.scrollView.alwaysBounceVertical = true
        webView.scrollView.bouncesZoom = false
        webView.scrollView.maximumZoomScale = 1
        webView.scrollView.minimumZoomScale = 1
        webView.scrollView.keyboardDismissMode = .interactive

        // UIRefreshControl 是唯一刷新手势（下拉刷新），不保留地址栏/手势回退等浏览器行为。
        let refreshControl = UIRefreshControl()
        refreshControl.addTarget(context.coordinator, action: #selector(Coordinator.handleRefresh), for: .valueChanged)
        webView.scrollView.refreshControl = refreshControl

        context.coordinator.webView = webView
        context.coordinator.appliedReloadToken = reloadToken
        context.coordinator.loadFromServer()
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // 只有「重试」会换 reloadToken；加载完成、错误页等状态变化不触发重新加载。
        guard context.coordinator.appliedReloadToken != reloadToken else { return }
        context.coordinator.appliedReloadToken = reloadToken
        context.coordinator.loadFromServer()
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        weak var webView: WKWebView?
        var appliedReloadToken: UUID?

        private let url: URL
        private let onLoading: () -> Void
        private let onReady: () -> Void
        private let onFailure: (String) -> Void

        private var pollWorkItem: DispatchWorkItem?
        private var pollGeneration = 0
        private var pollAttempts = 0
        private var contentProcessRecoveries = 0
        private var lastLoadAt: Date?
        private var reloadObserver: NSObjectProtocol?

        init(url: URL, onLoading: @escaping () -> Void, onReady: @escaping () -> Void, onFailure: @escaping (String) -> Void) {
            self.url = url
            self.onLoading = onLoading
            self.onReady = onReady
            self.onFailure = onFailure
            super.init()
            reloadObserver = NotificationCenter.default.addObserver(
                forName: .dshRemoteReloadRequest,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.reloadIfStale()
            }
        }

        deinit {
            pollWorkItem?.cancel()
            if let observer = reloadObserver {
                NotificationCenter.default.removeObserver(observer)
            }
        }

        // MARK: - 加载与刷新

        func loadFromServer() {
            cancelPolling()
            contentProcessRecoveries = 0
            guard let webView = webView else { return }
            var request = URLRequest(url: Self.cacheBusted(url))
            request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            request.timeoutInterval = 60
            webView.load(request)
            lastLoadAt = Date()
        }

        /// 给初始 URL 加时间戳，强制重新走 302→303→200，不吃任何层缓存。
        static func cacheBusted(_ url: URL) -> URL {
            guard var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
            var items = comps.queryItems ?? []
            items.removeAll { $0.name == "_t" }
            items.append(URLQueryItem(name: "_t", value: String(Int(Date().timeIntervalSince1970))))
            comps.queryItems = items
            return comps.url ?? url
        }

        /// 长时间后台回前台时，主动刷新一次页面（服务器皮肤更新后无需重装）。
        func reloadIfStale() {
            let age = Date().timeIntervalSince(lastLoadAt ?? .distantPast)
            guard age > 90 else { return }
            loadFromServer()
        }

        @objc func handleRefresh() {
            cancelPolling()
            guard let webView = webView else { return }
            if webView.url != nil {
                webView.reloadFromOrigin()
            } else {
                var request = URLRequest(url: Self.cacheBusted(url))
                request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
                webView.load(request)
            }
        }

        // MARK: - 加载完成判定：轮询页面正文，等官方 UI 真正渲染出来再撤掉原生启动图

        private func beginPolling() {
            cancelPolling()
            pollAttempts = 0
            schedulePoll(generation: pollGeneration)
        }

        private func cancelPolling() {
            pollGeneration += 1
            pollWorkItem?.cancel()
            pollWorkItem = nil
        }

        private func schedulePoll(generation: Int) {
            let work = DispatchWorkItem { [weak self] in
                guard let self = self, self.pollGeneration == generation else { return }
                self.pollContentReady(generation: generation)
            }
            pollWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
        }

        private func pollContentReady(generation: Int) {
            guard let webView = webView else {
                onFailure("网页视图已释放，请重新打开 App。")
                return
            }
            pollAttempts += 1
            webView.evaluateJavaScript("document.body && document.body.innerText.trim().length > 60") { [weak self] result, _ in
                guard let self = self, self.pollGeneration == generation else { return }
                let isReady = (result as? NSNumber)?.boolValue ?? (result as? Bool) ?? false
                if isReady {
                    self.finishLoading()
                } else if self.pollAttempts >= 60 {
                    webView.scrollView.refreshControl?.endRefreshing()
                    self.onFailure("页面加载超时，请检查网络后点击重试。")
                } else {
                    self.schedulePoll(generation: generation)
                }
            }
        }

        private func finishLoading() {
            cancelPolling()
            webView?.scrollView.refreshControl?.endRefreshing()
            onReady()
        }

        // MARK: - WKNavigationDelegate

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            cancelPolling()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            beginPolling()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            handleNavigationFailure(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            handleNavigationFailure(error)
        }

        /// 渲染进程崩溃：自动重载一次；再崩溃就显示原生错误页，避免无限重载。
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            cancelPolling()
            webView.scrollView.refreshControl?.endRefreshing()
            onLoading()
            if contentProcessRecoveries < 1 {
                contentProcessRecoveries += 1
                var request = URLRequest(url: url)
                request.cachePolicy = .reloadRevalidatingCacheData
                webView.load(request)
            } else {
                onFailure("页面渲染进程意外退出，请点击重试。")
            }
        }

        private func handleNavigationFailure(_ error: Error) {
            webView?.scrollView.refreshControl?.endRefreshing()
            cancelPolling()
            guard !isIgnorableNavigationError(error) else { return }
            let detail = (error as NSError).localizedDescription
            onFailure("无法连接 DSH 服务器，请检查网络后点击重试。\n" + detail)
        }

        private func isIgnorableNavigationError(_ error: Error) -> Bool {
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return true }
            // WebKitErrorDomain 102 = frame load interrupted（被新导航/策略打断），不是真正的网络失败。
            if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return true }
            return false
        }

        // MARK: - WKUIDelegate

        /// 官方 UI 里 target=_blank 的链接：http(s) 留在同一个全屏 WebView，其它 scheme 交给系统。
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let target = navigationAction.request.url, navigationAction.targetFrame == nil else { return nil }
            let scheme = target.scheme?.lowercased() ?? ""
            if scheme == "http" || scheme == "https" {
                var request = URLRequest(url: target)
                request.cachePolicy = .reloadRevalidatingCacheData
                webView.load(request)
            } else {
                UIApplication.shared.open(target)
            }
            return nil
        }
    }
}

/// 注入官方 UI 的 documentStart 脚本：抹掉滚动条、点击高亮、下拉回弹光效等网页痕迹。
private enum RemoteGUIScripting {
    /// 清掉历史遗留的 Service Worker（早期网页版注册过，可能缓存旧页面）。
    static let noServiceWorker = """
    (function () {
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
          navigator.serviceWorker.getRegistrations().then(function (rs) {
            rs.forEach(function (r) { r.unregister() })
          }).catch(function () {});
        }
      } catch (e) {}
    })();
    """

    /// 兜底：若页面 HTML 是缓存旧版（没有内联皮肤），从这里补加载皮肤资源。
    static let skinFallback = """
    (function () {
      try {
        if (window.__dshmSwipeTest) { return; }
        var head = document.head || document.documentElement;
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/__custom/custom.css?v=136';
        head.appendChild(link);
        var script = document.createElement('script');
        script.src = '/__custom/custom.js?v=136';
        script.defer = true;
        head.appendChild(script);
      } catch (e) {}
    })();
    """

    static let styles = """
    (function () {
      var style = document.createElement('style');
      style.textContent = [
        'html,body{-webkit-tap-highlight-color:transparent;overscroll-behavior:none;}',
        'html,body{scrollbar-width:none;-ms-overflow-style:none;}',
        '::-webkit-scrollbar{width:0;height:0;display:none;}'
      ].join('');
      (document.head || document.documentElement).appendChild(style);
      document.addEventListener('gesturestart', function (event) { event.preventDefault(); }, { passive: false });
    })();
    """
}
