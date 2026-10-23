import Foundation
import Network

/// 仅本机访问的静态资源服务。固定端口保证 WKWebView 的 origin 在多次启动间稳定，
/// 这样 Web Worker / IndexedDB / 会话状态都能延续。
@MainActor
final class LocalWebServer: ObservableObject {
    @Published private(set) var url: URL?
    @Published private(set) var error: String?
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "ai.dsh.pocket.assets")
    private let port: NWEndpoint.Port = 52019

    func start() {
        guard listener == nil else { return }
        guard Self.webRoot() != nil else {
            error = "缺少手机界面资源（Web 目录）。"
            return
        }
        // 1) 优先只绑定回环地址：requiredLocalEndpoint 已经带了端口，
        //    不能再给 NWListener 传 on:，否则真机上会报 NWError 22 (Invalid argument)。
        let loopback = NWParameters.tcp
        loopback.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)
        if let server = makeListener(parameters: loopback) {
            activate(server)
            return
        }
        error = "无法启动本地服务（端口 52019 可能被占用）。"
    }

    /// 停止监听并允许之后再次 start()。
    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func activate(_ server: NWListener) {
        listener = server
        server.start(queue: queue)
    }

    private func makeListener(parameters: NWParameters, port explicitPort: NWEndpoint.Port? = nil) -> NWListener? {
        do {
            let server: NWListener
            if let explicitPort {
                server = try NWListener(using: parameters, on: explicitPort)
            } else {
                server = try NWListener(using: parameters)
            }
            server.stateUpdateHandler = { [weak self, weak server] state in
                Task { @MainActor in
                    guard let self, let server, self.listener === server else { return }
                    switch state {
                    case .ready:
                        self.url = URL(string: "http://127.0.0.1:52019/")
                        self.error = nil
                    case .failed(let failure):
                        // 失败后清空 listener，下一次 start() 才能重试。
                        self.error = failure.localizedDescription
                        server.cancel()
                        self.listener = nil
                    default:
                        break
                    }
                }
            }
            server.newConnectionHandler = { connection in
                connection.start(queue: DispatchQueue.global(qos: .userInitiated))
                Self.receive(connection, accumulated: Data())
            }
            return server
        } catch {
            return nil
        }
    }

    /// 优先使用 WebUpdater 下载到 Documents/Web 的最新包，没有则回退到 App 内置 Web。
    nonisolated static func webRoot() -> URL? {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let updated = documents.appendingPathComponent("Web", isDirectory: true)
        if FileManager.default.fileExists(atPath: updated.appendingPathComponent("index.html").path) {
            return updated.standardizedFileURL
        }
        return Bundle.main.url(forResource: "Web", withExtension: nil)
    }

    nonisolated private static func receive(_ connection: NWConnection, accumulated: Data) {
        guard let root = webRoot() else { send(connection, status: "404 Not Found"); return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { content, _, complete, failure in
            var bytes = accumulated
            if let content { bytes.append(content) }
            guard bytes.count <= 16_384 else { send(connection, status: "413 Payload Too Large"); return }
            guard let request = String(data: bytes, encoding: .utf8), request.contains("\r\n\r\n") else {
                if complete || failure != nil { connection.cancel() }
                else { receive(connection, accumulated: bytes) }
                return
            }
            let lines = request.components(separatedBy: "\r\n")
            let line = lines.first ?? ""
            let fields = line.split(separator: " ")
            guard fields.count == 3, fields[0] == "GET" || fields[0] == "HEAD" else {
                send(connection, status: "405 Method Not Allowed"); return
            }
            // Host 白名单：拒绝 DNS rebinding / 其他站点伪造 Host 读本地资源。
            let host = lines.dropFirst().first(where: { $0.lowercased().hasPrefix("host:") })
                .map { String($0.dropFirst(5)).trimmingCharacters(in: .whitespaces) }?.lowercased() ?? ""
            guard host == "127.0.0.1:52019" || host == "localhost:52019" else {
                send(connection, status: "403 Forbidden"); return
            }
            let raw = String(fields[1]).components(separatedBy: "?")[0]
            guard let path = raw.removingPercentEncoding, !path.contains("\0") else {
                send(connection, status: "400 Bad Request"); return
            }
            let relative = path == "/" ? "index.html" : String(path.drop(while: { $0 == "/" }))
            let file = root.appendingPathComponent(relative).standardizedFileURL
            guard file.path.hasPrefix(root.standardizedFileURL.path + "/"),
                  let data = try? Data(contentsOf: file) else {
                send(connection, status: "404 Not Found"); return
            }
            let types = ["html": "text/html; charset=utf-8", "js": "application/javascript", "css": "text/css", "svg": "image/svg+xml", "png": "image/png", "webmanifest": "application/manifest+json", "json": "application/json", "bin": "application/octet-stream", "wasm": "application/wasm", "map": "application/json", "ico": "image/x-icon"]
            send(connection, status: "200 OK", body: data, type: types[file.pathExtension] ?? "application/octet-stream", headOnly: fields[0] == "HEAD")
        }
    }

    nonisolated private static func send(_ connection: NWConnection, status: String, body: Data = Data(), type: String = "text/plain", headOnly: Bool = false) {
        let security = "Content-Security-Policy: script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https: http:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: SAMEORIGIN\r\n"
        let header = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\n\(security)Connection: close\r\n\r\n"
        var response = Data(header.utf8)
        if !headOnly { response.append(body) }
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
    }
}
