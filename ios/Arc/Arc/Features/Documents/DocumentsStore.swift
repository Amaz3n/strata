import Foundation
import ImageIO
import Observation
import QuickLookThumbnailing
import UIKit

@MainActor
@Observable
final class DocumentsStore {
    private let api: MobileAPIService
    private var organizationID: String?
    private let thumbnailCache = NSCache<NSString, UIImage>()

    init(api: MobileAPIService) {
        self.api = api
        thumbnailCache.countLimit = 400
    }

    func contents(projectID: String, folder: String, organizationID: String, recursive: Bool = false) async throws -> (files: MobileFiles, isOffline: Bool) {
        self.organizationID = organizationID
        let userID = api.userID
        let cache = FieldReferenceCache(userID: api.userID ?? "signed-out", organizationID: organizationID)
        let key = recursive ? "documents/\(projectID)/all" : "documents/\(projectID)/\(folder)"
        do {
            let files = try await api.loadFiles(projectID: projectID, folder: folder, organizationID: organizationID, recursive: recursive)
            try Task.checkCancellation()
            guard api.userID == userID else { throw CancellationError() }
            try? cache.write(files, key: key)
            return (files, false)
        } catch {
            if (error as? APIError)?.isRetryable == true,
               let saved = cache.read(MobileFiles.self, key: key) { return (saved, true) }
            throw error
        }
    }

    func upload(
        fileURL: URL,
        fileName: String,
        mimeType: String,
        folder: String,
        projectID: String,
        organizationID: String
    ) async throws -> MobileFile {
        try await api.uploadFile(
            fileURL: fileURL,
            fileName: fileName,
            mimeType: mimeType,
            clientID: UUID().uuidString,
            folder: folder,
            category: nil,
            projectID: projectID,
            organizationID: organizationID
        )
    }

    func delete(_ file: MobileFile, projectID: String, organizationID: String) async throws {
        try await api.deleteFile(projectID: projectID, fileID: file.id, organizationID: organizationID)
        thumbnailCache.removeObject(forKey: thumbnailKey(for: file))
        try? FileManager.default.removeItem(at: localURL(for: file).deletingLastPathComponent())
    }

    // MARK: - Local cache

    /// Deterministic on-disk location for a file so the gallery viewer can rely
    /// on stable URLs and repeat opens are instant. The `updatedAt` token busts
    /// the cache if the file is replaced server-side.
    func localURL(for file: MobileFile, organizationID: String? = nil) -> URL {
        let cache = FieldReferenceCache(userID: api.userID ?? "signed-out", organizationID: organizationID ?? self.organizationID ?? "none")
        let token = String(file.updatedAt.timeIntervalSince1970)
        return cache.url(key: "file/\(file.id)/\(token)")
            .appendingPathComponent(URL(fileURLWithPath: file.fileName).lastPathComponent)
    }

    func isDownloaded(_ file: MobileFile) -> Bool {
        FileManager.default.fileExists(atPath: localURL(for: file).path)
    }

