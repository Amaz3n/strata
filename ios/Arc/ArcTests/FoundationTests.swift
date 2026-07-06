import Foundation
import Testing
@testable import Arc

struct FoundationTests {
    @Test
    func environmentsUseVersionedMobileAPI() {
        for environment in AppEnvironment.allCases {
            #expect(environment.apiBaseURL.path.hasSuffix("/api/mobile/v1"))
        }
    }

    @Test
    func onlyTransientErrorsAreRetryable() {
        #expect(APIError.transport(description: "offline").isRetryable)
        #expect(APIError.rateLimited.isRetryable)
        #expect(APIError.server(statusCode: 503, code: nil, message: nil, requestID: nil).isRetryable)
        #expect(!APIError.unauthorized.isRetryable)
        #expect(!APIError.validation(code: "invalid", message: "Invalid", details: [:]).isRetryable)
    }

    @Test
    func keychainRoundTrip() async throws {
        let key = "foundation-test-\(UUID().uuidString)"
        let store = KeychainStore(service: "com.arc.mobile.tests")
        let expected = Data("session-token".utf8)

        try await store.set(expected, for: key)
        let stored = try await store.data(for: key)
        try await store.delete(key)

        #expect(stored == expected)
        #expect(try await store.data(for: key) == nil)
    }

    @Test @MainActor
    func sessionPersistsAndRestoresFromKeychain() async throws {
        let service = "com.arc.mobile.tests.\(UUID().uuidString)"
        let keychain = KeychainStore(service: service)
        let expected = AuthSession(
            accessToken: "access-token",
            refreshToken: "refresh-token",
            expiresAt: Date().addingTimeInterval(3_600),
            user: AuthUser(id: "user-1", email: "field@example.com")
        )
        let auth = FakeAuthClient(session: expected)
        let original = SessionStore(authClient: auth, keychain: keychain)

        await original.signIn(email: "field@example.com", password: "password")
        #expect(original.userID == "user-1")

        let restored = SessionStore(authClient: auth, keychain: keychain)
        await restored.restore()
        #expect(restored.userID == "user-1")
        #expect(restored.accessToken == "access-token")

        await restored.signOut()
    }

    @Test
    func mobileSessionDecodesStableSnakeCaseContract() throws {
        let payload = #"{"data":{"user":{"id":"user-1","email":"field@example.com","display_name":"Field User","avatar_url":null},"organizations":[],"selected_organization_id":null},"meta":{"request_id":"request-1"}}"#
        let envelope = try JSONDecoder.arc.decode(
            APIEnvelope<MobileSession>.self,
            from: Data(payload.utf8)
        )

        #expect(envelope.data.user.id == "user-1")
        #expect(envelope.meta.requestId == "request-1")
    }

    @Test
    func projectsDecodeTimestampWithFractionalSeconds() throws {
        let payload = #"{"data":[{"id":"project-1","organization_id":"org-1","name":"Lakeside","status":"active","address":null,"start_date":null,"end_date":null,"updated_at":"2024-06-01T12:34:56.789123+00:00"}],"meta":{"request_id":"request-1","next_cursor":null}}"#
        let envelope = try JSONDecoder.arc.decode(
            APIEnvelope<[MobileProject]>.self,
            from: Data(payload.utf8)
        )

        #expect(envelope.data.count == 1)
        #expect(envelope.data.first?.id == "project-1")
    }

    @Test
    func projectsDecodeTimestampWithoutFractionalSeconds() throws {
        let payload = #"{"data":[{"id":"project-1","organization_id":"org-1","name":"Lakeside","status":"active","address":null,"start_date":null,"end_date":null,"updated_at":"2024-06-01T12:34:56Z"}],"meta":{"request_id":"request-1","next_cursor":null}}"#
        let envelope = try JSONDecoder.arc.decode(
            APIEnvelope<[MobileProject]>.self,
            from: Data(payload.utf8)
        )

        #expect(envelope.data.first?.id == "project-1")
    }

    @Test @MainActor
    func offlineWorkspaceAndProjectsRoundTrip() throws {
        let store = try OfflineStore(inMemory: true)
        let session = MobileSession(
            user: MobileUser(id: "user-1", email: "field@example.com", displayName: "Field", avatarUrl: nil),
            organizations: [MobileOrganization(id: "org-1", name: "Arc", slug: "arc", logoUrl: nil, role: "member")],
            selectedOrganizationId: "org-1"
        )
        let projects = [MobileProject(
            id: "project-1",
            organizationId: "org-1",
            name: "Lakeside",
            status: "active",
            address: nil,
            startDate: nil,
            endDate: nil,
            updatedAt: .now
        )]

        try store.cache(session: session)
        try store.cache(projects: projects, organizationID: "org-1")

        #expect(try store.cachedSession(userID: "user-1") == session)
        #expect(try store.cachedProjects(organizationID: "org-1").map(\.id) == ["project-1"])
    }

