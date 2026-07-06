import SwiftUI

struct InboxView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss

    private var store: NotificationsStore { dependencies.notifications }
    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }

    var body: some View {
        NavigationStack {
            Group {
                if store.isLoading && store.notifications.isEmpty {
                    ProgressView()
                } else if let message = store.errorMessage, store.notifications.isEmpty {
                    ContentUnavailableView {
                        Label("Notifications unavailable", systemImage: "bell.slash")
                    } description: { Text(message) }
                } else if store.notifications.isEmpty {
                    ContentUnavailableView(
                        "You're all caught up",
                        systemImage: "tray",
                        description: Text("Assignments, mentions, and approvals will appear here.")
                    )
                } else {
                    List {
                        ForEach(store.notifications) { notification in
                            NotificationRow(notification: notification)
                                .contentShape(Rectangle())
                                .onTapGesture { markRead(notification) }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Notifications")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                if store.unreadCount > 0 {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Mark all read") { markAllRead() }
                    }
                }
            }
            .refreshable { await refresh() }
            .task { await load() }
        }
    }

    private func markRead(_ notification: MobileNotification) {
        guard let organizationID else { return }
        Task { await store.markRead(notification, organizationID: organizationID) }
    }

    private func markAllRead() {
        guard let organizationID else { return }
        Task { await store.markAllRead(organizationID: organizationID) }
    }

    private func load() async {
        guard let organizationID else { return }
        await store.load(organizationID: organizationID)
    }

    private func refresh() async {
        guard let organizationID else { return }
        await store.refresh(organizationID: organizationID)
    }
}

private struct NotificationRow: View {
    let notification: MobileNotification

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle()
                    .fill(notification.isRead ? Color.secondary.opacity(0.12) : Color.accentColor.opacity(0.18))
                    .frame(width: 36, height: 36)
                Image(systemName: notification.systemImage)
                    .font(.subheadline)
                    .foregroundStyle(notification.isRead ? Color.secondary : Color.accentColor)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(notification.title)
                    .font(.headline)
                    .fontWeight(notification.isRead ? .regular : .semibold)
                if !notification.message.isEmpty {
                    Text(notification.message).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
                }
                Text(notification.createdAtText).font(.caption).foregroundStyle(.tertiary)
            }
            Spacer()
            if !notification.isRead {
                Circle().fill(Color.accentColor).frame(width: 8, height: 8).padding(.top, 6)
            }
        }
        .padding(.vertical, 4)
    }
}
