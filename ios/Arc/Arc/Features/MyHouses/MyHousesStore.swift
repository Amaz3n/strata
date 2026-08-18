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
