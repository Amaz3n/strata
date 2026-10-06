import Foundation
import Observation

/// Backs the cross-house superintendent surface. Unlike every other feature
/// store this one is scoped to the *organization*, not a project: a super
/// running fifteen lots needs one answer for all of them.
@MainActor
@Observable
final class MyHousesStore {
    private let api: MobileAPIService
    private let offlineStore: OfflineStore
    private let syncEngine: SyncEngine
    private let networkMonitor: NetworkMonitor
    private let logger = AppLogger(.app)

    private(set) var houses: [MobileMyHouse] = []
    private(set) var workGroups: [MobileMyHouseWorkGroup] = []
    private(set) var isLoadingHouses = false
    private(set) var isLoadingWork = false
    private(set) var housesError: String?
    private(set) var workError: String?
    private(set) var isUsingOfflineData = false
    /// Items the super has ticked off this session, whether the write landed or
    /// is still queued. Kept so the row stays visible and struck through
    /// instead of vanishing under the finger.
    private(set) var completedItemIDs: Set<String> = []
    /// The subset of the above still waiting in the offline mutation queue.
    private(set) var queuedItemIDs: Set<String> = []
    private(set) var loadedOrganizationID: String?

    var window: MyHouseWorkWindow = .today
    var actionError: String?

    init(api: MobileAPIService, offlineStore: OfflineStore, syncEngine: SyncEngine, networkMonitor: NetworkMonitor) {
        self.api = api
        self.offlineStore = offlineStore
        self.syncEngine = syncEngine
        self.networkMonitor = networkMonitor
    }

    // MARK: - Derived headline numbers

    var lateItemCount: Int {
        houses.reduce(0) { $0 + $1.lateCount }
    }

    /// Houses with nothing logged today — the super's own outstanding paperwork.
    var missingLogCount: Int {
        let today = MobileDateParser.todayKey
        return houses.filter { !$0.hasLog(on: today) }.count
    }

    var openWorkItemCount: Int {
        workGroups.reduce(0) { total, group in
            total + group.items.filter { !completedItemIDs.contains($0.id) }.count
        }
    }

    var hasLoadedOnce: Bool { loadedOrganizationID != nil }

    func house(forProjectID projectID: String) -> MobileMyHouse? {
        houses.first { $0.projectId == projectID }
    }

    // MARK: - Loading

    func load(organizationID: String, force: Bool = false) async {
        if loadedOrganizationID != organizationID {
            resetForOrganizationChange()
        } else if !force {
            return
        }
        loadedOrganizationID = organizationID
        isLoadingHouses = true
        isLoadingWork = true
        housesError = nil
        workError = nil
        defer {
            isLoadingHouses = false
            isLoadingWork = false
        }

        let requestedWindow = window
        async let remoteHouses = api.loadMyHouses(organizationID: organizationID)
        async let remoteWork = api.loadMyHouseWork(window: requestedWindow, organizationID: organizationID)

        do {
            let (houses, groups) = try await (remoteHouses, remoteWork)
            apply(houses: houses, groups: groups, organizationID: organizationID, window: requestedWindow)
            isUsingOfflineData = false
        } catch is CancellationError {
            return
        } catch {
            logger.error("My Houses load failed", error: error)
            restoreFromCache(organizationID: organizationID, window: requestedWindow, error: error)
        }
    }

    func refresh(organizationID: String) async {
        await load(organizationID: organizationID, force: true)
    }

    /// Switching the window reloads only the work feed — the roster is the same
    /// set of houses whichever horizon you look at.
    func selectWindow(_ newWindow: MyHouseWorkWindow, organizationID: String) async {
        guard newWindow != window else { return }
        window = newWindow
        await loadWork(organizationID: organizationID)
    }

    func loadWork(organizationID: String) async {
        isLoadingWork = true
        workError = nil
        defer { isLoadingWork = false }
        let requestedWindow = window
        do {
            let groups = try await api.loadMyHouseWork(window: requestedWindow, organizationID: organizationID)
            guard requestedWindow == window else { return }
            workGroups = groups
            prunePendingMarkers()
            try? offlineStore.cache(myHouseWork: groups, organizationID: organizationID, window: requestedWindow)
        } catch is CancellationError {
            return
        } catch {
            guard requestedWindow == window else { return }
            let cached = (try? offlineStore.cachedMyHouseWork(
                organizationID: organizationID,
                window: requestedWindow
            )) ?? []
            if cached.isEmpty {
                workGroups = []
                workError = (error as? APIError)?.userMessage ?? "Today's work could not be loaded."
            } else {
                workGroups = cached
                isUsingOfflineData = true
            }
        }
    }

