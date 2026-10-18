const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// Run the production Swift state machine with injected I/O; no server/session/customer access.
test('native service visits handle continuation, retry, revocation and stale responses', { skip: process.platform !== 'darwin' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-service-visits-tests-'))
  const models = fs.readFileSync('ios/Arc/Arc/Core/Models/MyHousesModels.swift', 'utf8').split('// MARK: - Technician visits')[1]
  const store = fs.readFileSync('ios/Arc/Arc/Features/MyHouses/MyHousesStore.swift', 'utf8').split('/// View-owned queue;')[1]
  const apiError = fs.readFileSync('ios/Arc/Arc/Core/Networking/APIError.swift', 'utf8')
  const runner = String.raw`
@main struct QueueChecks {
    @MainActor static func main() async throws {
        let store = ServiceVisitsStore()
        func row(_ id: String, _ status: String = "scheduled") -> MobileServiceVisit {
            MobileServiceVisit(id: id, requestId: "request", projectId: "home", visitNumber: 1,
                               windowStart: .now, windowEnd: .now, status: status, request: nil, project: nil)
        }
        await store.refresh(organizationID: "org", date: "2026-10-03") { org, date, cursor in
            precondition(org == "org" && date == "2026-10-03" && cursor == nil)
            return MobileServiceVisitPage(rows: [row("a")], nextCursor: "opaque")
        }
        precondition(store.rows.count == 1 && store.nextCursor == "opaque") // Short page still continues.
        await store.loadMore { _, _, cursor in
            precondition(cursor == "opaque")
            throw APIError.transport(description: "offline")
        }
        precondition(store.rows.count == 1 && store.nextCursor == "opaque" && store.errorMessage != nil)
        await store.loadMore { _, _, cursor in
            precondition(cursor == "opaque")
            return MobileServiceVisitPage(rows: [row("a", "completed"), row("b")], nextCursor: nil)
        }
        precondition(store.rows.map(\.id) == ["a", "b"] && store.rows[0].status == "completed" && store.nextCursor == nil)
        await store.refresh(organizationID: "org", date: "2026-10-03") { _, _, _ in
            MobileServiceVisitPage(rows: [row("a")], nextCursor: "again")
        }
        await store.loadMore { _, _, _ in MobileServiceVisitPage(rows: [row("b")], nextCursor: "again") }
        precondition(store.rows.count == 1 && store.nextCursor == "again" && store.errorMessage != nil)
        await store.loadMore { _, _, _ in MobileServiceVisitPage(rows: [], nextCursor: "other") }
        precondition(store.rows.count == 1 && store.errorMessage != nil)
        await store.loadMore { _, _, _ in throw APIError.forbidden }
        precondition(store.rows.isEmpty && store.nextCursor == nil && store.errorMessage != nil)
        await store.refresh(organizationID: "org", date: "2026-10-03") { _, _, _ in
            MobileServiceVisitPage(rows: [row("a"), row("a")], nextCursor: nil)
        }
        precondition(store.rows.isEmpty && store.errorMessage != nil)
        var pending: CheckedContinuation<MobileServiceVisitPage, Never>?
        let old = Task { @MainActor in
            await store.refresh(organizationID: "old-org", date: "2026-10-03") { _, _, _ in
                await withCheckedContinuation { pending = $0 }
            }
        }
        while pending == nil { await Task.yield() }
        await store.refresh(organizationID: "new-org", date: "2026-10-04") { org, date, cursor in
            precondition(org == "new-org" && date == "2026-10-04" && cursor == nil)
            return MobileServiceVisitPage(rows: [row("new")], nextCursor: nil)
        }
        pending?.resume(returning: MobileServiceVisitPage(rows: [row("old")], nextCursor: "stale"))
        await old.value
        precondition(store.rows.map(\.id) == ["new"] && store.nextCursor == nil && !store.isLoading)
        var sameScopePending: CheckedContinuation<MobileServiceVisitPage, Never>?
        let olderRefresh = Task { @MainActor in
            await store.refresh(organizationID: "new-org", date: "2026-10-04") { _, _, _ in
                await withCheckedContinuation { sameScopePending = $0 }
            }
        }
        while sameScopePending == nil { await Task.yield() }
        await store.refresh(organizationID: "new-org", date: "2026-10-04") { _, _, _ in
            MobileServiceVisitPage(rows: [row("latest")], nextCursor: nil)
        }
        sameScopePending?.resume(returning: MobileServiceVisitPage(rows: [row("older")], nextCursor: nil))
        await olderRefresh.value
        precondition(store.rows.map(\.id) == ["latest"])
        await store.refresh(organizationID: "new-org", date: "2026-10-04") { _, _, _ in
            MobileServiceVisitPage(rows: (0...100).map { row(String($0)) }, nextCursor: nil)
        }
        precondition(store.rows.isEmpty && store.errorMessage != nil)
        await store.refresh(organizationID: nil, date: "2026-10-04") { _, _, _ in fatalError("Must not load signed-out data") }
        precondition(store.rows.isEmpty && store.errorMessage == nil)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .iso8601
        let payload = #"{"data":[{"id":"visit","request_id":"request","project_id":"home","visit_number":2,"window_start":"2026-10-03T10:00:00Z","window_end":"2026-10-03T11:00:00Z","status":"scheduled","request":{"title":"Door","description":null,"severity":"routine_30"},"project":{"name":"Lot 1"}}],"meta":{"request_id":"req","next_cursor":"opaque"}}"#
        let envelope = try decoder.decode(APIEnvelope<[MobileServiceVisit]>.self, from: Data(payload.utf8))
        precondition(envelope.data[0].request?.title == "Door" && envelope.meta.nextCursor == "opaque")
        let cents1 = try MobileServiceVisitCompletion.cents("500.01"); precondition(cents1 == 50001)
        let cents2 = try MobileServiceVisitCompletion.cents("1,2"); precondition(cents2 == 120)
        let cents3 = try MobileServiceVisitCompletion.cents("1000000.00"); precondition(cents3 == 100000000)
        let cents4 = try MobileServiceVisitCompletion.cents(""); precondition(cents4 == nil)
        for invalid in ["-1", "0.001", "1,000.00", "NaN", "1000000.01", "1e2"] {
            do { _ = try MobileServiceVisitCompletion.cents(invalid); fatalError("Invalid money accepted") } catch {}
        }
        precondition(MobileServiceVisitCompletion.amountText(50001) == "500.01")
        let completion = ServiceVisitCompletionStore()
        let original = MobileServiceVisitCompletion(expectedVisitAt: "2026-10-03T00:00:00.123456Z", outcome: "resolved", outcomeNote: "Repaired", photoFileIds: ["photo"], laborHours: 1.25, laborRateCents: 50001, materialCents: 37)
        let changed = MobileServiceVisitCompletion(expectedVisitAt: "2026-10-03T00:00:00.123456Z", outcome: "needs_parts", outcomeNote: "Changed", photoFileIds: [], laborHours: nil, laborRateCents: nil, materialCents: 0)
        await completion.submit(original) { payload in
            precondition(payload == original)
            throw APIError.transport(description: "Response lost after commit")
        }
        precondition(completion.attempted == original && completion.completedVisit == nil && completion.errorMessage != nil)
        await completion.submit(changed) { payload in
            precondition(payload == original) // Caller changes never alter a pending recovery attempt.
            return row("a", "completed")
        }
        precondition(completion.completedVisit?.status == "completed")
        await completion.submit(changed) { _ in fatalError("Completed attempt must not repeat") }
        completion.reset()
        var completionPending: CheckedContinuation<MobileServiceVisit, Never>?
        let oldCompletion = Task { @MainActor in
            await completion.submit(original) { _ in await withCheckedContinuation { completionPending = $0 } }
        }
        while completionPending == nil { await Task.yield() }
        completion.reset()
        completionPending?.resume(returning: row("old", "completed"))
        await oldCompletion.value
        precondition(completion.attempted == nil && completion.completedVisit == nil && !completion.isSaving)
        await completion.submit(original) { _ in throw APIError.conflict(code: "visit_changed", message: "Refresh visit") }
        precondition(completion.needsRefresh && completion.attempted == nil)
        await completion.submit(changed) { _ in fatalError("Changed visit must refresh before another write") }
        completion.reset()
        precondition(!completion.needsRefresh && !completion.isDurable)
        completion.restore(original)
        precondition(completion.attempted == original && completion.isDurable)
        completion.reset()
        do {
            completion.restore(original)
            await completion.submit(original) { _ in throw APIError.conflict(code: "completion_already_recorded", message: "Refresh recorded outcome") }
            precondition(completion.needsRefresh && completion.attempted == nil)
            completion.reset()
        }
        print("Native service queue checks passed")
    }
}
`
  const envelope = fs.readFileSync('ios/Arc/Arc/Core/Models/MobileModels.swift', 'utf8').split('struct MobileUser:')[0]
  const source = path.join(directory, 'Queue.swift')
  fs.writeFileSync(source, `import Foundation\nimport Observation\n${models}\n/// View-owned queue;${store}\n${apiError}\n${envelope}\n${runner}`)
  const executable = path.join(directory, 'queue-tests')
  try {
    execFileSync('xcrun', ['swiftc', '-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`, '-module-cache-path', path.join(directory, 'modules'), source, '-o', executable], { timeout: 120000, stdio: 'pipe' })
    assert.match(execFileSync(executable, { timeout: 30000, encoding: 'utf8' }), /Native service queue checks passed/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
