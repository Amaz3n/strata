import Foundation
import Observation

@MainActor
@Observable
final class PlatformStore {
    private let api: MobileAPIService

    private(set) var auditEntries: [MobilePlatformAuditEntry] = []
    private(set) var issues: [MobilePlatformIssue] = []
    private(set) var isLoadingAudit = false
    private(set) var isLoadingIssues = false
    private(set) var auditErrorMessage: String?
    private(set) var issuesErrorMessage: String?

    init(api: MobileAPIService) {
        self.api = api
    }

    func loadAudit(force: Bool = false) async {
        guard force || (!isLoadingAudit && auditEntries.isEmpty) else { return }
        isLoadingAudit = true
        auditErrorMessage = nil
        defer { isLoadingAudit = false }
        do {
            auditEntries = try await api.loadPlatformAuditLog()
        } catch {
            auditErrorMessage = describe(error)
        }
    }

    func refreshAudit() async {
        await loadAudit(force: true)
    }

    func loadIssues(force: Bool = false) async {
        guard force || (!isLoadingIssues && issues.isEmpty) else { return }
        isLoadingIssues = true
        issuesErrorMessage = nil
        defer { isLoadingIssues = false }
        do {
            issues = try await api.loadPlatformIssues()
        } catch {
            issuesErrorMessage = describe(error)
        }
    }

    func refreshIssues() async {
        await loadIssues(force: true)
    }

    func createIssue(_ input: CreatePlatformIssueRequest) async throws {
        let issue = try await api.createPlatformIssue(input)
        issues.insert(issue, at: 0)
    }

    private func describe(_ error: Error) -> String {
        guard let apiError = error as? APIError else {
            return error.localizedDescription
        }
        switch apiError {
        case .forbidden:
            return "Platform access is required."
        case .unauthorized:
            return "Your session expired. Sign out and back in."
        case .transport(let description):
            return "Can't reach Arc. \(description)"
        case .server(let statusCode, _, let message, _):
            return "Arc server error (\(statusCode)). \(message ?? "Please try again.")"
        case .validation(_, let message, _), .conflict(_, let message):
            return message
        case .rateLimited:
            return "Too many requests. Please wait a moment and try again."
        case .notFound, .decoding, .invalidRequest, .invalidResponse:
            return "Arc could not load platform data."
        }
    }
}