    /// Downloads the file to its deterministic local path if not already present.
    @discardableResult
    func ensureLocal(_ file: MobileFile, organizationID: String? = nil) async throws -> URL {
        let userID = api.userID
        let destination = localURL(for: file, organizationID: organizationID)
        if FileManager.default.fileExists(atPath: destination.path) { return destination }
        guard let url = file.downloadUrl else { throw APIError.notFound }
        let (temporaryURL, response) = try await URLSession.shared.download(from: url)
        defer { try? FileManager.default.removeItem(at: temporaryURL) }
        try Task.checkCancellation()
        guard api.userID == userID else { throw CancellationError() }
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw APIError.invalidResponse
        }
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        var directory = destination.deletingLastPathComponent()
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        // Download to disk rather than retaining a large PDF in memory.
        if !FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.copyItem(at: temporaryURL, to: destination)
        }
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
        return destination
    }

    func prepareProjectDownload(projectID: String, organizationID: String) async throws -> [MobileFile] {
        let userID = api.userID
        let manifest = try await api.loadFiles(projectID: projectID, folder: "/", organizationID: organizationID, recursive: true)
        try Task.checkCancellation()
        guard api.userID == userID else { throw CancellationError() }
        self.organizationID = organizationID
        let cache = FieldReferenceCache(userID: userID ?? "signed-out", organizationID: organizationID)
        try cache.write(MobileFiles(folders: [], files: manifest.files), key: "documents/\(projectID)/all")
        for folder in MobileFiles.folderPaths(in: manifest.files) {
            try cache.write(MobileFiles.contents(of: folder, in: manifest.files), key: "documents/\(projectID)/\(folder)")
        }
        return manifest.files
    }

    // MARK: - Thumbnails

    func cachedThumbnail(for file: MobileFile) -> UIImage? {
        thumbnailCache.object(forKey: thumbnailKey(for: file))
    }

    func thumbnail(for file: MobileFile) async -> UIImage? {
        let key = thumbnailKey(for: file)
        if let cached = thumbnailCache.object(forKey: key) { return cached }
        let image = await Self.generateThumbnail(for: file, localURL: localURL(for: file))
        if let image { thumbnailCache.setObject(image, forKey: key) }
        return image
    }

    private func thumbnailKey(for file: MobileFile) -> NSString {
        "\(api.userID ?? "")-\(organizationID ?? "")-\(file.id)-\(file.updatedAt.timeIntervalSince1970)" as NSString
    }

    private nonisolated static func generateThumbnail(for file: MobileFile, localURL: URL) async -> UIImage? {
        if file.isImage, let data = try? Data(contentsOf: localURL) {
            return downsample(data: data, maxPixel: 400)
        }
        // Images: downsample the signed remote URL directly.
        if file.isImage, let url = file.downloadUrl {
            guard let (data, _) = try? await URLSession.shared.data(from: url) else { return nil }
            return downsample(data: data, maxPixel: 400)
        }
        // Other types: render a QuickLook thumbnail, but only if already on disk
        // (e.g. opened before) so browsing never triggers heavy downloads.
        if FileManager.default.fileExists(atPath: localURL.path) {
            let request = QLThumbnailGenerator.Request(
                fileAt: localURL,
                size: CGSize(width: 400, height: 400),
                scale: 2,
                representationTypes: .thumbnail
            )
            if let rep = try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request) {
                return rep.uiImage
            }
        }
        return nil
    }

    private nonisolated static func downsample(data: Data, maxPixel: CGFloat) -> UIImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ] as CFDictionary
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

extension MobileFile {
    var sizeText: String? {
        guard let bytes = sizeBytes else { return nil }
        return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    var systemImage: String {
        if isImage { return "photo" }
        let name = fileName.lowercased()
        if name.hasSuffix(".pdf") { return "doc.richtext" }
        if name.hasSuffix(".doc") || name.hasSuffix(".docx") { return "doc.text" }
        if name.hasSuffix(".xls") || name.hasSuffix(".xlsx") || name.hasSuffix(".csv") { return "tablecells" }
        if name.hasSuffix(".zip") { return "doc.zipper" }
        return "doc"
    }
}


extension MobileFiles {
    static func normalizedFolder(_ folder: String?) -> String {
        let components = (folder ?? "").split(separator: "/").map(String.init)
        return "/" + components.joined(separator: "/")
    }

    static func folderPaths(in files: [MobileFile]) -> [String] {
        var paths: Set<String> = ["/"]
        for file in files {
            var path = ""
            for component in normalizedFolder(file.folderPath).split(separator: "/") {
                path += "/" + component
                paths.insert(path)
            }
        }
        return paths.sorted()
    }

    static func contents(of folder: String, in files: [MobileFile]) -> MobileFiles {
        let current = normalizedFolder(folder)
        let prefix = current == "/" ? "/" : current + "/"
        var counts: [String: Int] = [:]
        var here: [MobileFile] = []
        for file in files {
            let path = normalizedFolder(file.folderPath)
            if path == current { here.append(file) }
            else if path.hasPrefix(prefix), let segment = path.dropFirst(prefix.count).split(separator: "/").first {
                counts[prefix + segment, default: 0] += 1
            }
        }
        let folders = counts.keys.sorted().map { path in
            MobileFolder(path: path, name: String(path.split(separator: "/").last ?? ""), fileCount: counts[path] ?? 0)
        }
        return MobileFiles(folders: folders, files: here)
    }
}
