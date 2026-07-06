import Foundation
import Observation

@MainActor
@Observable
final class ProjectInfoStore {
    private let api: MobileAPIService

    private(set) var rfis: [MobileRfi] = []
    private(set) var team: [MobileTeamMember] = []
    private(set) var isLoadingRfis = false
    private(set) var isLoadingTeam = false
    private(set) var rfisError: String?
    private(set) var teamError: String?
    private var loadedRfisProjectID: String?
    private var loadedTeamProjectID: String?

    init(api: MobileAPIService) {
        self.api = api
    }

    var openRfiCount: Int { rfis.filter { $0.status == "open" || $0.status == "draft" }.count }

    func loadRfis(projectID: String, organizationID: String, force: Bool = false) async {
        guard force || loadedRfisProjectID != projectID else { return }
        loadedRfisProjectID = projectID
        isLoadingRfis = true
        defer { isLoadingRfis = false }
        do {
            rfis = try await api.loadRfis(projectID: projectID, organizationID: organizationID)
            rfisError = nil
        } catch is CancellationError {
            return
        } catch {
            if rfis.isEmpty { rfisError = (error as? APIError)?.userMessage ?? "RFIs could not be loaded." }
        }
    }

    func loadTeam(projectID: String, organizationID: String, force: Bool = false) async {
        guard force || loadedTeamProjectID != projectID else { return }
        loadedTeamProjectID = projectID
        isLoadingTeam = true
        defer { isLoadingTeam = false }
        do {
            team = try await api.loadTeam(projectID: projectID, organizationID: organizationID)
            teamError = nil
        } catch is CancellationError {
            return
        } catch {
            if team.isEmpty { teamError = (error as? APIError)?.userMessage ?? "The project team could not be loaded." }
        }
    }
}

extension MobileRfi {
    var dueDateText: String? { MobileDateParser.display(dueDate) }

    var isOpen: Bool { status == "open" || status == "draft" }
}

extension MobileTeamMember {
    var initials: String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first }.map(String.init)
        return letters.joined().uppercased()
    }
}
