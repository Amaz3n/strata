import Foundation

struct APIEnvelope<Value: Decodable & Sendable>: Decodable, Sendable {
    let data: Value
    let meta: APIMeta
}

struct APIMeta: Decodable, Sendable {
    let requestId: String
    let nextCursor: String?
}

struct MobileUser: Codable, Equatable, Sendable {
    let id: String
    let email: String
    let displayName: String?
    let avatarUrl: URL?
}

struct MobileOrganization: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let slug: String?
    let logoUrl: URL?
    let role: String?
}

struct MobileProject: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let organizationId: String
    let name: String
    let status: String
    let address: String?
    let startDate: String?
    let endDate: String?
    let updatedAt: Date
}

struct MobileSession: Codable, Equatable, Sendable {
    let user: MobileUser
    let organizations: [MobileOrganization]
    let selectedOrganizationId: String?
}

struct MobileDailyLog: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let organizationId: String
    let projectId: String
    let date: String
    let summary: String?
    let weather: String?
    let createdBy: String?
    let createdAt: Date
    let updatedAt: Date
    let entries: [MobileDailyLogEntry]
    let comments: [MobileDailyLogComment]
    let mentionedUserIds: [String]?
    let photos: [MobileDailyLogPhoto]?
    let photoCount: Int
    var syncState: String?
}

struct MobileDailyLogEntry: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let entryType: String
    let description: String?
    let quantity: Double?
    let hours: Double?
    let progress: Double?
    let scheduleItemId: String?
    let taskId: String?
    let punchItemId: String?
    let location: String?
    let trade: String?
    let inspectionResult: String?
}

struct MobileDailyLogComment: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let body: String
    let createdAt: Date
    let authorName: String?
    let mentionedUserIds: [String]?
}

struct MobileDailyLogPhoto: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let fileName: String
    let mimeType: String?
    let downloadUrl: URL
}

struct MobileDailyLogContext: Codable, Equatable, Sendable {
    let scheduleItems: [DailyLogScheduleOption]
    let tasks: [DailyLogTaskOption]
    let punchItems: [DailyLogPunchOption]
    let team: [DailyLogTeamMember]
}

struct DailyLogScheduleOption: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let status: String
    let progress: Double
    let trade: String?
    let location: String?
}

struct DailyLogTaskOption: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let status: String
}

struct DailyLogPunchOption: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let status: String
    let location: String?
}

struct DailyLogTeamMember: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let email: String?
    let role: String?
}

struct DailyLogDraft: Codable, Equatable, Identifiable, Sendable {
    var id = UUID()
    var date = Date.now
    var summary = ""
    var weather: String?
    var workEntries: [DailyLogWorkDraft] = []
    var inspectionEntries: [DailyLogInspectionDraft] = []
    var taskUpdates: [DailyLogTaskUpdateDraft] = []
    var punchUpdates: [DailyLogPunchUpdateDraft] = []
    var mentionedUserIds: [String] = []
    var attachments: [DailyLogAttachmentDraft] = []

    init(
        id: UUID = UUID(),
        date: Date = .now,
        summary: String = "",
        weather: String? = nil,
        workEntries: [DailyLogWorkDraft] = [],
        inspectionEntries: [DailyLogInspectionDraft] = [],
        taskUpdates: [DailyLogTaskUpdateDraft] = [],
        punchUpdates: [DailyLogPunchUpdateDraft] = [],
        mentionedUserIds: [String] = [],
        attachments: [DailyLogAttachmentDraft] = []
    ) {
        self.id = id
        self.date = date
        self.summary = summary
        self.weather = weather
        self.workEntries = workEntries
        self.inspectionEntries = inspectionEntries
        self.taskUpdates = taskUpdates
        self.punchUpdates = punchUpdates
        self.mentionedUserIds = mentionedUserIds
        self.attachments = attachments
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        date = try container.decodeIfPresent(Date.self, forKey: .date) ?? .now
        summary = try container.decodeIfPresent(String.self, forKey: .summary) ?? ""
        weather = try container.decodeIfPresent(String.self, forKey: .weather)
        workEntries = try container.decodeIfPresent([DailyLogWorkDraft].self, forKey: .workEntries) ?? []
        inspectionEntries = try container.decodeIfPresent([DailyLogInspectionDraft].self, forKey: .inspectionEntries) ?? []
        taskUpdates = try container.decodeIfPresent([DailyLogTaskUpdateDraft].self, forKey: .taskUpdates) ?? []
        punchUpdates = try container.decodeIfPresent([DailyLogPunchUpdateDraft].self, forKey: .punchUpdates) ?? []
        mentionedUserIds = try container.decodeIfPresent([String].self, forKey: .mentionedUserIds) ?? []
        attachments = try container.decodeIfPresent([DailyLogAttachmentDraft].self, forKey: .attachments) ?? []
    }
}

