import Foundation
import Observation

@MainActor
@Observable
final class NotificationsStore {
    private let api: MobileAPIService

    private(set) var notifications: [MobileNotification] = []
    private(set) var unreadCount = 0
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private var loadedOrganizationID: String?

    init(api: MobileAPIService) {
        self.api = api
    }

    func load(organizationID: String, force: Bool = false) async {
        guard force || loadedOrganizationID != organizationID else { return }
        loadedOrganizationID = organizationID
        isLoading = true
        defer { isLoading = false }
        do {
            let result = try await api.loadNotifications(organizationID: organizationID)
            notifications = result.notifications
            unreadCount = result.unreadCount
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            if notifications.isEmpty {
                errorMessage = (error as? APIError)?.userMessage ?? "Notifications could not be loaded."
            }
        }
    }

    func refresh(organizationID: String) async {
        await load(organizationID: organizationID, force: true)
    }

    /// Lightweight unread poll for the toolbar badge without disrupting a list view.
    func refreshBadge(organizationID: String) async {
        do {
            let result = try await api.loadNotifications(organizationID: organizationID)
            notifications = result.notifications
            unreadCount = result.unreadCount
        } catch {
            // Badge refresh failures are silent; the list view surfaces errors.
        }
    }

    func markRead(_ notification: MobileNotification, organizationID: String) async {
        guard !notification.isRead else { return }
        do {
            let updated = try await api.markNotificationRead(notificationID: notification.id, organizationID: organizationID)
            if let index = notifications.firstIndex(where: { $0.id == updated.id }) {
                notifications[index] = updated
            }
            unreadCount = notifications.filter { !$0.isRead }.count
        } catch {
            errorMessage = (error as? APIError)?.userMessage ?? "The notification could not be updated."
        }
    }

    func markAllRead(organizationID: String) async {
        do {
            try await api.markAllNotificationsRead(organizationID: organizationID)
            await refresh(organizationID: organizationID)
        } catch {
            errorMessage = (error as? APIError)?.userMessage ?? "Notifications could not be updated."
        }
    }
}

extension MobileNotification {
    var createdAtText: String {
        createdAt.formatted(.relative(presentation: .named))
    }

    var systemImage: String {
        if type.contains("mention") { return "at" }
        if type.contains("daily_log") { return "doc.text" }
        if type.contains("task") { return "checklist" }
        if type.contains("punch") { return "exclamationmark.bubble" }
        if type.contains("expense") || type.contains("bill") { return "receipt" }
        if type.contains("schedule") { return "calendar" }
        if type.contains("payment") || type.contains("invoice") { return "dollarsign.circle" }
        return "bell"
    }
}
