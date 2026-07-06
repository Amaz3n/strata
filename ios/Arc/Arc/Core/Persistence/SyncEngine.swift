import Foundation
import Observation

@MainActor
@Observable
final class SyncEngine {
    enum Status: Equatable {
        case idle
        case syncing
        case offline
        case failed(message: String)
    }

    private(set) var status: Status = .idle
    private(set) var pendingMutationCount = 0

    private let store: OfflineStore
    private let client: APIClient
    private let session: SessionStore

    init(store: OfflineStore, client: APIClient, session: SessionStore) {
        self.store = store
        self.client = client
        self.session = session
        refreshPendingCount()
    }

    func handleConnectivity(_ connectivity: NetworkMonitor.Status) async {
        switch connectivity {
        case .offline:
            status = .offline
            refreshPendingCount()
        case .online:
            await synchronize()
        case .unknown:
            refreshPendingCount()
        }
    }

    func mutationWasQueued() {
        refreshPendingCount()
    }

    func synchronize() async {
        guard status != .syncing else { return }
        guard session.userID != nil else {
            status = .idle
            return
        }
        status = .syncing
        do {
            let token = try await session.validAccessToken()
            var encounteredTransientFailure = false
            var encounteredPermanentFailure = false
            for mutation in try store.dueMutations() {
                do {
                    var request = try client.request(
                        path: mutation.path,
                        method: mutation.method,
                        accessToken: token,
                        organizationID: mutation.organizationID
                    )
                    request.httpBody = mutation.body
                    if mutation.body != nil {
                        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    }
                    request.setValue(mutation.idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
                    try await client.send(request)
                    try store.complete(mutation)
                } catch {
                    if (error as? APIError)?.isRetryable == true {
                        try store.retry(mutation, error: error)
                        encounteredTransientFailure = true
                    } else {
                        try store.fail(mutation, error: error)
                        encounteredPermanentFailure = true
                    }
                }
            }
            refreshPendingCount()
            if encounteredPermanentFailure {
                status = .failed(message: "A queued change needs attention")
            } else if encounteredTransientFailure {
                status = .offline
            } else {
                status = .idle
            }
        } catch {
            refreshPendingCount()
            status = (error as? APIError)?.isRetryable == true
                ? .offline
                : .failed(message: "Sync needs attention")
        }
    }

    private func refreshPendingCount() {
        pendingMutationCount = (try? store.pendingMutationCount()) ?? 0
    }
}