struct DailyLogWorkDraft: Codable, Equatable, Identifiable, Sendable {
    var id = UUID()
    var description = ""
    var hours: Double?
    var progress: Double?
    var trade = ""
    var location = ""
    var scheduleItemId: String?

    init(
        id: UUID = UUID(),
        description: String = "",
        hours: Double? = nil,
        progress: Double? = nil,
        trade: String = "",
        location: String = "",
        scheduleItemId: String? = nil
    ) {
        self.id = id
        self.description = description
        self.hours = hours
        self.progress = progress
        self.trade = trade
        self.location = location
        self.scheduleItemId = scheduleItemId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        description = try container.decodeIfPresent(String.self, forKey: .description) ?? ""
        hours = try container.decodeIfPresent(Double.self, forKey: .hours)
        progress = try container.decodeIfPresent(Double.self, forKey: .progress)
        trade = try container.decodeIfPresent(String.self, forKey: .trade) ?? ""
        location = try container.decodeIfPresent(String.self, forKey: .location) ?? ""
        scheduleItemId = try container.decodeIfPresent(String.self, forKey: .scheduleItemId)
    }
}

struct DailyLogInspectionDraft: Codable, Equatable, Identifiable, Sendable {
    var id = UUID()
    var notes = ""
    var result: String?
    var scheduleItemId: String?

    init(id: UUID = UUID(), notes: String = "", result: String? = nil, scheduleItemId: String? = nil) {
        self.id = id
        self.notes = notes
        self.result = result
        self.scheduleItemId = scheduleItemId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        notes = try container.decodeIfPresent(String.self, forKey: .notes) ?? ""
        result = try container.decodeIfPresent(String.self, forKey: .result)
        scheduleItemId = try container.decodeIfPresent(String.self, forKey: .scheduleItemId)
    }
}

struct DailyLogTaskUpdateDraft: Codable, Equatable, Identifiable, Sendable {
    var id = UUID()
    var taskId: String?
    var markComplete = true
}

struct DailyLogPunchUpdateDraft: Codable, Equatable, Identifiable, Sendable {
    var id = UUID()
    var punchItemId: String?
    var markClosed = true
}

struct DailyLogAttachmentDraft: Codable, Equatable, Identifiable, Sendable {
    var id = UUID()
    var fileName: String
    var mimeType: String
    var localPath: String
}

// MARK: - Schedule

struct MobileScheduleItem: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let projectId: String
    let name: String
    let itemType: String
    let status: String
    let startDate: String?
    let endDate: String?
    let progress: Double
    let phase: String?
    let trade: String?
    let location: String?
    let isCriticalPath: Bool
    let assignees: [String]
    let updatedAt: Date
}

// MARK: - Tasks & Punch

struct MobileTask: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let projectId: String
    let title: String
    let description: String?
    let status: String
    let priority: String?
    let dueDate: String?
    let completedAt: Date?
    let assignees: [String]
    let createdAt: Date
    let updatedAt: Date
}

struct MobilePunchItem: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let projectId: String
    let title: String
    let description: String?
    let status: String
    let severity: String?
    let location: String?
    let dueDate: String?
    let resolvedAt: Date?
}

struct UpdateStatusRequest: Encodable, Sendable {
    let status: String
}

// MARK: - Expenses

struct MobileExpense: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let projectId: String
    let vendorName: String?
    let description: String?
    let expenseDate: String?
    let amountCents: Int
    let taxCents: Int
    let paymentMethod: String?
    let status: String
    let receiptUrl: URL?
    let createdAt: Date
}

struct MobileReceiptScan: Codable, Equatable, Sendable {
    let vendorName: String?
    let expenseDate: String?
    let totalDollars: Double?
    let taxDollars: Double?
    let paymentMethod: String?
    let description: String?
    let confidence: String
    let notes: [String]
}

struct CreateExpensePayload: Encodable, Sendable {
    let clientId: String
    let expenseDate: String
    let amountDollars: Double
    let taxDollars: Double?
    let vendorName: String?
    let paymentMethod: String?
    let description: String?
}

// MARK: - Documents

struct MobileFiles: Codable, Equatable, Sendable {
    let folders: [MobileFolder]
    let files: [MobileFile]
}

struct MobileFolder: Codable, Equatable, Identifiable, Sendable {
    var id: String { path }
    let path: String
    let name: String
    let fileCount: Int
}

struct MobileFile: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let fileName: String
    let folderPath: String?
    let category: String?
    let mimeType: String?
    let sizeBytes: Int?
    let downloadUrl: URL?
    let isImage: Bool
    let updatedAt: Date
}

// MARK: - Notifications

struct MobileNotifications: Codable, Equatable, Sendable {
    let notifications: [MobileNotification]
    let unreadCount: Int
}

struct MobilePlatformAuditEntry: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let occurredAt: Date
    let actorUserId: String?
    let actorName: String?
    let orgId: String?
    let orgName: String?
    let projectId: String?
    let projectName: String?
    let actionKey: String
    let resourceType: String?
    let resourceId: String?
    let decision: String
    let reasonCode: String?
    let requestId: String?
    let ip: String?
    let userAgent: String?
}

