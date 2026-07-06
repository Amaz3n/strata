import Foundation
import ImageIO
import Observation
import QuickLookThumbnailing
import UIKit

@MainActor
@Observable
final class DocumentsStore {
    private let api: MobileAPIService
    private let thumbnailCache = NSCache<NSString, UIImage>()

    init(api: MobileAPIService) {
        self.api = api
        thumbnailCache.countLimit = 400
    }

    func contents(projectID: String, folder: String, organizationID: String) async throws -> MobileFiles {
        try await api.loadFiles(projectID: projectID, folder: folder, organizationID: organizationID)
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
    }

    // MARK: - Local cache

    /// Deterministic on-disk location for a file so the gallery viewer can rely
    /// on stable URLs and repeat opens are instant. The `updatedAt` token busts
    /// the cache if the file is replaced server-side.
    nonisolated func localURL(for file: MobileFile) -> URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let token = String(Int(file.updatedAt.timeIntervalSince1970))
        let directory = caches
            .appendingPathComponent("arc-docs", isDirectory: true)
            .appendingPathComponent("\(file.id)-\(token)", isDirectory: true)
        return directory.appendingPathComponent(file.fileName)
    }

    /// Downloads the file to its deterministic local path if not already present.
    @discardableResult
    func ensureLocal(_ file: MobileFile) async throws -> URL {
        let destination = localURL(for: file)
        if FileManager.default.fileExists(atPath: destination.path) { return destination }
        guard let url = file.downloadUrl else { throw APIError.notFound }
        let (data, _) = try await URLSession.shared.data(from: url)
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: destination, options: .atomic)
        return destination
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
        "\(file.id)-\(Int(file.updatedAt.timeIntervalSince1970))" as NSString
    }

    private nonisolated static func generateThumbnail(for file: MobileFile, localURL: URL) async -> UIImage? {
        // Images: downsample the signed remote URL directly — no full download.
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
