import SwiftUI
import UIKit

extension Notification.Name {
    /// 进入非 active 场景时由 App 发出，WebView 收到后执行 window.__dshFlushAll?.()。
    static let dshFlushRequest = Notification.Name("dshFlushRequest")
    /// WebView flush 完成（或没有 WebView 可 flush）后发出，App 用它结束后台任务。
    static let dshFlushFinished = Notification.Name("dshFlushFinished")
    /// App 回到前台时请求远程 GUI 检查页面是否过期（后台久了强制刷新）。
    static let dshRemoteReloadRequest = Notification.Name("dshRemoteReloadRequest")
}

@main
struct DSHPocketApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var server = LocalWebServer()
    @StateObject private var flusher = FlushCoordinator()

    /// 个人构建：Info.plist 的 DSHRemoteGUIURL 非空时，App 只做「官方 Web UI 原生壳」。
    private var isRemoteGUIShell: Bool { RemoteGUIConfig.url != nil }

    var body: some Scene {
        WindowGroup {
            content
                .task {
                    // GUI 壳模式只加载官方 Web UI：不启动本地 Harness（省电，也避免本地运行时白白加载）。
                    guard !isRemoteGUIShell else { return }
                    server.start()
                }
                .onChange(of: scenePhase) { _, phase in
                    // 远程 GUI 模式：回到前台时让页面检查是否积压太久，需要刷新。
                    if isRemoteGUIShell {
                        if phase == .active { NotificationCenter.default.post(name: .dshRemoteReloadRequest, object: nil) }
                        return
                    }
                    // 本地模式：离屏 flush。
                    if phase == .active { flusher.finish() } else { flusher.begin() }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let remoteURL = RemoteGUIConfig.url {
            // GUI 壳模式：打开就是全屏官方 DSH Web UI（原生启动图 → 官方界面；失败是原生错误页）。
            RemoteGUIHostView(url: remoteURL)
        } else if let url = server.url {
            HarnessWebView(url: url)
                .ignoresSafeArea(.container)
        } else if let error = server.error {
            VStack(spacing: 16) {
                ContentUnavailableView("启动没有完成", systemImage: "arrow.clockwise", description: Text(error))
                Button("重试") { server.stop(); server.start() }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            ProgressView("正在启动本地 Harness（加载 DSH 运行时）…")
        }
    }
}


/// 离开前台时请求 WebView 做一次会话 flush，并借用一次后台任务给 flush 留出时间。
/// 不再播放静音音频，避免被 App Store 判定为后台保活滥用。
final class FlushCoordinator: ObservableObject {
    private var task: UIBackgroundTaskIdentifier = .invalid
    private var observer: NSObjectProtocol?
    init() {
        observer = NotificationCenter.default.addObserver(forName: .dshFlushFinished, object: nil, queue: .main) { [weak self] _ in
            self?.finish()
        }
    }

    func begin() {
        guard task == .invalid else { return }
        task = UIApplication.shared.beginBackgroundTask(withName: "dsh-flush") { [weak self] in
            self?.finish()
        }
        NotificationCenter.default.post(name: .dshFlushRequest, object: nil)
        // 没有 WebView（启动失败 / 首帧未就绪）就收不到完成通知，兜底 2 秒后收尾。
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.finish() }
    }

    func finish() {
        guard task != .invalid else { return }
        UIApplication.shared.endBackgroundTask(task)
        task = .invalid
    }
}
