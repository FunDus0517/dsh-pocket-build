import SwiftUI
import WebKit
import UIKit
import UniformTypeIdentifiers
import PhotosUI

final class NoAccessoryWebView: WKWebView {
    override var inputAccessoryView: UIView? { nil }
    override var undoManager: UndoManager? { nil }
}

struct HarnessWebView: UIViewRepresentable {
    let url: URL
    func makeCoordinator() -> Coordinator { Coordinator(origin: url) }
    func makeUIView(context: Context) -> KeyboardContainer {
        UIApplication.shared.applicationSupportsShakeToEdit = false
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        let nativeScript = WKUserScript(source: "window.__dshNativeBridge = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true)
        configuration.userContentController.addUserScript(nativeScript)
        let webView = NoAccessoryWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive
        webView.scrollView.bounces = false
        webView.scrollView.contentInset = .zero
        webView.scrollView.verticalScrollIndicatorInsets = .zero
        context.coordinator.webView = webView
        let container = KeyboardContainer(webView: webView)
        webView.load(URLRequest(url: url))
        // 启动后检查云端 Web 包（服务器编译完成的新版本），更新后自动刷新。
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak webView] in
            WebUpdater.checkAndUpdate { [weak webView] in
                webView?.reload()
            }
        }
        return container
    }
    func updateUIView(_ uiView: KeyboardContainer, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, UIDocumentPickerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate, PHPickerViewControllerDelegate {
        weak var webView: WKWebView?
        private let origin: URL
        private var flushObserver: NSObjectProtocol?
        private var contentProcessRecoveries = 0
        init(origin: URL) {
            self.origin = origin
            super.init()
            flushObserver = NotificationCenter.default.addObserver(forName: .dshFlushRequest, object: nil, queue: .main) { [weak self] _ in
                self?.flushNow()
            }
        }
        deinit { if let flushObserver { NotificationCenter.default.removeObserver(flushObserver) } }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let destination = action.request.url else { decisionHandler(.cancel); return }
            if action.targetFrame?.isMainFrame == true, destination.scheme == "dshpick" { presentDocumentPicker(); decisionHandler(.cancel); return }
            if action.targetFrame?.isMainFrame == true, destination.scheme == "dshcamera" { presentCamera(); decisionHandler(.cancel); return }
            if action.targetFrame?.isMainFrame == true, destination.scheme == "dshphotos" { presentPhotoPicker(); decisionHandler(.cancel); return }
            // 先校验 origin 再决定下载：跨域下载直接取消，避免任意站点把文件写进 Documents。
            let allowed = destination.host == origin.host && destination.port == origin.port || destination.scheme == "blob"
            if allowed {
                decisionHandler(action.shouldPerformDownload ? .download : .allow)
            } else if action.shouldPerformDownload {
                decisionHandler(.cancel)
            } else if action.navigationType == .linkActivated {
                UIApplication.shared.open(destination)
                decisionHandler(.cancel)
            } else { decisionHandler(.cancel) }
        }
        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
            let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let name = URL(fileURLWithPath: suggestedFilename).lastPathComponent
            let target = documents.appendingPathComponent("\(Int(Date().timeIntervalSince1970))-\(name)")
            completionHandler(target)
        }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url, url.scheme == "https" { UIApplication.shared.open(url) }
            return nil
        }

        // MARK: - 后台 flush / 加载失败兜底

        /// 收到 .dshFlushRequest 时让网页同步会话状态，完成后回报 .dshFlushFinished 给后台任务收尾。
        private func flushNow() {
            guard let webView else {
                NotificationCenter.default.post(name: .dshFlushFinished, object: nil)
                return
            }
            // callAsyncJavaScript 会等 __dshFlushAll 返回的 Promise 结束再回调，避免 flush 没写完就结束后台任务。
            webView.callAsyncJavaScript("return await window.__dshFlushAll?.()", arguments: [:], in: nil, in: .page) { _ in
                NotificationCenter.default.post(name: .dshFlushFinished, object: nil)
            }
        }

        /// 加载失败时注入简单错误文案，避免纯白屏（不引入新的 UI 框架）。
        private func showLoadError(_ message: String, useHTML: Bool = false) {
            if useHTML {
                let escaped = message.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
                let html = "<!doctype html><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><body style=\"margin:20vh auto;max-width:80vw;text-align:center;color:#888;font:15px/1.6 -apple-system\">" + escaped + "</body>"
                webView?.loadHTMLString(html, baseURL: nil)
                return
            }
            let script = "document.body.replaceChildren();const d=document.createElement('div');d.style.cssText='margin:20vh auto;max-width:80vw;text-align:center;color:#888;font:15px/1.6 -apple-system';d.textContent=" + jsLiteral(message) + ";document.body.appendChild(d);"
            sendJS(script)
        }
        private func isCancelled(_ error: Error) -> Bool {
            let ns = error as NSError
            return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            guard !isCancelled(error) else { return }
            showLoadError("页面加载失败：\((error as NSError).localizedDescription)。请重新打开 App 或检查本地服务。")
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            guard !isCancelled(error) else { return }
            showLoadError("页面加载失败：\((error as NSError).localizedDescription)。请重新打开 App 或检查本地服务。")
        }
        /// 渲染进程崩溃：最多自动恢复 2 次，之后注入提示，避免无限重载。
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            guard contentProcessRecoveries < 2 else {
                showLoadError("页面渲染进程意外退出，请重新打开 App。", useHTML: true)
                return
            }
            contentProcessRecoveries += 1
            webView.reloadFromOrigin()
        }

        // MARK: - 原生相机 / 相册（全中文入口，避免系统英文操作表）
        private func presentCamera() {
            guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
                sendJS("window.__dshImageError && window.__dshImageError(\(jsLiteral("当前设备无法使用相机")))")
                return
            }
            let picker = UIImagePickerController()
            picker.sourceType = .camera
            picker.allowsEditing = false
            picker.delegate = self
            topViewController()?.present(picker, animated: true)
        }
        private func presentPhotoPicker() {
            var configuration = PHPickerConfiguration(photoLibrary: .shared())
            configuration.filter = .images
            configuration.selectionLimit = 3
            let picker = PHPickerViewController(configuration: configuration)
            picker.delegate = self
            topViewController()?.present(picker, animated: true)
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picker.dismiss(animated: true)
        }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            picker.dismiss(animated: true)
            if let image = info[.originalImage] as? UIImage { sendImage(image) }
        }
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            for result in results {
                guard result.itemProvider.canLoadObject(ofClass: UIImage.self) else { continue }
                result.itemProvider.loadObject(ofClass: UIImage.self) { [weak self] object, error in
                    guard let self, let image = object as? UIImage else { return }
                    DispatchQueue.main.async { self.sendImage(image) }
                }
            }
        }
        private func sendImage(_ image: UIImage) {
            let maxEdge: CGFloat = 1568
            let scale = min(1, maxEdge / max(image.size.width, image.size.height))
            let target = CGSize(width: max(1, (image.size.width * scale).rounded()), height: max(1, (image.size.height * scale).rounded()))
            let renderer = UIGraphicsImageRenderer(size: target)
            let resized = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
            guard let data = resized.jpegData(compressionQuality: 0.86) else {
                sendJS("window.__dshImageError && window.__dshImageError(\(jsLiteral("图片处理失败")))")
                return
            }
            let base64 = data.base64EncodedString()
            sendJS("window.__dshImagePicked && window.__dshImagePicked(\"image/jpeg\", \(jsLiteral(base64)), \"photo.jpg\")")
        }

        // MARK: - 只允许文本/代码的原生文件选择器
        private func presentDocumentPicker() {
            let extensions = ["txt", "md", "markdown", "json", "jsonl", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "html", "htm", "css", "scss", "less", "csv", "tsv", "yml", "yaml", "toml", "ini", "conf", "sh", "bash", "ps1", "bat", "cmd", "sql", "rs", "go", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "lua", "r", "pl", "tex", "xml", "svg", "log"]
            var types = extensions.compactMap { UTType(filenameExtension: $0) }
            if types.isEmpty { types = [.plainText] }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            topViewController()?.present(picker, animated: true)
        }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {}
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            guard let url = urls.first else { return }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url), data.count <= 2 * 1024 * 1024, let text = String(data: data, encoding: .utf8) else {
                sendJS("window.__dshFileError && window.__dshFileError(\(jsLiteral("只能选择 2 MB 以内的 UTF-8 文本文件")))")
                return
            }
            sendJS("window.__dshFilePicked && window.__dshFilePicked(\(jsLiteral(url.lastPathComponent)), \(jsLiteral(text)))")
        }
        private func sendJS(_ script: String) { webView?.evaluateJavaScript(script, completionHandler: nil) }
        private func jsLiteral(_ value: String) -> String {
            if let data = try? JSONSerialization.data(withJSONObject: [value]), let text = String(data: data, encoding: .utf8) {
                return String(text.dropFirst().dropLast())
            }
            return "\"\""
        }
        private func topViewController() -> UIViewController? {
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            var controller = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController ?? scene?.windows.first?.rootViewController
            while let presented = controller?.presentedViewController { controller = presented }
            return controller
        }
    }
}

/// 随键盘缩放的容器：键盘弹出时缩小 WKWebView 高度，令网页 100dvh 布局自然上移，输入栏贴在键盘上方。
final class KeyboardContainer: UIView {
    let webView: WKWebView
    private var bottomConstraint: NSLayoutConstraint!
    private var observers: [NSObjectProtocol] = []

    init(webView: WKWebView) {
        self.webView = webView
        super.init(frame: .zero)
        backgroundColor = .systemBackground
        webView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(webView)
        bottomConstraint = webView.bottomAnchor.constraint(equalTo: bottomAnchor)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            bottomConstraint
        ])
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] note in self?.updateKeyboard(note) })
        observers.append(center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in self?.apply(inset: 0, duration: 0.25) })
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { observers.forEach { NotificationCenter.default.removeObserver($0) } }

    private func updateKeyboard(_ note: Notification) {
        guard let window, let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let frameInView = window.convert(frame, to: self)
        let overlap = max(0, bounds.maxY - frameInView.minY)
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
        apply(inset: overlap, duration: duration)
    }
    private func apply(inset: CGFloat, duration: Double = 0.25) {
        bottomConstraint.constant = -inset
        UIView.animate(withDuration: duration, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) { self.layoutIfNeeded() }
    }
}
