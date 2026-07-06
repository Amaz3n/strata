import Foundation
import Observation

@MainActor
@Observable
final class DailyLogStore {
    private let api: MobileAPIService
    private let offlineStore: OfflineStore
    private let syncEngine: SyncEngine
    private let networkMonitor: NetworkMonitor

    private(set) var logs: [MobileDailyLog] = []
    private(set) var context = MobileDailyLogContext(scheduleItems: [], tasks: [], punchItems: [], team: [])
    private(set) var isLoading = false
    private(set) var isUsingOfflineData = false
    private(set) var errorMessage: String?
    private(set) var loadedProjectID: String?

    init(api: MobileAPIService, offlineStore: OfflineStore, syncEngine: SyncEngine, networkMonitor: NetworkMonitor) {
        self.api = api
        self.offlineStore = offlineStore
        self.syncEngine = syncEngine
        self.networkMonitor = networkMonitor
    }

    func load(projectID: String, organizationID: String, force: Bool = false) async {
        guard force || loadedProjectID != projectID else { return }
        loadedProjectID = projectID
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil
        let cached = (try? offlineStore.cachedDailyLogs(projectID: projectID)) ?? []
        if !cached.isEmpty {
            logs = cached
            isUsingOfflineData = true
        }

        do {
            async let remoteLogs = api.loadDailyLogs(projectID: projectID, organizationID: organizationID)
            async let remoteContext = api.loadDailyLogContext(projectID: projectID, organizationID: organizationID)
            let (fetchedLogs, fetchedContext) = try await (remoteLogs, remoteContext)
            let pending = cached.filter { pendingLog in
                pendingLog.syncState == "pending" && !fetchedLogs.contains(where: { $0.id == pendingLog.id })
            }
            logs = (fetchedLogs + pending).sorted(by: Self.sortLogs)
            context = fetchedContext
            try offlineStore.cache(dailyLogs: logs, projectID: projectID)
            isUsingOfflineData = false
            await synchronizeUploads()
        } catch is CancellationError {
            return
        } catch {
            if cached.isEmpty { errorMessage = "Daily logs could not be loaded." }
        }
    }

    func refresh(projectID: String, organizationID: String) async {
        await load(projectID: projectID, organizationID: organizationID, force: true)
    }

    func submit(_ draft: DailyLogDraft, projectID: String, organizationID: String) async throws {
        let input = draft.request()
        if networkMonitor.status != .offline {
            do {
                let created = try await api.createDailyLog(input, projectID: projectID, organizationID: organizationID)
                replaceOrInsert(created)
                try queueAttachments(draft.attachments, projectID: projectID, organizationID: organizationID, dailyLogID: input.clientId)
                try offlineStore.cache(dailyLogs: logs, projectID: projectID)
                try deleteDraft(draft.id)
                await synchronizeUploads()
                return
            } catch {
                guard (error as? APIError)?.isRetryable == true else { throw error }
            }
        }

        let body = try JSONEncoder.arc.encode(input)
        try offlineStore.enqueue(
            path: "projects/\(projectID)/daily-logs",
            method: "POST",
            organizationID: organizationID,
            projectID: projectID,
            body: body,
            idempotencyKey: input.clientId
        )
        try queueAttachments(draft.attachments, projectID: projectID, organizationID: organizationID, dailyLogID: input.clientId)
        replaceOrInsert(Self.pendingLog(from: draft, organizationID: organizationID, projectID: projectID))
        try offlineStore.cache(dailyLogs: logs, projectID: projectID)
        try deleteDraft(draft.id)
        syncEngine.mutationWasQueued()
    }

    func update(
        logID: String,
        summary: String,
        weather: String?,
        mentionedUserIDs: [String],
        projectID: String,
        organizationID: String
    ) async throws {
        let input = UpdateDailyLogRequest(summary: summary.nilIfBlank, weather: weather, mentionedUserIds: mentionedUserIDs)
        if networkMonitor.status != .offline {
            do {
                replaceOrInsert(try await api.updateDailyLog(input, projectID: projectID, dailyLogID: logID, organizationID: organizationID))
                try offlineStore.cache(dailyLogs: logs, projectID: projectID)
                return
            } catch {
                guard (error as? APIError)?.isRetryable == true else { throw error }
            }
        }
        let body = try JSONEncoder.arc.encode(input)
        try offlineStore.enqueue(
            path: "projects/\(projectID)/daily-logs/\(logID)",
            method: "PATCH",
            organizationID: organizationID,
            projectID: projectID,
            body: body,
            idempotencyKey: "daily-log-update-\(UUID().uuidString)"
        )
        if let log = logs.first(where: { $0.id == logID }) {
            replaceOrInsert(Self.edited(log, summary: input.summary, weather: weather, mentionedUserIDs: mentionedUserIDs))
            try offlineStore.cache(dailyLogs: logs, projectID: projectID)
        }
        syncEngine.mutationWasQueued()
    }