struct MobilePlatformIssue: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let issueKey: String
    let title: String
    let description: String?
    let status: String
    let priority: String
    let source: String
    let environment: String?
    let orgId: String?
    let orgName: String?
    let projectId: String?
    let projectName: String?
    let assigneeUserId: String?
    let assigneeName: String?
    let createdBy: String?
    let creatorName: String?
    let dueAt: Date?
    let startedAt: Date?
    let resolvedAt: Date?
    let attachmentNames: [String]
    let createdAt: Date
    let updatedAt: Date
}

struct CreatePlatformIssueRequest: Codable, Equatable, Sendable {
    var title: String
    var description: String?
    var priority = "medium"
    var environment: String?
    var orgId: String?
    var projectId: String?
    var expectedBehavior: String?
    var actualBehavior: String?
}

struct MobileNotification: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let type: String
    let title: String
    let message: String
    let isRead: Bool
    let projectId: String?
    let entityType: String?
    let entityId: String?
    let createdAt: Date
}

// MARK: - Push devices

struct RegisterDeviceRequest: Encodable, Sendable {
    let token: String
    let platform: String
    let appVersion: String?
    let environment: String
}

struct UnregisterDeviceRequest: Encodable, Sendable {
    let token: String
}

// MARK: - RFIs & Team

struct MobileRfi: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let rfiNumber: Int
    let subject: String
    let question: String?
    let status: String
    let priority: String?
    let dueDate: String?
    let answeredAt: Date?
    let assigneeName: String?
    let createdAt: Date
}

struct MobileTeamMember: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let email: String?
    let role: String?
    let avatarUrl: URL?
}

struct CreateDailyLogRequest: Encodable, Sendable {
    struct Entry: Encodable, Sendable {
        let entryType: String
        let description: String?
        let hours: Double?
        let progress: Double?
        let location: String?
        let trade: String?
        let inspectionResult: String?
        let scheduleItemId: String?
        let taskId: String?
        let punchItemId: String?
        let metadata: [String: Bool]?
    }

    let clientId: String
    let date: String
    let summary: String?
    let weather: String?
    let entries: [Entry]
    let mentionedUserIds: [String]
}

struct UpdateDailyLogRequest: Encodable, Sendable {
    let summary: String?
    let weather: String?
    let mentionedUserIds: [String]
}

struct CreateDailyLogCommentRequest: Encodable, Sendable {
    let clientId: String
    let body: String
    let mentionedUserIds: [String]
}

extension DailyLogDraft {
    func request() -> CreateDailyLogRequest {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        let work = workEntries.compactMap { item -> CreateDailyLogRequest.Entry? in
            guard !item.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || item.hours != nil || item.progress != nil else { return nil }
            return .init(
                entryType: "work",
                description: item.description.nilIfBlank,
                hours: item.hours,
                progress: item.progress,
                location: item.location.nilIfBlank,
                trade: item.trade.nilIfBlank,
                inspectionResult: nil,
                scheduleItemId: item.scheduleItemId,
                taskId: nil,
                punchItemId: nil,
                metadata: nil
            )
        }
        let inspections = inspectionEntries.compactMap { item -> CreateDailyLogRequest.Entry? in
            guard !item.notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || item.result != nil else { return nil }
            return .init(
                entryType: "inspection",
                description: item.notes.nilIfBlank,
                hours: nil,
                progress: nil,
                location: nil,
                trade: nil,
                inspectionResult: item.result,
                scheduleItemId: item.scheduleItemId,
                taskId: nil,
                punchItemId: nil,
                metadata: nil
            )
        }
        let tasks = taskUpdates.compactMap { item -> CreateDailyLogRequest.Entry? in
            guard let taskId = item.taskId else { return nil }
            return .init(
                entryType: "task_update", description: nil, hours: nil, progress: nil,
                location: nil, trade: nil, inspectionResult: nil, scheduleItemId: nil,
                taskId: taskId, punchItemId: nil, metadata: ["mark_complete": item.markComplete]
            )
        }
        let punch = punchUpdates.compactMap { item -> CreateDailyLogRequest.Entry? in
            guard let punchItemId = item.punchItemId else { return nil }
            return .init(
                entryType: "punch_update", description: nil, hours: nil, progress: nil,
                location: nil, trade: nil, inspectionResult: nil, scheduleItemId: nil,
                taskId: nil, punchItemId: punchItemId, metadata: ["mark_closed": item.markClosed]
            )
        }
        return CreateDailyLogRequest(
            clientId: id.uuidString,
            date: formatter.string(from: date),
            summary: summary.nilIfBlank,
            weather: weather,
            entries: work + inspections + tasks + punch,
            mentionedUserIds: mentionedUserIds
        )
    }
}

private extension String {
    var nilIfBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
