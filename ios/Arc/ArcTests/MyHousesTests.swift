import Foundation
import Testing
@testable import Arc

/// The cross-house superintendent surface binds to routes the OpenAPI document
/// does not describe, so these tests pin the wire contract to the payloads the
/// route handlers actually emit (`lib/mobile/my-houses.ts`, `lib/mobile/purchasing.ts`).
struct MyHousesTests {
    @Test
    func myHousesDecodeAssignedRosterContract() throws {
        let payload = #"{"data":[{"project_id":"project-1","lot_label":"12-24","community_id":"community-1","community_name":"Wildwood Ridge","plan_code":"2410","elevation_code":"B","start_date":"2026-04-01","target_days":120,"days_in_progress":137,"percent_complete":62,"current_phase":"framing","late_count":3,"open_punch":2,"open_tasks":5,"last_daily_log_date":"2026-08-16"}],"meta":{"request_id":"request-1","next_cursor":null}}"#
        let envelope = try JSONDecoder.arc.decode(APIEnvelope<[MobileMyHouse]>.self, from: Data(payload.utf8))
        let house = try #require(envelope.data.first)

        #expect(house.id == "project-1")
        #expect(house.lotLabel == "12-24")
        #expect(house.communityName == "Wildwood Ridge")
        #expect(house.planText == "2410 · B")
        #expect(house.lateCount == 3)
        // 137 days spent against a 120-day target is 17 days over.
        #expect(house.daysVersusTarget == 17)
        #expect(house.phaseLabel == "Framing")
    }

    @Test
    func myHousesToleratePlanlessLotWithoutTarget() throws {
        let payload = #"{"data":[{"project_id":"project-2","lot_label":"Lot","community_id":"","community_name":"Community","plan_code":null,"elevation_code":null,"start_date":null,"target_days":null,"days_in_progress":0,"percent_complete":0,"current_phase":null,"late_count":0,"open_punch":0,"open_tasks":0,"last_daily_log_date":null}],"meta":{"request_id":"request-1","next_cursor":null}}"#
        let envelope = try JSONDecoder.arc.decode(APIEnvelope<[MobileMyHouse]>.self, from: Data(payload.utf8))
        let house = try #require(envelope.data.first)

        #expect(house.planText == nil)
        #expect(house.daysVersusTarget == nil)
        #expect(house.phaseLabel == nil)
        #expect(house.lastLogText == "No logs")
        #expect(!house.hasLog(on: MobileDateParser.todayKey))
    }

    @Test
    func workFeedGroupsByActivityNotByHouse() throws {
        let payload = #"{"data":[{"group_key":"frame inspection","group_label":"Frame inspection","items":[{"schedule_item_id":"item-1","project_id":"project-1","lot_label":"12-24","community_name":"Wildwood Ridge","name":"Frame inspection","trade":"Framing","status":"in_progress","start_date":"2026-08-17","end_date":"2026-08-17","days_late":0},{"schedule_item_id":"item-2","project_id":"project-2","lot_label":"12-25","community_name":"Wildwood Ridge","name":"Frame Inspection","trade":null,"status":"planned","start_date":"2026-08-12","end_date":"2026-08-14","days_late":3}]}],"meta":{"request_id":"request-1","next_cursor":null}}"#
        let envelope = try JSONDecoder.arc.decode(APIEnvelope<[MobileMyHouseWorkGroup]>.self, from: Data(payload.utf8))
        let group = try #require(envelope.data.first)

        #expect(group.id == "frame inspection")
        #expect(group.groupLabel == "Frame inspection")
        // One activity, two lots — the grouping the whole surface is built on.
        #expect(group.items.count == 2)
        #expect(group.items.map(\.projectId) == ["project-1", "project-2"])
        #expect(group.items[0].lotText == "12-24 · Wildwood Ridge")
        #expect(group.items[1].daysLate == 3)
    }

    @Test
    func completionResponseDecodes() throws {
        let payload = #"{"data":{"completed":true,"progress":100},"meta":{"request_id":"request-1"}}"#
        let envelope = try JSONDecoder.arc.decode(APIEnvelope<MobileMyHouseCompletion>.self, from: Data(payload.utf8))

        #expect(envelope.data.completed)
        #expect(envelope.data.progress == 100)
    }