    func delete(logID: String, projectID: String, organizationID: String) async throws {
        let attachmentPaths = (try? offlineStore.cancelUploads(dailyLogID: logID)) ?? []
        attachmentPaths.forEach { try? FileManager.default.removeItem(atPath: $0) }
        if networkMonitor.status != .offline {
            do {
                try await api.deleteDailyLog(projectID: projectID, dailyLogID: logID, organizationID: organizationID)
                logs.removeAll { $0.id == logID }
                try offlineStore.cache(dailyLogs: logs, projectID: projectID)
                return
            } catch APIError.notFound {
                logs.removeAll { $0.id == logID }
                return
            } catch {
                guard (error as? APIError)?.isRetryable == true else { throw error }
            }
        }
        try offlineStore.enqueue(
            path: "projects/\(projectID)/daily-logs/\(logID)",
            method: "DELETE",
            organizationID: organizationID,
            projectID: projectID,
            idempotencyKey: "daily-log-delete-\(logID)"
        )
        logs.removeAll { $0.id == logID }
        try offlineStore.cache(dailyLogs: logs, projectID: projectID)
        syncEngine.mutationWasQueued()
    }

    func addComment(
        logID: String,
        body: String,
        mentionedUserIDs: [String],
        projectID: String,
        organizationID: String
    ) async throws {
        let clientID = UUID()
        let input = CreateDailyLogCommentRequest(
            clientId: clientID.uuidString,
            body: body,
            mentionedUserIds: mentionedUserIDs
        )
        if networkMonitor.status != .offline {
            do {
                let comment = try await api.createDailyLogComment(
                    input, projectID: projectID, dailyLogID: logID, organizationID: organizationID
                )
                add(comment: comment, to: logID)
                try offlineStore.cache(dailyLogs: logs, projectID: projectID)
                return
            } catch {
                guard (error as? APIError)?.isRetryable == true else { throw error }
            }
        }
        try offlineStore.enqueue(
            path: "projects/\(projectID)/daily-logs/\(logID)/comments",
            method: "POST",
            organizationID: organizationID,
            projectID: projectID,
            body: try JSONEncoder.arc.encode(input),
            idempotencyKey: clientID.uuidString
        )
        add(comment: MobileDailyLogComment(
            id: clientID.uuidString,
            body: body,
            createdAt: .now,
            authorName: "Waiting to sync",
            mentionedUserIds: mentionedUserIDs
        ), to: logID)
        try offlineStore.cache(dailyLogs: logs, projectID: projectID)
        syncEngine.mutationWasQueued()
    }

    func persistAttachment(data: Data, fileName: String, mimeType: String) throws -> DailyLogAttachmentDraft {
        let id = UUID()
        let directory = try attachmentsDirectory()
        let fileURL = directory.appending(path: "\(id.uuidString)-\(fileName)")
        try data.write(to: fileURL, options: .atomic)
        return DailyLogAttachmentDraft(id: id, fileName: fileName, mimeType: mimeType, localPath: fileURL.path)
    }

    func removeAttachment(_ attachment: DailyLogAttachmentDraft) {
        try? FileManager.default.removeItem(atPath: attachment.localPath)
    }

    /// Appends photos to an existing log by queueing them through the same
    /// upload pipeline the composer uses, so it works offline too.
    func addPhotos(
        _ attachments: [DailyLogAttachmentDraft],
        to logID: String,
        projectID: String,
        organizationID: String
    ) async {
        for attachment in attachments {
            try? offlineStore.enqueueUpload(
                attachment,
                organizationID: organizationID,
                projectID: projectID,
                dailyLogID: logID
            )
        }
        syncEngine.mutationWasQueued()
        await synchronizeUploads()
    }

    func synchronizeUploads() async {
        guard networkMonitor.status != .offline else { return }
        let uploads = (try? offlineStore.pendingUploads()) ?? []
        for upload in uploads {
            do {
                let photo = try await api.uploadDailyLogPhoto(
                    fileURL: URL(filePath: upload.localPath),
                    fileName: upload.fileName,
                    mimeType: upload.mimeType,
                    clientID: upload.id,
                    projectID: upload.projectID,
                    dailyLogID: upload.dailyLogID,
                    organizationID: upload.organizationID
                )
                add(photo: photo, to: upload.dailyLogID)
                try? FileManager.default.removeItem(atPath: upload.localPath)
                try offlineStore.completeUpload(upload)
            } catch {
                try? offlineStore.failUpload(upload, error: error)
            }
        }
        if let loadedProjectID { try? offlineStore.cache(dailyLogs: logs, projectID: loadedProjectID) }
    }

