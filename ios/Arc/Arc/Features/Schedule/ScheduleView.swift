import SwiftUI

struct ProjectScheduleView: View {
    @Environment(AppDependencies.self) private var dependencies
    let project: MobileProject

    private var store: ScheduleStore { dependencies.schedule }
    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }

    private var grouped: [(group: ScheduleStatusGroup, items: [MobileScheduleItem])] {
        ScheduleStatusGroup.allCases.compactMap { group in
            let items = store.items.filter { $0.statusGroup == group }
            return items.isEmpty ? nil : (group, items)
        }
    }

    var body: some View {
        List {
            if store.isLoading && store.items.isEmpty {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            } else if let message = store.errorMessage, store.items.isEmpty {
                ContentUnavailableView {
                    Label("Schedule unavailable", systemImage: "calendar.badge.exclamationmark")
                } description: {
                    Text(message)
                }
            } else if store.items.isEmpty {
                ContentUnavailableView(
                    "No schedule items",
                    systemImage: "calendar",
                    description: Text("Activities scheduled for this project will appear here.")
                )
            } else {
                ForEach(grouped, id: \.group.id) { section in
                    Section {
                        ForEach(section.items) { item in
                            ScheduleItemRow(item: item)
                        }
                    } header: {
                        Label("\(section.group.title) (\(section.items.count))", systemImage: section.group.systemImage)
                    }
                }
            }
        }
        .navigationTitle("Schedule")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await refresh() }
        .task { await load() }
    }

    private func load() async {
        guard let organizationID else { return }
        await store.load(projectID: project.id, organizationID: organizationID)
    }

    private func refresh() async {
        guard let organizationID else { return }
        await store.refresh(projectID: project.id, organizationID: organizationID)
    }
}

private struct ScheduleItemRow: View {
    let item: MobileScheduleItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(item.name)
                    .font(.headline)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if item.isCriticalPath {
                    Image(systemName: "bolt.fill")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .accessibilityLabel("Critical path")
                }
            }

            if let range = item.dateRangeText {
                Label(range, systemImage: "clock")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            let chips = [item.trade, item.phase, item.location].compactMap { $0 }
            if !chips.isEmpty {
                Text(chips.joined(separator: " • "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if !item.assignees.isEmpty {
                Label(item.assignees.joined(separator: ", "), systemImage: "person.2")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if item.progress > 0 && item.progress < 100 {
                ProgressView(value: item.progress, total: 100)
                    .tint(.accentColor)
                Text("\(Int(item.progress))% complete")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}