    private func apply(
        houses: [MobileMyHouse],
        groups: [MobileMyHouseWorkGroup],
        organizationID: String,
        window requestedWindow: MyHouseWorkWindow
    ) {
        self.houses = houses
        if requestedWindow == window { workGroups = groups }
        prunePendingMarkers()
        try? offlineStore.cache(myHouses: houses, organizationID: organizationID)
        try? offlineStore.cache(myHouseWork: groups, organizationID: organizationID, window: requestedWindow)
    }

    private func restoreFromCache(
        organizationID: String,
        window requestedWindow: MyHouseWorkWindow,
        error: Error
    ) {
        let cachedHouses = (try? offlineStore.cachedMyHouses(organizationID: organizationID)) ?? []
        let cachedGroups = (try? offlineStore.cachedMyHouseWork(
            organizationID: organizationID,
            window: requestedWindow
        )) ?? []
        houses = cachedHouses
        if requestedWindow == window { workGroups = cachedGroups }
        prunePendingMarkers()
        isUsingOfflineData = !cachedHouses.isEmpty || !cachedGroups.isEmpty

        let message = (error as? APIError)?.userMessage
        housesError = cachedHouses.isEmpty ? (message ?? "Your houses could not be loaded.") : nil
        workError = cachedGroups.isEmpty ? (message ?? "Today's work could not be loaded.") : nil
    }

    private func resetForOrganizationChange() {
        houses = []
        workGroups = []
        completedItemIDs = []
        queuedItemIDs = []
        isUsingOfflineData = false
    }

    /// Drops optimistic markers for items the feed no longer carries, so the
    /// sets never grow without bound across a long shift.
    private func prunePendingMarkers() {
        let visible = Set(workGroups.flatMap { $0.items.map(\.id) })
        completedItemIDs.formIntersection(visible)
        queuedItemIDs.formIntersection(visible)
    }

    // MARK: - One-tap completion

    /// Completes a scheduled item without leaving the feed. Offline (or on a
    /// retryable failure) the write goes into the same durable mutation queue
    /// task and punch toggles use, so it replays when signal returns.
    func complete(_ item: MobileMyHouseWorkItem, organizationID: String) async {
        guard !completedItemIDs.contains(item.id) else { return }
        completedItemIDs.insert(item.id)

        if networkMonitor.status != .offline {
            do {
                _ = try await api.completeMyHouseScheduleItem(
                    scheduleItemID: item.scheduleItemId,
                    organizationID: organizationID
                )
                queuedItemIDs.remove(item.id)
                return
            } catch {
                guard (error as? APIError)?.isRetryable == true else {
                    completedItemIDs.remove(item.id)
                    actionError = (error as? APIError)?.userMessage ?? "This item could not be completed."
                    return
                }
            }
        }
        enqueueCompletion(item, organizationID: organizationID)
    }

    private func enqueueCompletion(_ item: MobileMyHouseWorkItem, organizationID: String) {
        do {
            let body = try JSONEncoder.arc.encode(CompleteScheduleItemRequest(progress: 100))
            // Completion is idempotent, so a stable key collapses repeat taps
            // into the single queued write the outbox already deduplicates.
            try offlineStore.enqueue(
                path: MobileAPIService.myHouseCompletePath(scheduleItemID: item.scheduleItemId),
                method: "POST",
                organizationID: organizationID,
                projectID: item.projectId,
                body: body,
                idempotencyKey: "my-house-complete-\(item.scheduleItemId)"
            )
            queuedItemIDs.insert(item.id)
            syncEngine.mutationWasQueued()
        } catch {
            completedItemIDs.remove(item.id)
            actionError = "This completion could not be queued for sync."
        }
    }
}

/// View-owned queue; generations fence same-scope refreshes as well as org/day changes.
@MainActor
@Observable
final class ServiceVisitsStore {
    typealias Loader = @MainActor (String, String, String?) async throws -> MobileServiceVisitPage
    private(set) var rows: [MobileServiceVisit] = []
    private(set) var nextCursor: String?
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private var organizationID: String?
    private var date: String?
    private var generation = 0
    private var seenCursors: Set<String> = []