    @Test
    func workWindowsMatchTheOnlyValuesTheServerAccepts() {
        // Anything outside this set is a 400 `invalid_window`.
        #expect(MyHouseWorkWindow.allCases.map(\.rawValue) == ["today", "week", "twoweek"])
    }

    @Test
    func completionPathMatchesTheMobileRoute() {
        #expect(
            MobileAPIService.myHouseCompletePath(scheduleItemID: "item-1")
                == "my-houses/schedule-items/item-1/complete"
        )
    }

    @Test
    func globalWorkspaceLeadsWithMyHouses() {
        // The cross-house surface must be reachable without picking a project.
        #expect(GlobalTab.allCases.first == .myHouses)
        #expect(GlobalTab.allCases.count == 2)
    }

    // MARK: - Offline

    @Test @MainActor
    func assignedHousesAndWorkSurviveAColdLaunchOffline() throws {
        let store = try OfflineStore(inMemory: true)
        let house = MobileMyHouse(
            projectId: "project-1", lotLabel: "12-24", communityId: "community-1",
            communityName: "Wildwood Ridge", planCode: "2410", elevationCode: "B",
            startDate: "2026-04-01", targetDays: 120, daysInProgress: 137, percentComplete: 62,
            currentPhase: "framing", lateCount: 3, openPunch: 2, openTasks: 5,
            lastDailyLogDate: "2026-08-16"
        )
        let group = MobileMyHouseWorkGroup(
            groupKey: "frame inspection",
            groupLabel: "Frame inspection",
            items: [MobileMyHouseWorkItem(
                scheduleItemId: "item-1", projectId: "project-1", lotLabel: "12-24",
                communityName: "Wildwood Ridge", name: "Frame inspection", trade: "Framing",
                status: "in_progress", startDate: "2026-08-17", endDate: "2026-08-17", daysLate: 0
            )]
        )

        try store.cache(myHouses: [house], organizationID: "org-1")
        try store.cache(myHouseWork: [group], organizationID: "org-1", window: .today)

        #expect(try store.cachedMyHouses(organizationID: "org-1") == [house])
        #expect(try store.cachedMyHouseWork(organizationID: "org-1", window: .today) == [group])
        // Windows are three different answers and must not share a cache slot.
        #expect(try store.cachedMyHouseWork(organizationID: "org-1", window: .twoweek).isEmpty)
    }

    @Test @MainActor
    func repeatedCompletionTapsQueueOneWrite() throws {
        let store = try OfflineStore(inMemory: true)
        let body = try JSONEncoder.arc.encode(CompleteScheduleItemRequest(progress: 100))
        let key = "my-house-complete-item-1"

        let first = try store.enqueue(
            path: MobileAPIService.myHouseCompletePath(scheduleItemID: "item-1"),
            method: "POST", organizationID: "org-1", projectID: "project-1",
            body: body, idempotencyKey: key
        )
        let second = try store.enqueue(
            path: MobileAPIService.myHouseCompletePath(scheduleItemID: "item-1"),
            method: "POST", organizationID: "org-1", projectID: "project-1",
            body: body, idempotencyKey: key
        )

        #expect(first == second)
        #expect(try store.pendingMutationCount() == 1)
        let mutation = try #require(store.dueMutations().first)
        #expect(mutation.method == "POST")
        #expect(mutation.path == "my-houses/schedule-items/item-1/complete")
    }

    // MARK: - Variance purchase orders

    @Test
    func reasonCodesDecodeContract() throws {
        let payload = #"{"data":[{"id":"reason-1","code":"TRADE_DAMAGE","label":"Trade damage","description":"Damage caused by another trade","is_backcharge":true,"sort_order":10}],"meta":{"request_id":"request-1"}}"#
        let envelope = try JSONDecoder.arc.decode(
            APIEnvelope<[MobileVarianceReasonCode]>.self,
            from: Data(payload.utf8)
        )
        let reason = try #require(envelope.data.first)

        #expect(reason.label == "Trade damage")
        #expect(reason.isBackcharge)
        // The server rejects a positive amount on a backcharge, so the client
        // has to flip the sign before it ever asks.
        #expect(reason.signedAmountCents(fromPositive: 25_000) == -25_000)
    }

    @Test
    func costReasonKeepsAmountPositive() throws {
        let reason = MobileVarianceReasonCode(
            id: "reason-2", code: "FIELD_CHANGE", label: "Field change",
            description: nil, isBackcharge: false, sortOrder: 0
        )
        #expect(reason.signedAmountCents(fromPositive: 25_000) == 25_000)
    }

    @Test
    func varianceListDecodesEmbeddedCommitmentAndReason() throws {
        let payload = #"{"data":[{"id":"vpo-1","project_id":"project-1","commitment_id":"commitment-1","title":"VPO — Trade damage","description":"Drywall crew damaged the tub","status":"draft","total_cents":-25000,"reason_code_id":"reason-1","origin":"field_mobile","photo_file_ids":["11111111-1111-4111-8111-111111111111"],"created_at":"2026-08-17T12:00:00Z","updated_at":"2026-08-17T12:00:00Z","commitment":{"title":"PO 1042 — Plumbing"},"company":{"name":"Gulf Coast Plumbing"},"reason":{"code":"TRADE_DAMAGE","label":"Trade damage","is_backcharge":true}}],"meta":{"request_id":"request-1","next_cursor":null}}"#
        let envelope = try JSONDecoder.arc.decode(
            APIEnvelope<[MobileVarianceOrder]>.self,
            from: Data(payload.utf8)
        )
        let order = try #require(envelope.data.first)

        #expect(order.purchaseOrderTitle == "PO 1042 — Plumbing")
        #expect(order.company?.name == "Gulf Coast Plumbing")
        #expect(order.reasonLabel == "Trade damage")
        #expect(order.isBackcharge)
        #expect(order.photoFileIds.count == 1)
    }

    @Test
    func varianceCreateDecodesBareInsertedRow() throws {
        // The POST route returns `select("*")` — no embedded commitment,
        // company, or reason. Decoding must not depend on them.
        let payload = #"{"data":{"id":"vpo-2","org_id":"org-1","project_id":"project-1","commitment_id":"commitment-1","company_id":"company-1","title":"VPO — Field change","description":"Added a hose bib","status":"draft","total_cents":18500,"currency":"usd","reason_code_id":"reason-2","origin":"field_mobile","requested_by":"user-1","photo_file_ids":[],"metadata":{"source":"mobile_v1"},"created_at":"2026-08-17T12:00:00.123456+00:00","updated_at":"2026-08-17T12:00:00.123456+00:00"},"meta":{"request_id":"request-1"}}"#
        let envelope = try JSONDecoder.arc.decode(
            APIEnvelope<MobileVarianceOrder>.self,
            from: Data(payload.utf8)
        )
        let order = envelope.data

        #expect(order.id == "vpo-2")
        #expect(order.commitment == nil)
        #expect(order.reason == nil)
        #expect(order.status == "draft")
        #expect(order.totalCents == 18_500)
        #expect(!order.isBackcharge)
        #expect(order.photoFileIds.isEmpty)
    }

    @Test
    func varianceRequestEncodesTheSchemaTheServerValidates() throws {
        let request = CreateVarianceOrderRequest(
            commitmentId: "commitment-1",
            reasonCodeId: "reason-1",
            amountCents: -25_000,
            note: "Drywall crew damaged the tub",
            photoFileIds: ["11111111-1111-4111-8111-111111111111"],
            clientId: "22222222-2222-4222-8222-222222222222"
        )
        let encoded = try JSONEncoder.arc.encode(request)
        let json = try #require(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )

        #expect(json["commitment_id"] as? String == "commitment-1")
        #expect(json["reason_code_id"] as? String == "reason-1")
        #expect(json["amount_cents"] as? Int == -25_000)
        #expect(json["note"] as? String == "Drywall crew damaged the tub")
        #expect((json["photo_file_ids"] as? [String])?.count == 1)
        #expect(json["client_id"] as? String == "22222222-2222-4222-8222-222222222222")
    }
}
