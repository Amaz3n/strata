import Foundation
import Observation

/// Backs the field-action modules (Tasks and Punch list). Both are list+mutate
/// surfaces so they share one store and one load lifecycle per project.
@MainActor
@Observable
final class FieldStore {
    private let api: MobileAPIService
    private let offlineStore: OfflineStore
    private let syncEngine: SyncEngine
    private let networkMonitor: NetworkMonitor

    private(set) var tasks: [MobileTask] = []
    private(set) var punchItems: [MobilePunchItem] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var loadedProjectID: String?
    var actionError: String?

    init(api: MobileAPIService, offlineStore: OfflineStore, syncEngine: SyncEngine, networkMonitor: NetworkMonitor) {
        self.api = api
        self.offlineStore = offlineStore
        self.syncEngine = syncEngine
        self.networkMonitor = networkMonitor
    }

    var openTaskCount: Int { tasks.filter { $0.status != "done" }.count }
    var openPunchCount: Int { punchItems.filter { $0.status != "closed" }.count }

    func load(projectID: String, organizationID: String, force: Bool = false) async {
        guard force || loadedProjectID != projectID else { return }
        loadedProjectID = projectID
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil
        do {
            async let remoteTasks = api.loadTasks(projectID: projectID, organizationID: organizationID)
            async let remotePunch = api.loadPunchItems(projectID: projectID, organizationID: organizationID)
            let (tasks, punch) = try await (remoteTasks, remotePunch)
            self.tasks = tasks
            self.punchItems = punch
        } catch is CancellationError {
            return
        } catch {
            if tasks.isEmpty && punchItems.isEmpty {
                errorMessage = (error as? APIError)?.userMessage ?? "Field items could not be loaded."
            }
        }
    }

    func refresh(projectID: String, organizationID: String) async {
        await load(projectID: projectID, organizationID: organizationID, force: true)
    }

    func setTaskStatus(_ task: MobileTask, status: String, projectID: String, organizationID: String) async {
        // Optimistic update keeps the checklist responsive whether on- or offline.
        replaceTask(task.withStatus(status))
        if networkMonitor.status != .offline {
            do {
                let updated = try await api.updateTaskStatus(
                    projectID: projectID, taskID: task.id, status: status, organizationID: organizationID
                )
                replaceTask(updated)
                return
            } catch {
                guard (error as? APIError)?.isRetryable == true else {
                    replaceTask(task) // revert on a hard failure
                    actionError = (error as? APIError)?.userMessage ?? "The task could not be updated."
                    return
                }
            }
        }
        enqueueStatus(path: "projects/\(projectID)/tasks/\(task.id)", status: status, organizationID: organizationID, projectID: projectID, keyPrefix: "task-status-\(task.id)")
    }

    func setPunchStatus(_ item: MobilePunchItem, status: String, projectID: String, organizationID: String) async {
        replacePunch(item.withStatus(status))
        if networkMonitor.status != .offline {
            do {
                let updated = try await api.updatePunchStatus(
                    projectID: projectID, punchItemID: item.id, status: status, organizationID: organizationID
                )
                replacePunch(updated)
                return
            } catch {
                guard (error as? APIError)?.isRetryable == true else {
                    replacePunch(item)
                    actionError = (error as? APIError)?.userMessage ?? "The punch item could not be updated."
                    return
                }
            }
        }
        enqueueStatus(path: "projects/\(projectID)/punch-items/\(item.id)", status: status, organizationID: organizationID, projectID: projectID, keyPrefix: "punch-status-\(item.id)")
    }

    private func enqueueStatus(path: String, status: String, organizationID: String, projectID: String, keyPrefix: String) {
        do {
            let body = try JSONEncoder.arc.encode(UpdateStatusRequest(status: status))
            try offlineStore.enqueue(
                path: path,
                method: "PATCH",
                organizationID: organizationID,
                projectID: projectID,
                body: body,
                idempotencyKey: "\(keyPrefix)-\(UUID().uuidString)"
            )
            syncEngine.mutationWasQueued()
        } catch {
            actionError = "The change could not be queued for sync."
        }
    }

    private func replaceTask(_ task: MobileTask) {
        if let index = tasks.firstIndex(where: { $0.id == task.id }) { tasks[index] = task }
    }

    private func replacePunch(_ item: MobilePunchItem) {
        if let index = punchItems.firstIndex(where: { $0.id == item.id }) { punchItems[index] = item }
    }
}

extension MobileTask {
    var isDone: Bool { status == "done" }

    /// Local optimistic copy with a new status (and completion timestamp).
    func withStatus(_ newStatus: String) -> MobileTask {
        MobileTask(
            id: id, projectId: projectId, title: title, description: description,
            status: newStatus, priority: priority, dueDate: dueDate,
            completedAt: newStatus == "done" ? (completedAt ?? .now) : nil,
            assignees: assignees, createdAt: createdAt, updatedAt: .now
        )
    }

    var statusLabel: String {
        switch status {
        case "todo": "To do"
        case "in_progress": "In progress"
        case "blocked": "Blocked"
        case "done": "Done"
        default: status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    var dueDateText: String? { MobileDateParser.display(dueDate) }
}

extension MobilePunchItem {
    var isClosed: Bool { status == "closed" }

    func withStatus(_ newStatus: String) -> MobilePunchItem {
        MobilePunchItem(
            id: id, projectId: projectId, title: title, description: description,
            status: newStatus, severity: severity, location: location, dueDate: dueDate,
            resolvedAt: newStatus == "closed" ? (resolvedAt ?? .now) : nil
        )
    }

    var statusLabel: String {
        status.replacingOccurrences(of: "_", with: " ").capitalized
    }

    var dueDateText: String? { MobileDateParser.display(dueDate) }
}