    func refresh(organizationID: String?, date: String, load: Loader) async {
        generation += 1
        self.organizationID = organizationID
        self.date = date
        rows = []
        nextCursor = nil
        seenCursors = []
        errorMessage = nil
        isLoading = false
        guard let organizationID else { return }
        await fetch(organizationID: organizationID, date: date, cursor: nil, load: load)
    }

    func loadMore(load: Loader) async {
        guard !isLoading, let organizationID, let date, let nextCursor else { return }
        await fetch(organizationID: organizationID, date: date, cursor: nextCursor, load: load)
    }

    private func fetch(organizationID: String, date: String, cursor: String?, load: Loader) async {
        let requestedGeneration = generation
        isLoading = true
        errorMessage = nil
        defer { if generation == requestedGeneration { isLoading = false } }
        do {
            let page = try await load(organizationID, date, cursor)
            guard !Task.isCancelled, generation == requestedGeneration else { return }
            // A short page may still have more data when the database has a lower row cap.
            // Only the server cursor proves continuation or exhaustion.
            let ids = page.rows.map(\.id)
            guard page.rows.count <= 100, Set(ids).count == ids.count,
                  !ids.contains(where: { $0.isEmpty }),
                  page.nextCursor.map({ !page.rows.isEmpty && !$0.isEmpty && !seenCursors.contains($0) }) ?? true else {
                throw APIError.invalidResponse
            }
            // Rows can move forward between requests. Replace duplicates without creating duplicate identity.
            var indices = Dictionary(uniqueKeysWithValues: rows.enumerated().map { ($0.element.id, $0.offset) })
            for row in page.rows {
                if let index = indices[row.id] { rows[index] = row }
                else { indices[row.id] = rows.count; rows.append(row) }
            }
            if let next = page.nextCursor { seenCursors.insert(next) }
            nextCursor = page.nextCursor
        } catch is CancellationError {
        } catch {
            guard generation == requestedGeneration else { return }
            if let apiError = error as? APIError, apiError == .forbidden || apiError == .unauthorized {
                rows = []
                nextCursor = nil
            }
            errorMessage = (error as? APIError)?.userMessage ?? "Service visits could not be loaded."
        }
    }
}

/// Freezes an attempted submission so an uncertain network result can recover the same receipt.
@MainActor
@Observable
final class ServiceVisitCompletionStore {
    private(set) var attempted: MobileServiceVisitCompletion?
    private(set) var isDurable = false
    private(set) var needsRefresh = false
    private(set) var isSaving = false
    private(set) var completedVisit: MobileServiceVisit?
    private(set) var errorMessage: String?
    private var generation = 0

    func reset() {
        generation += 1
        attempted = nil
        isDurable = false
        needsRefresh = false
        isSaving = false
        completedVisit = nil
        errorMessage = nil
    }
    func restore(_ input: MobileServiceVisitCompletion?) {
        reset()
        attempted = input
        isDurable = input != nil
    }
    func markDurable(_ input: MobileServiceVisitCompletion) {
        if attempted == input { isDurable = true }
    }
    func submit(_ input: MobileServiceVisitCompletion,
                save: @MainActor (MobileServiceVisitCompletion) async throws -> MobileServiceVisit) async {
        guard !isSaving, !needsRefresh, completedVisit == nil else { return }
        if attempted == nil { attempted = input }
        guard let attempt = attempted else { return }
        let requestedGeneration = generation
        isSaving = true
        errorMessage = nil
        defer { if generation == requestedGeneration { isSaving = false } }
        do {
            let visit = try await save(attempt)
            guard !Task.isCancelled, generation == requestedGeneration else { return }
            guard visit.status == "completed" else { throw APIError.invalidResponse }
            completedVisit = visit
            isDurable = false
        } catch is CancellationError {
        } catch {
            guard generation == requestedGeneration else { return }
            if let apiError = error as? APIError, case .conflict(let code, _) = apiError, ["visit_changed", "completion_recovery_required", "completion_already_recorded"].contains(code) {
                needsRefresh = true
                attempted = nil
                isDurable = false
            }
            errorMessage = (error as? APIError)?.userMessage ?? "Completion could not be confirmed. Retry with the same details."
        }
    }
}
