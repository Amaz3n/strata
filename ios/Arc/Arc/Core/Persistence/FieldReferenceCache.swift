import CryptoKit
import Foundation

/// Downloaded field references are scoped to the signed-in user and organization.
/// Application Support survives cache eviction; references are excluded from backups.
struct FieldReferenceCache {
    let root: URL

    init(userID: String, organizationID: String, root: URL? = nil) {
        let base = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ArcFieldReferences", isDirectory: true)
        self.root = base.appendingPathComponent(Self.key(userID + ":" + organizationID), isDirectory: true)
    }

    func read<Value: Decodable>(_ type: Value.Type, key: String) -> Value? {
        guard let data = try? Data(contentsOf: url(key: key)) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    func write<Value: Encodable>(_ value: Value, key: String) throws {
        try prepareDirectory()
        try JSONEncoder().encode(value).write(to: url(key: key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func remove(key: String) {
        try? FileManager.default.removeItem(at: url(key: key))
    }

    func url(key: String) -> URL {
        root.appendingPathComponent(Self.key(key))
    }

    func prepareDirectory() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var directory = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
    }

    private static func key(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Durable service completion

protocol ServiceCompletionSecrets: Sendable {
    func data(for key: String) async throws -> Data?
    func insertIfAbsent(_ data: Data, for key: String) async throws -> Data
    func deleteMatching(_ data: Data, for key: String) async throws
}

/// Submitted payloads live in the device-only Keychain, not the unencrypted reference cache.
struct ServiceVisitCompletionJournal: Sendable {
    struct Record: Codable, Equatable, Sendable {
        let version: Int
        let attemptID: UUID
        let actorID: String
        let organizationID: String
        let projectID: String
        let visitID: String
        let input: MobileServiceVisitCompletion
    }
    struct Reservation: Sendable {
        let record: Record
        let bytes: Data
    }
    let secrets: any ServiceCompletionSecrets
    let actorID: String
    let organizationID: String
    let projectID: String
    let visitID: String
    init(secrets: any ServiceCompletionSecrets, actorID: String, organizationID: String, projectID: String, visitID: String) {
        self.secrets = secrets
        self.actorID = actorID.lowercased()
        self.organizationID = organizationID.lowercased()
        self.projectID = projectID.lowercased()
        self.visitID = visitID.lowercased()
    }
    private var key: String {
        // Home belongs in the record check. Moving a visit must not hide an earlier submission.
        let scope = [actorID, organizationID, visitID].joined(separator: ":")
        let hash = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
        return "service-completion-v1-" + hash
    }
    func read() async throws -> Record? {
        guard let bytes = try await secrets.data(for: key) else { return nil }
        return try decode(bytes)
    }
    func reserve(_ input: MobileServiceVisitCompletion) async throws -> Reservation {
        let proposed = Record(version: 1, attemptID: UUID(), actorID: actorID, organizationID: organizationID,
                              projectID: projectID, visitID: visitID, input: input)
        try validate(proposed)
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let proposedBytes = try encoder.encode(proposed)
        guard proposedBytes.count <= 40_960 else { throw APIError.invalidRequest }
        let bytes = try await secrets.insertIfAbsent(proposedBytes, for: key)
        let existing = try decode(bytes)
        guard existing.input == input else {
            throw APIError.conflict(code: "completion_recovery_required", message: "A saved completion already exists. Refresh this visit to recover its original details.")
        }
        return Reservation(record: existing, bytes: bytes)
    }
    func resolve(_ reservation: Reservation) async throws {
        // Validate provenance again so another home/principal reservation cannot clear this key.
        let record = try decode(reservation.bytes)
        guard record == reservation.record else { throw APIError.invalidResponse }
        try await secrets.deleteMatching(reservation.bytes, for: key)
    }
    @MainActor
    func submit(_ input: MobileServiceVisitCompletion, isCurrent: () -> Bool, onReserved: () -> Void = {},
                save: (MobileServiceVisitCompletion) async throws -> MobileServiceVisit) async throws -> MobileServiceVisit {
        guard isCurrent() else { throw CancellationError() }
        let reservation = try await reserve(input)
        guard isCurrent() else { throw CancellationError() }
        onReserved()
        do {
            let result = try await save(reservation.record.input)
            guard isCurrent() else { throw CancellationError() }
            guard result.id.lowercased() == visitID, result.projectId.lowercased() == projectID, result.status == "completed" else { throw APIError.invalidResponse }
            try await resolve(reservation)
            guard isCurrent() else { throw CancellationError() }
            return result
        } catch {
            // These typed SQL rejections prove that this submission did not commit.
            if let apiError = error as? APIError, case .conflict(let code, _) = apiError, ["visit_changed", "completion_already_recorded"].contains(code) {
                try await resolve(reservation)
            }
            throw error
        }
    }

    private func decode(_ bytes: Data) throws -> Record {
        guard bytes.count <= 40_960 else { throw APIError.invalidResponse }
        let record = try JSONDecoder().decode(Record.self, from: bytes)
        try validate(record)
        return record
    }
    private func validate(_ record: Record) throws {
        guard record.version == 1, record.actorID == actorID, record.organizationID == organizationID,
              record.projectID == projectID, record.visitID == visitID,
              [actorID, organizationID, projectID, visitID].allSatisfy({ UUID(uuidString: $0) != nil }) else {
            throw APIError.invalidResponse
        }
        let input = record.input
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        guard fractional.date(from: input.expectedVisitAt) != nil || ordinary.date(from: input.expectedVisitAt) != nil else { throw APIError.invalidResponse }
        guard !input.expectedVisitAt.isEmpty, input.expectedVisitAt.count <= 100,
              ["resolved", "needs_followup", "needs_parts", "not_warrantable"].contains(input.outcome),
              input.outcomeNote.utf16.count <= 4000, input.photoFileIds.count <= 20,
              input.photoFileIds.allSatisfy({ UUID(uuidString: $0) != nil }),
              input.laborHours.map({ $0.isFinite && $0 >= 0 && $0 <= 24 }) ?? true,
              input.laborRateCents.map({ $0 >= 0 && $0 <= 100_000_000 }) ?? true,
              input.materialCents >= 0 && input.materialCents <= 100_000_000 else { throw APIError.invalidResponse }
    }
}
