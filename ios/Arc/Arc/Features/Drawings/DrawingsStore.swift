import Foundation
import Observation

@MainActor
@Observable
final class DrawingsStore {
    private let api: MobileAPIService

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
        guard force || loadedProjectID != projectID else { return }
        loadedProjectID = projectID
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil
        do {
            async let remoteSets = api.loadDrawingSets(projectID: projectID, organizationID: organizationID)
            async let remoteSheets = api.loadDrawingSheets(projectID: projectID, organizationID: organizationID)
            let (sets, sheets) = try await (remoteSets, remoteSheets)
            self.sets = sets
            self.sheets = sheets
        } catch is CancellationError {
            return
        } catch {
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
        let detail = try await api.loadDrawingSheetDetail(
            projectID: projectID,
            sheetID: sheetID,
            organizationID: organizationID
        )
        sheetDetails[sheetID] = detail
        return detail
    }

    func sheet(for sheetID: String) -> MobileDrawingSheet? {
        sheets.first { $0.id == sheetID }
    }
}
