import Foundation
import Observation

@MainActor
@Observable
final class DrawingsStore {
    private let api: MobileAPIService
    private var organizationID: String?
    private var scope: String?
    private(set) var isUsingOfflineData = false
    private(set) var downloadRevision = 0

    private struct Snapshot: Codable {
        let sets: [MobileDrawingSet]
        let sheets: [MobileDrawingSheet]
    }

    private var cache: FieldReferenceCache {
        FieldReferenceCache(userID: api.userID ?? "signed-out", organizationID: organizationID ?? "none")
    }

    private(set) var sets: [MobileDrawingSet] = []
    private(set) var sheets: [MobileDrawingSheet] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var loadedProjectID: String?

    // Cache of fully-hydrated sheet details so reopening a sheet is instant.
    private var sheetDetails: [String: MobileDrawingSheetDetail] = [:]

    init(api: MobileAPIService) {
        self.api = api
    }

    var disciplineCounts: [(key: String, count: Int)] {
        var counts: [String: Int] = [:]
        for sheet in sheets { counts[sheet.disciplineKey, default: 0] += 1 }
        return DrawingDisciplinePalette.order
            .compactMap { key in counts[key].map { (key, $0) } }
    }

    func sheets(in setID: String) -> [MobileDrawingSheet] {
        sheets.filter { $0.drawingSetId == setID }
    }

    func cachedDetail(for sheetID: String) -> MobileDrawingSheetDetail? {
        sheetDetails[sheetID]
    }

    func load(projectID: String, organizationID: String, force: Bool = false) async {
        let requestedScope = "\(api.userID ?? "")/\(organizationID)/\(projectID)"
        guard force || scope != requestedScope else { return }
        if scope != requestedScope {
            sets = []
            sheets = []
            sheetDetails.removeAll()
            isUsingOfflineData = false
        }
        scope = requestedScope
        self.organizationID = organizationID
        loadedProjectID = projectID
        let requestedCache = cache
        isLoading = true
        defer { if loadedProjectID == projectID && self.organizationID == organizationID { isLoading = false } }
        errorMessage = nil
        do {
            async let remoteSets = api.loadDrawingSets(projectID: projectID, organizationID: organizationID)
            async let remoteSheets = api.loadDrawingSheets(projectID: projectID, organizationID: organizationID)
            let (sets, sheets) = try await (remoteSets, remoteSheets)
            guard scope == requestedScope else { return }
            self.sets = sets
            self.sheets = sheets
            isUsingOfflineData = false
            try? requestedCache.write(Snapshot(sets: sets, sheets: sheets), key: "drawings/\(projectID)")
        } catch is CancellationError {
            return
        } catch {
            guard scope == requestedScope else { return }
            scope = nil // A failed load must be retryable on the next visit.
            if (error as? APIError)?.isRetryable == true,
               let saved = requestedCache.read(Snapshot.self, key: "drawings/\(projectID)") {
                sets = saved.sets
                sheets = saved.sheets
                isUsingOfflineData = true
            }
            if sheets.isEmpty && sets.isEmpty {
                errorMessage = (error as? APIError)?.userMessage ?? "Drawings could not be loaded."
            }
        }
    }

    func refresh(projectID: String, organizationID: String) async {
        sheetDetails.removeAll()
        await load(projectID: projectID, organizationID: organizationID, force: true)
    }

    @discardableResult
    func loadDetail(sheetID: String, projectID: String, organizationID: String) async throws -> MobileDrawingSheetDetail {
        self.organizationID = organizationID
        let requestedCache = cache
        let requestedUserID = api.userID
        do {
            let detail = try await api.loadDrawingSheetDetail(
                projectID: projectID, sheetID: sheetID, organizationID: organizationID
            )
            if self.organizationID == organizationID, loadedProjectID == projectID, api.userID == requestedUserID {
                sheetDetails[sheetID] = detail
            }
            return detail
        } catch {
            if (error as? APIError)?.isRetryable == true,
               let saved = requestedCache.read(MobileDrawingSheetDetail.self, key: "sheet/\(projectID)/\(sheetID)") {
                return saved
            }
            throw error
        }
    }

    func localImage(for sheet: MobileDrawingSheet) -> URL? {
        _ = downloadRevision
        let url = cache.url(key: "drawing-image/\(sheet.id)/\(sheet.updatedAt.timeIntervalSince1970)")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    func download(sheetID: String, projectID: String, organizationID: String) async throws {
        let userID = api.userID
        let detail = try await loadDetail(sheetID: sheetID, projectID: projectID, organizationID: organizationID)
        let requestedCache = FieldReferenceCache(userID: userID ?? "signed-out", organizationID: organizationID)
        guard let source = detail.sheet.imageUrl else { throw APIError.notFound }
        let destination = requestedCache.url(key: "drawing-image/\(sheetID)/\(detail.sheet.updatedAt.timeIntervalSince1970)")
        if FileManager.default.fileExists(atPath: destination.path) {
            try requestedCache.write(detail, key: "sheet/\(projectID)/\(sheetID)")
            return
        }
        let (temporaryURL, response) = try await URLSession.shared.download(from: source)
        defer { try? FileManager.default.removeItem(at: temporaryURL) }
        try Task.checkCancellation()
        guard api.userID == userID else { throw CancellationError() }
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
              response.mimeType?.hasPrefix("image/") == true else { throw APIError.invalidResponse }
        try requestedCache.prepareDirectory()
        if !FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.copyItem(at: temporaryURL, to: destination)
        }
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
        try requestedCache.write(detail, key: "sheet/\(projectID)/\(sheetID)")
        guard loadedProjectID == projectID, self.organizationID == organizationID, api.userID == userID else { return }
        if let index = sheets.firstIndex(where: { $0.id == sheetID }) { sheets[index] = detail.sheet }
        try requestedCache.write(Snapshot(sets: sets, sheets: sheets), key: "drawings/\(projectID)")
        downloadRevision += 1
    }

    func sheet(for sheetID: String) -> MobileDrawingSheet? {
        sheets.first { $0.id == sheetID }
    }
}
