import Foundation
import SwiftData

@Model
final class CachedWorkspaceRecord {
    @Attribute(.unique) var userID: String
    var sessionData: Data
    var cachedAt: Date

    init(userID: String, sessionData: Data, cachedAt: Date = .now) {
        self.userID = userID
        self.sessionData = sessionData
        self.cachedAt = cachedAt
    }
}

@Model
final class CachedProjectPageRecord {
    @Attribute(.unique) var organizationID: String
    var projectsData: Data
    var cachedAt: Date

    init(organizationID: String, projectsData: Data, cachedAt: Date = .now) {
        self.organizationID = organizationID
        self.projectsData = projectsData
        self.cachedAt = cachedAt
    }
}

@Model
final class CachedDailyLogPageRecord {
    @Attribute(.unique) var projectID: String
    var logsData: Data
    var cachedAt: Date

    init(projectID: String, logsData: Data, cachedAt: Date = .now) {
        self.projectID = projectID
        self.logsData = logsData
        self.cachedAt = cachedAt
    }
}

@Model
final class OfflineDraftRecord {
    @Attribute(.unique) var id: UUID
    var kind: String
    var organizationID: String
    var projectID: String?
    var payload: Data
    var createdAt: Date
    var updatedAt: Date

    init(
        id: UUID = UUID(),
        kind: String,
        organizationID: String,
        projectID: String?,
        payload: Data,
        createdAt: Date = .now,
        updatedAt: Date = .now
    ) {
        self.id = id
        self.kind = kind
        self.organizationID = organizationID
        self.projectID = projectID
        self.payload = payload
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

@Model
final class PendingMutationRecord {
    @Attribute(.unique) var id: UUID
    @Attribute(.unique) var idempotencyKey: String
    var path: String
    var method: String
    var organizationID: String
    var projectID: String?
    var body: Data?
    var createdAt: Date
    var nextAttemptAt: Date
    var attemptCount: Int
    var lastError: String?
    var state: String

    init(
        id: UUID = UUID(),
        idempotencyKey: String = UUID().uuidString,
        path: String,
        method: String,
        organizationID: String,
        projectID: String?,
        body: Data?,
        createdAt: Date = .now,
        nextAttemptAt: Date = .now,
        attemptCount: Int = 0,
        lastError: String? = nil,
        state: String = "pending"
    ) {
        self.id = id
        self.idempotencyKey = idempotencyKey
        self.path = path
        self.method = method
        self.organizationID = organizationID
        self.projectID = projectID
        self.body = body
        self.createdAt = createdAt
        self.nextAttemptAt = nextAttemptAt
        self.attemptCount = attemptCount
        self.lastError = lastError
        self.state = state
    }
}

@Model
final class PendingUploadRecord {
    @Attribute(.unique) var id: UUID
    var organizationID: String
    var projectID: String
    var dailyLogID: String
    var fileName: String
    var mimeType: String
    var localPath: String
    var createdAt: Date
    var attemptCount: Int
    var lastError: String?

    init(
        id: UUID,
        organizationID: String,
        projectID: String,
        dailyLogID: String,
        fileName: String,
        mimeType: String,
        localPath: String
    ) {
        self.id = id
        self.organizationID = organizationID
        self.projectID = projectID
        self.dailyLogID = dailyLogID
        self.fileName = fileName
        self.mimeType = mimeType
        self.localPath = localPath
        self.createdAt = .now
        self.attemptCount = 0
    }
}
