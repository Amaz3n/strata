import Foundation
import Observation

@MainActor
@Observable
final class WorkspaceStore {
    private enum DefaultsKey {
        static let organizationID = "selected-organization-id"
        static let projectID = "selected-project-id"
    }

    private let api: MobileAPIService
    private let offlineStore: OfflineStore
    private let defaults: UserDefaults
    private let logger = AppLogger(.app)

    private(set) var user: MobileUser?
    private(set) var organizations: [MobileOrganization] = []
    private(set) var projects: [MobileProject] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var isUsingOfflineData = false
    private(set) var contextID = UUID()
    var selectedOrganizationID: String?
    var selectedProjectID: String?

    init(api: MobileAPIService, offlineStore: OfflineStore, defaults: UserDefaults = .standard) {
        self.api = api
        self.offlineStore = offlineStore
        self.defaults = defaults
        selectedOrganizationID = defaults.string(forKey: DefaultsKey.organizationID)
        selectedProjectID = defaults.string(forKey: DefaultsKey.projectID)
    }

    var selectedOrganization: MobileOrganization? {
        organizations.first { $0.id == selectedOrganizationID }
    }

    var selectedProject: MobileProject? {
        projects.first { $0.id == selectedProjectID }
    }

    var hasPlatformAccess: Bool {
        organizations.contains { $0.role == "platform" || $0.role?.hasPrefix("platform_") == true }
    }

    func bootstrap() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let session = try await api.loadSession(preferredOrganizationID: selectedOrganizationID)
            try offlineStore.cache(session: session)
            user = session.user
            organizations = session.organizations
            selectedOrganizationID = session.selectedOrganizationId
            isUsingOfflineData = false
            persistSelection()
            try await reloadProjects()
        } catch {
            logger.error("Workspace bootstrap failed", error: error)
            if let userID = api.userID,
               let cached = try? offlineStore.cachedSession(userID: userID) {
                user = cached.user
                organizations = cached.organizations
                selectedOrganizationID = validOrganizationSelection(in: cached)
                projects = (try? cachedProjects()) ?? []
                normalizeProjectSelection()
                isUsingOfflineData = true
                errorMessage = nil
                persistSelection()
            } else {
                errorMessage = describe(error)
            }
        }
    }

    func selectOrganization(_ organizationID: String) async {
        guard organizationID != selectedOrganizationID else { return }
        selectedOrganizationID = organizationID
        selectedProjectID = nil
        projects = []
        contextID = UUID()
        persistSelection()
        projects = (try? offlineStore.cachedProjects(organizationID: organizationID)) ?? []
        normalizeProjectSelection()
        do {
            try await reloadProjects()
        } catch {
            logger.error("Project loading failed", error: error)
            isUsingOfflineData = !projects.isEmpty
            errorMessage = projects.isEmpty ? "Projects could not be loaded." : nil
        }
    }

    func selectProject(_ projectID: String?) {
        guard projectID != selectedProjectID else { return }
        selectedProjectID = projectID
        contextID = UUID()
        persistSelection()
    }

    func reset() {
        user = nil
        organizations = []
        projects = []
        isUsingOfflineData = false
        selectedOrganizationID = nil
        selectedProjectID = nil
        contextID = UUID()
        defaults.removeObject(forKey: DefaultsKey.organizationID)
        defaults.removeObject(forKey: DefaultsKey.projectID)
    }

    private func reloadProjects() async throws {
        guard let organizationID = selectedOrganizationID else {
            projects = []
            selectedProjectID = nil
            return
        }
        projects = try await api.loadProjects(organizationID: organizationID)
        try offlineStore.cache(projects: projects, organizationID: organizationID)
        isUsingOfflineData = false
        normalizeProjectSelection()
        persistSelection()
    }

    private func cachedProjects() throws -> [MobileProject] {
        guard let selectedOrganizationID else { return [] }
        return try offlineStore.cachedProjects(organizationID: selectedOrganizationID)
    }

    private func validOrganizationSelection(in session: MobileSession) -> String? {
        if session.organizations.contains(where: { $0.id == selectedOrganizationID }) {
            return selectedOrganizationID
        }
        if session.organizations.contains(where: { $0.id == session.selectedOrganizationId }) {
            return session.selectedOrganizationId
        }
        return session.organizations.first?.id
    }

    private func normalizeProjectSelection() {
        if !projects.contains(where: { $0.id == selectedProjectID }) {
            selectedProjectID = nil
        }
    }

    private func persistSelection() {
        defaults.set(selectedOrganizationID, forKey: DefaultsKey.organizationID)
        defaults.set(selectedProjectID, forKey: DefaultsKey.projectID)
    }

    private func describe(_ error: Error) -> String {
        guard let apiError = error as? APIError else {
            return "Arc could not load your workspace. \(error.localizedDescription)"
        }
        switch apiError {
        case .transport(let description):
            return "Can't reach Arc (\(description)). Check your connection or the API endpoint."
        case .notFound:
            return "The Arc mobile API wasn't found at this endpoint. The server may not be running or deployed."
        case .unauthorized:
            return "Your Arc session has expired. Sign out and back in."
        case .forbidden:
            return "You don't have access to this workspace."
        case .decoding(let description):
            return "Arc received an unexpected response. \(description)"
        case .server(let statusCode, _, let message, _):
            return "Arc server error (\(statusCode)). \(message ?? "Please try again.")"
        case .rateLimited:
            return "Too many requests. Please wait a moment and try again."
        case .conflict(_, let message), .validation(_, let message, _):
            return message
        case .invalidRequest, .invalidResponse:
            return "Arc could not load your workspace."
        }
    }
}
