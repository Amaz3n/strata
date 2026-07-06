import Foundation
import SwiftData

@MainActor
final class OfflineStore {
    let container: ModelContainer
    private let context: ModelContext
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(inMemory: Bool = false) throws {
        let schema = Schema([
            CachedWorkspaceRecord.self,
            CachedProjectPageRecord.self,
            CachedDailyLogPageRecord.self,
            OfflineDraftRecord.self,
            PendingMutationRecord.self,
            PendingUploadRecord.self,
        ])
        let configuration = ModelConfiguration(
            "ArcOffline",
            schema: schema,
            isStoredInMemoryOnly: inMemory
        )
        container = try ModelContainer(for: schema, configurations: [configuration])
        context = ModelContext(container)
    }

    func cache(session: MobileSession) throws {
        let data = try encoder.encode(session)
        if let record = try workspaces().first(where: { $0.userID == session.user.id }) {
            record.sessionData = data
            record.cachedAt = .now
        } else {
            context.insert(CachedWorkspaceRecord(userID: session.user.id, sessionData: data))
        }
        try context.save()
    }

    func cachedSession(userID: String) throws -> MobileSession? {
        guard let data = try workspaces().first(where: { $0.userID == userID })?.sessionData else {
            return nil
        }
        return try decoder.decode(MobileSession.self, from: data)
    }

    func cache(projects: [MobileProject], organizationID: String) throws {
        let data = try encoder.encode(projects)
        if let record = try projectPages().first(where: { $0.organizationID == organizationID }) {
            record.projectsData = data
            record.cachedAt = .now
        } else {
            context.insert(CachedProjectPageRecord(organizationID: organizationID, projectsData: data))
        }
        try context.save()
    }

    func cachedProjects(organizationID: String) throws -> [MobileProject] {
        guard let data = try projectPages().first(where: { $0.organizationID == organizationID })?.projectsData else {
            return []
        }
        return try decoder.decode([MobileProject].self, from: data)
    }

    func cache(dailyLogs: [MobileDailyLog], projectID: String) throws {
        let data = try encoder.encode(dailyLogs)
        if let record = try dailyLogPages().first(where: { $0.projectID == projectID }) {
            record.logsData = data
            record.cachedAt = .now
        } else {
            context.insert(CachedDailyLogPageRecord(projectID: projectID, logsData: data))
        }
        try context.save()
    }

    func cachedDailyLogs(projectID: String) throws -> [MobileDailyLog] {
        guard let data = try dailyLogPages().first(where: { $0.projectID == projectID })?.logsData else {
            return []
        }
        return try decoder.decode([MobileDailyLog].self, from: data)
    }

    @discardableResult
    func saveDraft(
        id: UUID = UUID(),
        kind: String,
        organizationID: String,
        projectID: String?,
        payload: Data
    ) throws -> UUID {
        if let draft = try drafts().first(where: { $0.id == id }) {
            draft.kind = kind
            draft.organizationID = organizationID
            draft.projectID = projectID
            draft.payload = payload
            draft.updatedAt = .now
        } else {
            context.insert(OfflineDraftRecord(
                id: id,
                kind: kind,
                organizationID: organizationID,
                projectID: projectID,
                payload: payload
            ))
        }
        try context.save()
        return id
    }

    func drafts(organizationID: String? = nil, projectID: String? = nil) throws -> [OfflineDraftRecord] {
        try drafts()
            .filter { organizationID == nil || $0.organizationID == organizationID }
            .filter { projectID == nil || $0.projectID == projectID }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    func deleteDraft(id: UUID) throws {
        if let draft = try drafts().first(where: { $0.id == id }) {
            context.delete(draft)
            try context.save()
        }
    }

    @discardableResult
    func enqueue(
        path: String,
        method: String,
        organizationID: String,
        projectID: String? = nil,
        body: Data? = nil,
        idempotencyKey: String = UUID().uuidString
    ) throws -> UUID {
        if let existing = try mutations().first(where: { $0.idempotencyKey == idempotencyKey }) {
            return existing.id
        }
        let mutation = PendingMutationRecord(
            idempotencyKey: idempotencyKey,
            path: path,
            method: method,
            organizationID: organizationID,
            projectID: projectID,
            body: body
        )
        context.insert(mutation)
        try context.save()
        return mutation.id
    }

    func dueMutations(at date: Date = .now) throws -> [PendingMutationRecord] {
        try mutations()
            .filter { $0.state == "pending" && $0.nextAttemptAt <= date }
            .sorted { $0.createdAt < $1.createdAt }
    }

    func pendingMutationCount() throws -> Int {
        try mutations().count
    }

    func complete(_ mutation: PendingMutationRecord) throws {
        context.delete(mutation)
        try context.save()
    }

    func retry(_ mutation: PendingMutationRecord, error: Error, now: Date = .now) throws {
        mutation.attemptCount += 1
        let delay = min(900, 5 * pow(2, Double(max(0, mutation.attemptCount - 1))))
        mutation.nextAttemptAt = now.addingTimeInterval(delay)
        mutation.lastError = String(describing: error)
        try context.save()
    }

    func fail(_ mutation: PendingMutationRecord, error: Error) throws {
        mutation.state = "failed"
        mutation.lastError = String(describing: error)
        try context.save()
    }

    func enqueueUpload(
        _ attachment: DailyLogAttachmentDraft,
        organizationID: String,
        projectID: String,
        dailyLogID: String
    ) throws {
        guard !(try uploads().contains { $0.id == attachment.id }) else { return }
        context.insert(PendingUploadRecord(
            id: attachment.id,
            organizationID: organizationID,
            projectID: projectID,
            dailyLogID: dailyLogID,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            localPath: attachment.localPath
        ))
        try context.save()
    }

    func pendingUploads() throws -> [PendingUploadRecord] {
        try uploads().sorted { $0.createdAt < $1.createdAt }
    }

    func completeUpload(_ upload: PendingUploadRecord) throws {
        context.delete(upload)
        try context.save()
    }

    func failUpload(_ upload: PendingUploadRecord, error: Error) throws {
        upload.attemptCount += 1
        upload.lastError = String(describing: error)
        try context.save()
    }

    func cancelUploads(dailyLogID: String) throws -> [String] {
        let matches = try uploads().filter { $0.dailyLogID == dailyLogID }
        let paths = matches.map(\.localPath)
        matches.forEach(context.delete)
        if !matches.isEmpty { try context.save() }
        return paths
    }

    private func workspaces() throws -> [CachedWorkspaceRecord] {
        try context.fetch(FetchDescriptor<CachedWorkspaceRecord>())
    }

    private func projectPages() throws -> [CachedProjectPageRecord] {
        try context.fetch(FetchDescriptor<CachedProjectPageRecord>())
    }

    private func dailyLogPages() throws -> [CachedDailyLogPageRecord] {
        try context.fetch(FetchDescriptor<CachedDailyLogPageRecord>())
    }

    private func drafts() throws -> [OfflineDraftRecord] {
        try context.fetch(FetchDescriptor<OfflineDraftRecord>())
    }

    private func mutations() throws -> [PendingMutationRecord] {
        try context.fetch(FetchDescriptor<PendingMutationRecord>())
    }

    private func uploads() throws -> [PendingUploadRecord] {
        try context.fetch(FetchDescriptor<PendingUploadRecord>())
    }
}