    @Test @MainActor
    func draftsCanBeUpdatedAndDeleted() throws {
        let store = try OfflineStore(inMemory: true)
        let id = try store.saveDraft(
            kind: "daily-log",
            organizationID: "org-1",
            projectID: "project-1",
            payload: Data("first".utf8)
        )
        try store.saveDraft(
            id: id,
            kind: "daily-log",
            organizationID: "org-1",
            projectID: "project-1",
            payload: Data("revised".utf8)
        )

        #expect(try store.drafts().count == 1)
        #expect(try store.drafts().first?.payload == Data("revised".utf8))
        try store.deleteDraft(id: id)
        #expect(try store.drafts().isEmpty)
    }

    @Test @MainActor
    func mutationOutboxDeduplicatesAndBacksOff() throws {
        let store = try OfflineStore(inMemory: true)
        let firstID = try store.enqueue(
            path: "daily-logs",
            method: "POST",
            organizationID: "org-1",
            idempotencyKey: "stable-key"
        )
        let duplicateID = try store.enqueue(
            path: "daily-logs",
            method: "POST",
            organizationID: "org-1",
            idempotencyKey: "stable-key"
        )

        #expect(firstID == duplicateID)
        #expect(try store.pendingMutationCount() == 1)
        let mutation = try #require(store.dueMutations().first)
        let retryTime = Date()
        try store.retry(mutation, error: APIError.transport(description: "offline"), now: retryTime)
        #expect(mutation.attemptCount == 1)
        #expect(mutation.nextAttemptAt >= retryTime.addingTimeInterval(5))
        #expect(try store.dueMutations(at: retryTime).isEmpty)
    }

    @Test
    func dailyLogContractDecodesTimelineDetails() throws {
        let payload = #"{"data":[{"id":"log-1","organization_id":"org-1","project_id":"project-1","date":"2026-06-23","summary":"Framing continued","weather":"Sunny","created_by":"user-1","created_at":"2026-06-23T12:00:00Z","updated_at":"2026-06-23T12:00:00Z","entries":[{"id":"entry-1","entry_type":"work","description":"Second floor","quantity":null,"hours":7.5,"progress":60,"schedule_item_id":null,"task_id":null,"punch_item_id":null,"location":"Level 2","trade":"Framing","inspection_result":null}],"comments":[],"photo_count":2}],"meta":{"request_id":"request-1","next_cursor":null}}"#
        let envelope = try JSONDecoder.arc.decode(APIEnvelope<[MobileDailyLog]>.self, from: Data(payload.utf8))

        #expect(envelope.data.first?.entries.first?.hours == 7.5)
        #expect(envelope.data.first?.photoCount == 2)
    }

    @Test @MainActor
    func dailyLogDraftAndTimelineCacheRoundTrip() throws {
        let draft = DailyLogDraft(
            summary: "Framing continued",
            weather: "Sunny",
            workEntries: [DailyLogWorkDraft(description: "Second floor", hours: 8, progress: 50)],
            inspectionEntries: [DailyLogInspectionDraft(notes: "Passed rough-in", result: "pass")],
            taskUpdates: [DailyLogTaskUpdateDraft(taskId: "task-1")],
            punchUpdates: [DailyLogPunchUpdateDraft(punchItemId: "punch-1")],
            mentionedUserIds: ["user-2"]
        )
        let request = draft.request()
        #expect(request.entries.count == 4)
        #expect(request.entries.first?.entryType == "work")
        #expect(request.mentionedUserIds == ["user-2"])

        let store = try OfflineStore(inMemory: true)
        let log = MobileDailyLog(
            id: draft.id.uuidString,
            organizationId: "org-1",
            projectId: "project-1",
            date: request.date,
            summary: request.summary,
            weather: request.weather,
            createdBy: "user-1",
            createdAt: .now,
            updatedAt: .now,
            entries: [],
            comments: [],
            mentionedUserIds: [],
            photos: [],
            photoCount: 0,
            syncState: "pending"
        )
        try store.cache(dailyLogs: [log], projectID: "project-1")
        #expect(try store.cachedDailyLogs(projectID: "project-1").first?.id == log.id)
    }

    @Test @MainActor
    func pendingPhotoUploadsPersistUntilCompleted() throws {
        let store = try OfflineStore(inMemory: true)
        let attachment = DailyLogAttachmentDraft(
            fileName: "site.jpg",
            mimeType: "image/jpeg",
            localPath: "/tmp/site.jpg"
        )
        try store.enqueueUpload(
            attachment,
            organizationID: "org-1",
            projectID: "project-1",
            dailyLogID: "log-1"
        )

        let pending = try store.pendingUploads()
        #expect(pending.count == 1)
        #expect(pending.first?.dailyLogID == "log-1")
        if let upload = pending.first { try store.completeUpload(upload) }
        #expect(try store.pendingUploads().isEmpty)
    }
}

private actor FakeAuthClient: AuthClient {
    let session: AuthSession

    init(session: AuthSession) {
        self.session = session
    }

    func signIn(email: String, password: String) async throws -> AuthSession { session }
    func refresh(refreshToken: String) async throws -> AuthSession { session }
    func signOut(accessToken: String) async {}
}