    func loadDraft(projectID: String, organizationID: String) -> DailyLogDraft {
        guard let record = try? offlineStore.drafts(organizationID: organizationID, projectID: projectID)
            .first(where: { $0.kind == "daily-log" }),
              let draft = try? JSONDecoder().decode(DailyLogDraft.self, from: record.payload) else {
            return DailyLogDraft()
        }
        return draft
    }

    func saveDraft(_ draft: DailyLogDraft, projectID: String, organizationID: String) {
        guard let payload = try? JSONEncoder().encode(draft) else { return }
        _ = try? offlineStore.saveDraft(
            id: draft.id,
            kind: "daily-log",
            organizationID: organizationID,
            projectID: projectID,
            payload: payload
        )
    }

    func deleteDraft(_ id: UUID) throws { try offlineStore.deleteDraft(id: id) }

    private func queueAttachments(
        _ attachments: [DailyLogAttachmentDraft],
        projectID: String,
        organizationID: String,
        dailyLogID: String
    ) throws {
        for attachment in attachments {
            try offlineStore.enqueueUpload(
                attachment,
                organizationID: organizationID,
                projectID: projectID,
                dailyLogID: dailyLogID
            )
        }
    }

    private func attachmentsDirectory() throws -> URL {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let directory = root.appending(path: "Arc/DailyLogAttachments", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func replaceOrInsert(_ log: MobileDailyLog) {
        logs.removeAll { $0.id == log.id }
        logs.append(log)
        logs.sort(by: Self.sortLogs)
    }

    private func add(comment: MobileDailyLogComment, to logID: String) {
        guard let log = logs.first(where: { $0.id == logID }) else { return }
        replaceOrInsert(Self.copy(log, comments: log.comments + [comment]))
    }

    private func add(photo: MobileDailyLogPhoto, to logID: String) {
        guard let log = logs.first(where: { $0.id == logID }) else { return }
        let photos = (log.photos ?? []).filter { $0.id != photo.id } + [photo]
        replaceOrInsert(Self.copy(log, photos: photos))
    }

    private static func sortLogs(_ left: MobileDailyLog, _ right: MobileDailyLog) -> Bool {
        left.date == right.date ? left.createdAt > right.createdAt : left.date > right.date
    }

    private static func copy(
        _ log: MobileDailyLog,
        comments: [MobileDailyLogComment]? = nil,
        photos: [MobileDailyLogPhoto]? = nil
    ) -> MobileDailyLog {
        MobileDailyLog(
            id: log.id, organizationId: log.organizationId, projectId: log.projectId, date: log.date,
            summary: log.summary, weather: log.weather, createdBy: log.createdBy,
            createdAt: log.createdAt, updatedAt: log.updatedAt, entries: log.entries,
            comments: comments ?? log.comments, mentionedUserIds: log.mentionedUserIds,
            photos: photos ?? log.photos, photoCount: (photos ?? log.photos)?.count ?? log.photoCount,
            syncState: log.syncState
        )
    }

    private static func edited(
        _ log: MobileDailyLog,
        summary: String?,
        weather: String?,
        mentionedUserIDs: [String]
    ) -> MobileDailyLog {
        MobileDailyLog(
            id: log.id, organizationId: log.organizationId, projectId: log.projectId, date: log.date,
            summary: summary, weather: weather, createdBy: log.createdBy,
            createdAt: log.createdAt, updatedAt: .now, entries: log.entries, comments: log.comments,
            mentionedUserIds: mentionedUserIDs, photos: log.photos, photoCount: log.photoCount,
            syncState: "pending"
        )
    }

    private static func pendingLog(from draft: DailyLogDraft, organizationID: String, projectID: String) -> MobileDailyLog {
        let request = draft.request()
        return MobileDailyLog(
            id: request.clientId,
            organizationId: organizationID,
            projectId: projectID,
            date: request.date,
            summary: request.summary,
            weather: request.weather,
            createdBy: nil,
            createdAt: .now,
            updatedAt: .now,
            entries: request.entries.enumerated().map { index, entry in
                MobileDailyLogEntry(
                    id: "\(request.clientId)-\(index)", entryType: entry.entryType,
                    description: entry.description, quantity: nil, hours: entry.hours, progress: entry.progress,
                    scheduleItemId: entry.scheduleItemId, taskId: entry.taskId, punchItemId: entry.punchItemId,
                    location: entry.location, trade: entry.trade, inspectionResult: entry.inspectionResult
                )
            },
            comments: [],
            mentionedUserIds: request.mentionedUserIds,
            photos: [],
            photoCount: draft.attachments.count,
            syncState: "pending"
        )
    }
}

private extension String {
    var nilIfBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
