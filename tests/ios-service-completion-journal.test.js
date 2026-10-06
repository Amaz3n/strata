const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

test('production completion journal survives process restart and preserves immutable scoped attempts', { skip: process.platform !== 'darwin' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-completion-journal-'))
  const models = fs.readFileSync('ios/Arc/Arc/Core/Models/MyHousesModels.swift', 'utf8').split('// MARK: - Technician visits')[1]
  const journal = fs.readFileSync('ios/Arc/Arc/Core/Persistence/FieldReferenceCache.swift', 'utf8').split('// MARK: - Durable service completion')[1]
  const apiError = fs.readFileSync('ios/Arc/Arc/Core/Networking/APIError.swift', 'utf8')
  const store = fs.readFileSync('ios/Arc/Arc/Features/MyHouses/MyHousesStore.swift', 'utf8').split('/// Freezes an attempted submission')[1]
  // File-backed secrets are injected test storage, not a claim about on-device Keychain behavior.
  const runner = String.raw`
actor FileSecrets: ServiceCompletionSecrets {
    let file: URL
    var values: [String: Data]
    var failInsert = false
    var failDelete = false
    init(_ file: URL) throws {
        self.file = file
        values = FileManager.default.fileExists(atPath: file.path) ? try JSONDecoder().decode([String: Data].self, from: Data(contentsOf: file)) : [:]
    }
    func flush() throws { try JSONEncoder().encode(values).write(to: file, options: .atomic) }
    func data(for key: String) throws -> Data? { values[key] }
    func insertIfAbsent(_ data: Data, for key: String) throws -> Data {
        if failInsert { throw APIError.invalidResponse }
        if let existing = values[key] { return existing }
        values[key] = data; try flush(); return data
    }
    func deleteMatching(_ data: Data, for key: String) throws {
        if failDelete { throw APIError.invalidResponse }
        if values[key] == data { values[key] = nil; try flush() }
    }
    func failures(insert: Bool = false, delete: Bool = false) { failInsert = insert; failDelete = delete }
    func replaceOnlyValue(_ value: Data) throws {
        precondition(values.count == 1)
        values[values.keys.first!] = value; try flush()
    }
}
@main struct JournalChecks {
    @MainActor static func main() async throws {
        let stage = CommandLine.arguments[1]
        let secrets = try FileSecrets(URL(fileURLWithPath: CommandLine.arguments[2]))
        let actor = "00000000-0000-4000-8000-000000000001"
        let org = "00000000-0000-4000-8000-000000000002"
        let home = "00000000-0000-4000-8000-000000000003"
        let visit = "00000000-0000-4000-8000-000000000004"
        let other = "00000000-0000-4000-8000-000000000005"
        let input = MobileServiceVisitCompletion(expectedVisitAt: "2026-10-03T00:00:00.123456+00:00", outcome: "resolved", outcomeNote: "Repaired door\nOriginal notes", photoFileIds: [other], laborHours: 1.25, laborRateCents: 50001, materialCents: 37)
        let journal = ServiceVisitCompletionJournal(secrets: secrets, actorID: actor, organizationID: org, projectID: home, visitID: visit)
        if stage == "persist" {
            let empty = try await journal.read(); precondition(empty == nil)
            let reservation = try await journal.reserve(input)
            precondition(reservation.record.input == input)
            print("Persisted original completion before network I/O")
            return // Simulates termination while response/commit state is unknown.
        }
        let recovered = try await journal.read(); precondition(recovered?.input == input)
        let state = ServiceVisitCompletionStore()
        state.restore(recovered?.input)
        precondition(state.attempted == input && state.isDurable)
        let reserved = try await journal.reserve(input)
        precondition(reserved.record.attemptID == recovered?.attemptID)
        let changed = MobileServiceVisitCompletion(expectedVisitAt: input.expectedVisitAt, outcome: "needs_parts", outcomeNote: "Changed", photoFileIds: [], laborHours: nil, laborRateCents: nil, materialCents: 0)
        do { _ = try await journal.reserve(changed); fatalError("Existing attempt overwritten") }
        catch let error as APIError { if case .conflict(let code, _) = error { precondition(code == "completion_recovery_required") } else { throw error } }
        let stillOriginal = try await journal.read(); precondition(stillOriginal == recovered)
        for otherJournal in [
            ServiceVisitCompletionJournal(secrets: secrets, actorID: other, organizationID: org, projectID: home, visitID: visit),
            ServiceVisitCompletionJournal(secrets: secrets, actorID: actor, organizationID: other, projectID: home, visitID: visit),
            ServiceVisitCompletionJournal(secrets: secrets, actorID: actor, organizationID: org, projectID: home, visitID: other),
        ] { let missing = try await otherJournal.read(); precondition(missing == nil) }
        let movedHome = ServiceVisitCompletionJournal(secrets: secrets, actorID: actor, organizationID: org, projectID: other, visitID: visit)
        do { _ = try await movedHome.read(); fatalError("Moved home hid original attempt") } catch {}
        do { try await movedHome.resolve(reserved); fatalError("Foreign home cleared original attempt") } catch {}
        await secrets.failures(delete: true)
        do { try await journal.resolve(reserved); fatalError("Delete failure hidden") } catch {}
        let afterFailedCleanup = try await journal.read(); precondition(afterFailedCleanup == recovered)
        await secrets.failures()
        try await journal.resolve(reserved)
        let absent = try await journal.read(); precondition(absent == nil)
        // An older response must not clear a new reservation, even with identical input.
        let newer = try await journal.reserve(input)
        precondition(newer.record.attemptID != reserved.record.attemptID)
        try await journal.resolve(reserved)
        let newerRead = try await journal.read(); precondition(newerRead?.attemptID == newer.record.attemptID)
        try await journal.resolve(newer)
        await secrets.failures(insert: true)
        var posted = false
        do { _ = try await journal.reserve(input); posted = true } catch {}
        precondition(!posted) // Persistence failure precedes request creation.
        await secrets.failures()
        async let one = journal.reserve(input)
        async let two = journal.reserve(input)
        let both = try await (one, two)
        precondition(both.0.record.attemptID == both.1.record.attemptID)
        let retained = both.0
        try await secrets.replaceOnlyValue(Data("corrupted".utf8))
        do { _ = try await journal.read(); fatalError("Corruption treated as absent") } catch {}
        do { _ = try await journal.reserve(input); fatalError("Corruption overwritten") } catch {}
        try await secrets.replaceOnlyValue(retained.bytes)
        var badIdentity = try JSONSerialization.jsonObject(with: retained.bytes) as! [String: Any]
        badIdentity["actorID"] = other
        try await secrets.replaceOnlyValue(JSONSerialization.data(withJSONObject: badIdentity))
        do { _ = try await journal.read(); fatalError("Foreign principal decoded") } catch {}
        try await secrets.replaceOnlyValue(Data(repeating: 120, count: 40961))
        do { _ = try await journal.read(); fatalError("Oversized recovery read") } catch {}
        try await secrets.replaceOnlyValue(retained.bytes)
        try await journal.resolve(retained)
        func finished(_ project: String = home, _ id: String = visit) -> MobileServiceVisit {
            MobileServiceVisit(id: id, requestId: other, projectId: project, visitNumber: 1,
                               windowStart: .now, windowEnd: .now, status: "completed", request: nil, project: nil)
        }
        // Run the real production submit pipeline, not an imitation of its ordering.
        var markedDurable = false
        do {
            _ = try await journal.submit(input, isCurrent: { true }, onReserved: { markedDurable = true }) { payload in
                precondition(markedDurable)
                let durable = try await journal.read()
                precondition(durable?.input == payload && payload == input)
                throw APIError.transport(description: "Response unknown")
            }
            fatalError("Uncertain response hidden")
        } catch {}
        let durableUnknown = try await journal.read(); precondition(durableUnknown?.input == input)
        await secrets.failures(delete: true)
        do { _ = try await journal.submit(input, isCurrent: { true }) { _ in finished() }; fatalError("Cleanup failure hidden") } catch {}
        let cleanupPending = try await journal.read(); precondition(cleanupPending?.input == input)
        await secrets.failures()
        let recoveredResult = try await journal.submit(input, isCurrent: { true }) { payload in precondition(payload == input); return finished() }
        precondition(recoveredResult.status == "completed")
        let cleared = try await journal.read(); precondition(cleared == nil)
        do { _ = try await journal.submit(input, isCurrent: { true }) { _ in finished(other) }; fatalError("Wrong home accepted") } catch {}
        let wrongHomePending = try await journal.read(); precondition(wrongHomePending?.input == input)
        do {
            _ = try await journal.submit(input, isCurrent: { true }) { _ in throw APIError.conflict(code: "visit_changed", message: "No commit; refresh") }
            fatalError("Revision rejection hidden")
        } catch {}
        let revisionCleared = try await journal.read(); precondition(revisionCleared == nil)
        var current = true
        do {
            _ = try await journal.submit(input, isCurrent: { current }) { _ in current = false; return finished() }
            fatalError("Late scope response accepted")
        } catch {}
        let scopePending = try await journal.read(); precondition(scopePending?.input == input)
        let scopeReservation = try await journal.reserve(input); try await journal.resolve(scopeReservation)
        await secrets.failures(insert: true)
        var calledNetwork = false
        markedDurable = false
        do { _ = try await journal.submit(input, isCurrent: { true }, onReserved: { markedDurable = true }) { _ in calledNetwork = true; return finished() } } catch {}
        precondition(!calledNetwork && !markedDurable)
        await secrets.failures()
        let unicodeTooLong = MobileServiceVisitCompletion(expectedVisitAt: input.expectedVisitAt, outcome: "resolved", outcomeNote: String(repeating: "😀", count: 2001), photoFileIds: [], laborHours: nil, laborRateCents: nil, materialCents: 0)
        do { _ = try await journal.reserve(unicodeTooLong); fatalError("Backend UTF-16 note limit violated") } catch {}
        let noInvalidAttempt = try await journal.read(); precondition(noInvalidAttempt == nil)
        do {
            _ = try await journal.submit(input, isCurrent: { true }) { _ in throw APIError.conflict(code: "completion_already_recorded", message: "Another completion owns the receipt") }
            fatalError("Recorded receipt conflict hidden")
        } catch {}
        let competingCleared = try await journal.read(); precondition(competingCleared == nil)
        print("Recovered immutable completion after process restart; isolation and conditional cleanup passed")
    }
}
`
  const source = path.join(directory, 'Journal.swift')
  const executable = path.join(directory, 'journal-tests')
  const storage = path.join(directory, 'test-secrets.json')
  fs.writeFileSync(source, `import Foundation\nimport CryptoKit\nimport Observation\n${models}\n${journal}\n${apiError}\n/// Freezes an attempted submission${store}\n${runner}`)
  try {
    execFileSync('xcrun', ['swiftc', '-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`, '-module-cache-path', path.join(directory, 'modules'), source, '-o', executable], { timeout: 120000, stdio: 'pipe' })
    assert.match(execFileSync(executable, ['persist', storage], { timeout: 30000, encoding: 'utf8' }), /Persisted original completion/)
    assert.match(execFileSync(executable, ['recover', storage], { timeout: 30000, encoding: 'utf8' }), /isolation and conditional cleanup passed/)
    const keychain = fs.readFileSync('ios/Arc/Arc/Core/Security/KeychainStore.swift', 'utf8')
    assert.match(keychain, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/)
    assert.match(keychain, /kSecAttrGeneric as String\] = Data\(SHA256\.hash\(data: data\)\)/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
