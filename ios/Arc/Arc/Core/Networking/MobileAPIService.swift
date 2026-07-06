import Foundation

@MainActor
final class MobileAPIService {
    private let client: APIClient
    private let session: SessionStore

    init(client: APIClient, session: SessionStore) {
        self.client = client
        self.session = session
    }

    var userID: String? { session.userID }

    func loadSession(preferredOrganizationID: String?) async throws -> MobileSession {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "session",
            accessToken: token,
            organizationID: preferredOrganizationID
        )
        let envelope: APIEnvelope<MobileSession> = try await client.send(request)
        return envelope.data
    }

    func loadProjects(organizationID: String) async throws -> [MobileProject] {
        let token = try await session.validAccessToken()
        var projects: [MobileProject] = []
        var cursor: String?

        repeat {
            var query = [URLQueryItem(name: "limit", value: "100")]
            if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
            let request = try client.request(
                path: "projects",
                accessToken: token,
                organizationID: organizationID,
                queryItems: query
            )
            let envelope: APIEnvelope<[MobileProject]> = try await client.send(request)
            projects.append(contentsOf: envelope.data)
            cursor = envelope.meta.nextCursor
        } while cursor != nil

        return projects
    }

    func loadDrawingSets(projectID: String, organizationID: String) async throws -> [MobileDrawingSet] {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "projects/\(projectID)/drawings/sets",
            accessToken: token,
            organizationID: organizationID
        )
        let envelope: APIEnvelope<[MobileDrawingSet]> = try await client.send(request)
        return envelope.data
    }

    func loadDrawingSheets(projectID: String, organizationID: String) async throws -> [MobileDrawingSheet] {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "projects/\(projectID)/drawings/sheets",
            accessToken: token,
            organizationID: organizationID
        )
        let envelope: APIEnvelope<[MobileDrawingSheet]> = try await client.send(request)
        return envelope.data
    }

    func loadDrawingSheetDetail(
        projectID: String,
        sheetID: String,
        organizationID: String
    ) async throws -> MobileDrawingSheetDetail {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "projects/\(projectID)/drawings/sheets/\(sheetID)",
            accessToken: token,
            organizationID: organizationID
        )
        let envelope: APIEnvelope<MobileDrawingSheetDetail> = try await client.send(request)
        return envelope.data
    }

    func loadDailyLogs(projectID: String, organizationID: String) async throws -> [MobileDailyLog] {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "projects/\(projectID)/daily-logs",
            accessToken: token,
            organizationID: organizationID
        )
        let envelope: APIEnvelope<[MobileDailyLog]> = try await client.send(request)
        return envelope.data
    }

    func createDailyLog(
        _ input: CreateDailyLogRequest,
        projectID: String,
        organizationID: String
    ) async throws -> MobileDailyLog {
        let token = try await session.validAccessToken()
        var request = try client.request(
            path: "projects/\(projectID)/daily-logs",
            method: "POST",
            accessToken: token,
            organizationID: organizationID
        )
        request.httpBody = try JSONEncoder.arc.encode(input)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(input.clientId, forHTTPHeaderField: "Idempotency-Key")
        let envelope: APIEnvelope<MobileDailyLog> = try await client.send(request)
        return envelope.data
    }

    func loadDailyLogContext(projectID: String, organizationID: String) async throws -> MobileDailyLogContext {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "projects/\(projectID)/daily-logs/context",
            accessToken: token,
            organizationID: organizationID
        )
        let envelope: APIEnvelope<MobileDailyLogContext> = try await client.send(request)
        return envelope.data
    }

    func updateDailyLog(
        _ input: UpdateDailyLogRequest,
        projectID: String,
        dailyLogID: String,
        organizationID: String
    ) async throws -> MobileDailyLog {
        let token = try await session.validAccessToken()
        var request = try client.request(
            path: "projects/\(projectID)/daily-logs/\(dailyLogID)",
            method: "PATCH",
            accessToken: token,
            organizationID: organizationID
        )
        request.httpBody = try JSONEncoder.arc.encode(input)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let envelope: APIEnvelope<MobileDailyLog> = try await client.send(request)
        return envelope.data
    }

    func deleteDailyLog(projectID: String, dailyLogID: String, organizationID: String) async throws {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "projects/\(projectID)/daily-logs/\(dailyLogID)",
            method: "DELETE",
            accessToken: token,
            organizationID: organizationID
        )
        try await client.send(request)
    }

    func createDailyLogComment(
        _ input: CreateDailyLogCommentRequest,
        projectID: String,
        dailyLogID: String,
        organizationID: String
    ) async throws -> MobileDailyLogComment {
        let token = try await session.validAccessToken()
        var request = try client.request(
            path: "projects/\(projectID)/daily-logs/\(dailyLogID)/comments",
            method: "POST",
            accessToken: token,
            organizationID: organizationID
        )
        request.httpBody = try JSONEncoder.arc.encode(input)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let envelope: APIEnvelope<MobileDailyLogComment> = try await client.send(request)
        return envelope.data
    }

    func uploadDailyLogPhoto(
        fileURL: URL,
        fileName: String,
        mimeType: String,
        clientID: UUID,
        projectID: String,
        dailyLogID: String,
        organizationID: String
    ) async throws -> MobileDailyLogPhoto {
        let token = try await session.validAccessToken()
        let boundary = "ArcBoundary\(UUID().uuidString)"
        var request = try client.request(
            path: "projects/\(projectID)/daily-logs/\(dailyLogID)/photos",
            method: "POST",
            accessToken: token,
            organizationID: organizationID
        )
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let fileData = try Data(contentsOf: fileURL, options: .mappedIfSafe)
        var body = Data()
        body.appendMultipartField(name: "client_id", value: clientID.uuidString, boundary: boundary)
        body.appendMultipartFile(
            name: "file",
            fileName: fileName,
            mimeType: mimeType,
            data: fileData,
            boundary: boundary
        )
        body.append(Data("--\(boundary)--\r\n".utf8))
        request.httpBody = body
        let envelope: APIEnvelope<MobileDailyLogPhoto> = try await client.send(request)
        return envelope.data
    }

    // MARK: - Schedule

    func loadSchedule(projectID: String, organizationID: String) async throws -> [MobileScheduleItem] {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "projects/\(projectID)/schedule",
            accessToken: token,
            organizationID: organizationID
        )
        let envelope: APIEnvelope<[MobileScheduleItem]> = try await client.send(request)
        return envelope.data
    }

    // MARK: - Tasks & Punch

    func loadTasks(projectID: String, organizationID: String) async throws -> [MobileTask] {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "projects/\(projectID)/tasks",
            accessToken: token,
            organizationID: organizationID
        )
        let envelope: APIEnvelope<[MobileTask]> = try await client.send(request)
        return envelope.data
    }

    func updateTaskStatus(
        projectID: String,
        taskID: String,
        status: String,
        organizationID: String
    ) async throws -> MobileTask {
        let token = try await session.validAccessToken()
        var request = try client.request(
            path: "projects/\(projectID)/tasks/\(taskID)",
            method: "PATCH",
            accessToken: token,
            organizationID: organizationID
        )
        request.httpBody = try JSONEncoder.arc.encode(UpdateStatusRequest(status: status))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let envelope: APIEnvelope<MobileTask> = try await client.send(request)
        return envelope.data
    }

    func loadPunchItems(projectID: String, organizationID: String) async throws -> [MobilePunchItem] {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "projects/\(projectID)/punch-items",
            accessToken: token,
            organizationID: organizationID
        )
        let envelope: APIEnvelope<[MobilePunchItem]> = try await client.send(request)
        return envelope.data
    }

    func updatePunchStatus(
        projectID: String,
        punchItemID: String,
        status: String,
        organizationID: String
    ) async throws -> MobilePunchItem {
        let token = try await session.validAccessToken()
        var request = try client.request(
            path: "projects/\(projectID)/punch-items/\(punchItemID)",
            method: "PATCH",
            accessToken: token,
            organizationID: organizationID
        )
        request.httpBody = try JSONEncoder.arc.encode(UpdateStatusRequest(status: status))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let envelope: APIEnvelope<MobilePunchItem> = try await client.send(request)
        return envelope.data
    }

    // MARK: - Expenses

    func loadExpenses(projectID: String, organizationID: String) async throws -> [MobileExpense] {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "projects/\(projectID)/expenses",
            accessToken: token,
            organizationID: organizationID
        )
        let envelope: APIEnvelope<[MobileExpense]> = try await client.send(request)
        return envelope.data
    }

    func createExpense(
        _ payload: CreateExpensePayload,
        receiptURL: URL?,
        receiptFileName: String?,
        receiptMimeType: String?,
        projectID: String,
        organizationID: String
    ) async throws -> MobileExpense {
        let token = try await session.validAccessToken()
        let boundary = "ArcBoundary\(UUID().uuidString)"
        var request = try client.request(
            path: "projects/\(projectID)/expenses",
            method: "POST",
            accessToken: token,
            organizationID: organizationID
        )
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue(payload.clientId, forHTTPHeaderField: "Idempotency-Key")
        var body = Data()
        let payloadJSON = String(decoding: try JSONEncoder.arc.encode(payload), as: UTF8.self)
        body.appendMultipartField(name: "payload", value: payloadJSON, boundary: boundary)
        if let receiptURL, let fileData = try? Data(contentsOf: receiptURL, options: .mappedIfSafe) {
            body.appendMultipartFile(
                name: "receipt",
                fileName: receiptFileName ?? receiptURL.lastPathComponent,
                mimeType: receiptMimeType ?? "image/jpeg",
                data: fileData,
                boundary: boundary
            )
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        request.httpBody = body
        let envelope: APIEnvelope<MobileExpense> = try await client.send(request)
        return envelope.data
    }

    func scanReceipt(
        fileURL: URL,
        fileName: String,
        mimeType: String,
        projectID: String,
        organizationID: String
    ) async throws -> MobileReceiptScan {
        let token = try await session.validAccessToken()
        let boundary = "ArcBoundary\(UUID().uuidString)"
        var request = try client.request(
            path: "projects/\(projectID)/expenses/scan",
            method: "POST",
            accessToken: token,
            organizationID: organizationID
        )
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let fileData = try Data(contentsOf: fileURL, options: .mappedIfSafe)
        var body = Data()
        body.appendMultipartFile(
            name: "receipt",
            fileName: fileName,
            mimeType: mimeType,
            data: fileData,
            boundary: boundary
        )
        body.append(Data("--\(boundary)--\r\n".utf8))
        request.httpBody = body
        let envelope: APIEnvelope<MobileReceiptScan> = try await client.send(request)
        return envelope.data
    }

    // MARK: - Documents

    func loadFiles(projectID: String, folder: String, organizationID: String) async throws -> MobileFiles {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "projects/\(projectID)/files",
            accessToken: token,
            organizationID: organizationID,
            queryItems: [URLQueryItem(name: "folder", value: folder)]
        )
        let envelope: APIEnvelope<MobileFiles> = try await client.send(request)
        return envelope.data
    }

    func uploadFile(
        fileURL: URL,
        fileName: String,
        mimeType: String,
        clientID: String,
        folder: String,
        category: String?,
        projectID: String,
        organizationID: String
    ) async throws -> MobileFile {
        let token = try await session.validAccessToken()
        let boundary = "ArcBoundary\(UUID().uuidString)"
        var request = try client.request(
            path: "projects/\(projectID)/files",
            method: "POST",
            accessToken: token,
            organizationID: organizationID
        )
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue(clientID, forHTTPHeaderField: "Idempotency-Key")
        let fileData = try Data(contentsOf: fileURL, options: .mappedIfSafe)
        var body = Data()
        body.appendMultipartField(name: "client_id", value: clientID, boundary: boundary)
        body.appendMultipartField(name: "folder", value: folder, boundary: boundary)
        if let category { body.appendMultipartField(name: "category", value: category, boundary: boundary) }
        body.appendMultipartFile(
            name: "file",
            fileName: fileName,
            mimeType: mimeType,
            data: fileData,
            boundary: boundary
        )
        body.append(Data("--\(boundary)--\r\n".utf8))
        request.httpBody = body
        let envelope: APIEnvelope<MobileFile> = try await client.send(request)
        return envelope.data
    }

    func deleteFile(projectID: String, fileID: String, organizationID: String) async throws {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "projects/\(projectID)/files/\(fileID)",
            method: "DELETE",
            accessToken: token,
            organizationID: organizationID
        )
        try await client.send(request)
    }

    // MARK: - Push devices

    func registerDevice(
        token: String,
        platform: String,
        appVersion: String?,
        environment: String,
        organizationID: String
    ) async throws {
        let accessToken = try await session.validAccessToken()
        var request = try client.request(
            path: "devices",
            method: "POST",
            accessToken: accessToken,
            organizationID: organizationID
        )
        request.httpBody = try JSONEncoder.arc.encode(
            RegisterDeviceRequest(token: token, platform: platform, appVersion: appVersion, environment: environment)
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        try await client.send(request)
    }

    func unregisterDevice(token: String, organizationID: String) async throws {
        let accessToken = try await session.validAccessToken()
        var request = try client.request(
            path: "devices",
            method: "DELETE",
            accessToken: accessToken,
            organizationID: organizationID
        )
        request.httpBody = try JSONEncoder.arc.encode(UnregisterDeviceRequest(token: token))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        try await client.send(request)
    }

    // MARK: - RFIs & Team

    func loadRfis(projectID: String, organizationID: String) async throws -> [MobileRfi] {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "projects/\(projectID)/rfis",
            accessToken: token,
            organizationID: organizationID
        )
        let envelope: APIEnvelope<[MobileRfi]> = try await client.send(request)
        return envelope.data
    }

    func loadTeam(projectID: String, organizationID: String) async throws -> [MobileTeamMember] {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "projects/\(projectID)/team",
            accessToken: token,
            organizationID: organizationID
        )
        let envelope: APIEnvelope<[MobileTeamMember]> = try await client.send(request)
        return envelope.data
    }

    // MARK: - Notifications

    func loadNotifications(organizationID: String) async throws -> MobileNotifications {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "notifications",
            accessToken: token,
            organizationID: organizationID
        )
        let envelope: APIEnvelope<MobileNotifications> = try await client.send(request)
        return envelope.data
    }

    func markNotificationRead(notificationID: String, organizationID: String) async throws -> MobileNotification {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "notifications/\(notificationID)/read",
            method: "POST",
            accessToken: token,
            organizationID: organizationID
        )
        let envelope: APIEnvelope<MobileNotification> = try await client.send(request)
        return envelope.data
    }

    func markAllNotificationsRead(organizationID: String) async throws {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "notifications/read-all",
            method: "POST",
            accessToken: token,
            organizationID: organizationID
        )
        try await client.send(request)
    }

    // MARK: - Platform

    func loadPlatformAuditLog(limit: Int = 50) async throws -> [MobilePlatformAuditEntry] {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "platform/audit-log",
            accessToken: token,
            queryItems: [URLQueryItem(name: "limit", value: String(limit))]
        )
        let envelope: APIEnvelope<[MobilePlatformAuditEntry]> = try await client.send(request)
        return envelope.data
    }

    func loadPlatformIssues(limit: Int = 50) async throws -> [MobilePlatformIssue] {
        let token = try await session.validAccessToken()
        let request = try client.request(
            path: "platform/issues",
            accessToken: token,
            queryItems: [URLQueryItem(name: "limit", value: String(limit))]
        )
        let envelope: APIEnvelope<[MobilePlatformIssue]> = try await client.send(request)
        return envelope.data
    }

    func createPlatformIssue(_ input: CreatePlatformIssueRequest) async throws -> MobilePlatformIssue {
        let token = try await session.validAccessToken()
        var request = try client.request(
            path: "platform/issues",
            method: "POST",
            accessToken: token
        )
        request.httpBody = try JSONEncoder.arc.encode(input)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let envelope: APIEnvelope<MobilePlatformIssue> = try await client.send(request)
        return envelope.data
    }
}

private extension Data {
    mutating func appendMultipartField(name: String, value: String, boundary: String) {
        append(Data("--\(boundary)\r\n".utf8))
        append(Data("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".utf8))
        append(Data("\(value)\r\n".utf8))
    }

    mutating func appendMultipartFile(
        name: String,
        fileName: String,
        mimeType: String,
        data: Data,
        boundary: String
    ) {
        let safeName = fileName.replacingOccurrences(of: "\"", with: "_")
        append(Data("--\(boundary)\r\n".utf8))
        append(Data("Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(safeName)\"\r\n".utf8))
        append(Data("Content-Type: \(mimeType)\r\n\r\n".utf8))
        append(data)
        append(Data("\r\n".utf8))
    }
}
