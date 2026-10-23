import Foundation
import CryptoKit

/// 从云服务器拉取最新 Web 包，实现「服务器编译、App 内自动更新」。
/// 服务器端提供 /files.json（version + 每个文件的 sha256/size），App 下载并校验后
/// 写入 Documents/Web；LocalWebServer 会优先服务该目录，无需重装 IPA。
final class WebUpdater {
    static let baseURL = URL(string: "https://103.85.227.144.sslip.io/")!
    static let manifestURL = baseURL.appendingPathComponent("files.json")
    private static let versionKey = "dsh.webVersion"
    private static let fileManager = FileManager.default
    private static var running = false

    struct Manifest: Decodable {
        let version: String
        let files: [Entry]
    }
    struct Entry: Decodable {
        let path: String
        let sha256: String
        let size: Int
    }

    static func storageRoot() -> URL {
        fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Web", isDirectory: true)
    }

    static func hasUpdatableWeb() -> Bool {
        fileManager.fileExists(atPath: storageRoot().appendingPathComponent("index.html").path)
    }

    @MainActor
    static func checkAndUpdate(onUpdated: @escaping () -> Void) {
        guard !running else { return }
        running = true
        Task.detached(priority: .utility) {
            defer { running = false }
            do {
                let manifest = try await fetchManifest()
                let localVersion = UserDefaults.standard.string(forKey: versionKey)
                if manifest.version == localVersion, hasUpdatableWeb() { return }
                try await apply(manifest)
                UserDefaults.standard.set(manifest.version, forKey: versionKey)
                await MainActor.run { onUpdated() }
            } catch {
                // 静默失败：继续使用当前 Web 包（首次安装时为内置包）。
                NSLog("[WebUpdater] update skipped: \(error.localizedDescription)")
            }
        }
    }

    private static func fetchManifest() async throws -> Manifest {
        var components = URLComponents(url: manifestURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "t", value: String(Int(Date().timeIntervalSince1970)))]
        var request = URLRequest(url: components.url!)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw URLError(.badServerResponse) }
        let manifest = try JSONDecoder().decode(Manifest.self, from: data)
        guard !manifest.version.isEmpty, !manifest.files.isEmpty, manifest.files.count < 500 else { throw URLError(.cannotParseResponse) }
        return manifest
    }

    private static func apply(_ manifest: Manifest) async throws {
        let documents = fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let temp = documents.appendingPathComponent("WebUpdate-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: temp) }
        try fileManager.createDirectory(at: temp, withIntermediateDirectories: true)

        for entry in manifest.files {
            guard !entry.path.hasPrefix("/"), !entry.path.contains(".."), !entry.path.contains("\0") else {
                throw URLError(.fileDoesNotExist)
            }
            let destination = temp.appendingPathComponent(entry.path)
            try fileManager.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            var request = URLRequest(url: baseURL.appendingPathComponent(entry.path))
            request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            request.timeoutInterval = 60
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw URLError(.badServerResponse) }
            guard data.count == entry.size else { throw URLError(.cannotDecodeContentData) }
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard digest == entry.sha256.lowercased() else { throw URLError(.cannotDecodeContentData) }
            try data.write(to: destination, options: .atomic)
        }
        // 原子替换：先移除旧目录，再把校验通过的新目录移到 Documents/Web。
        let root = storageRoot()
        try? fileManager.removeItem(at: root)
        try fileManager.moveItem(at: temp, to: root)
    }
}
