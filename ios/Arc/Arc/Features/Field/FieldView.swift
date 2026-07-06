import SwiftUI

struct ProjectMoreView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(AppRouter.self) private var router
    let project: MobileProject

    private var field: FieldStore { dependencies.field }
    private var info: ProjectInfoStore { dependencies.projectInfo }

    var body: some View {
        List {
            Section("Field tools") {
                Button { router.navigate(to: .schedule) } label: {
                    NavigationRow(title: "Schedule", systemImage: "calendar")
                }
                Button { router.navigate(to: .tasks) } label: {
                    NavigationRow(title: "Tasks", systemImage: "checklist", badge: field.openTaskCount)
                }
                Button { router.navigate(to: .punch) } label: {
                    NavigationRow(title: "Punch List", systemImage: "exclamationmark.bubble", badge: field.openPunchCount)
                }
                Button { router.navigate(to: .rfis) } label: {
                    NavigationRow(title: "RFIs", systemImage: "questionmark.bubble", badge: info.openRfiCount)
                }
                Button { router.navigate(to: .expenses) } label: {
                    NavigationRow(title: "Expenses", systemImage: "receipt")
                }
            }
            Section("Project") {
                Button { router.navigate(to: .team) } label: {
                    NavigationRow(title: "Team", systemImage: "person.2")
                }
                Button { router.navigate(to: .projectDetails) } label: {
                    NavigationRow(title: "Project Details", systemImage: "info.circle")
                }
            }
            Section("Arc") {
                Button { router.presentedSheet = .account } label: {
                    NavigationRow(title: "Account & Organization", systemImage: "person.crop.circle")
                }
            }
        }
        .buttonStyle(.plain)
        .navigationTitle("More")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard let organizationID = dependencies.workspace.selectedOrganizationID else { return }
            await field.load(projectID: project.id, organizationID: organizationID)
            await info.loadRfis(projectID: project.id, organizationID: organizationID)
        }
    }
}

// MARK: - Tasks

struct ProjectTasksView: View {
    @Environment(AppDependencies.self) private var dependencies
    let project: MobileProject

    private var store: FieldStore { dependencies.field }
    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }

    private var openTasks: [MobileTask] { store.tasks.filter { !$0.isDone } }
    private var doneTasks: [MobileTask] { store.tasks.filter { $0.isDone } }

    var body: some View {
        List {
            if store.isLoading && store.tasks.isEmpty {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            } else if let message = store.errorMessage, store.tasks.isEmpty {
                ContentUnavailableView {
                    Label("Tasks unavailable", systemImage: "checklist")
                } description: { Text(message) }
            } else if store.tasks.isEmpty {
                ContentUnavailableView(
                    "No tasks",
                    systemImage: "checklist",
                    description: Text("Tasks assigned on this project will appear here.")
                )
            } else {
                if !openTasks.isEmpty {
                    Section("Open (\(openTasks.count))") {
                        ForEach(openTasks) { task in TaskRow(task: task, onToggle: { toggle(task) }) }
                    }
                }
                if !doneTasks.isEmpty {
                    Section("Done (\(doneTasks.count))") {
                        ForEach(doneTasks) { task in TaskRow(task: task, onToggle: { toggle(task) }) }
                    }
                }
            }
        }
        .navigationTitle("Tasks")
        .navigationBarTitleDisplayMode(.inline)
        .projectSwitcherPullOrRefresh { await refresh() }
        .task { await load() }
        .alert("Couldn't update task", isPresented: Binding(
            get: { store.actionError != nil },
            set: { if !$0 { store.actionError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.actionError ?? "")
        }
    }

    private func toggle(_ task: MobileTask) {
        guard let organizationID else { return }
        Task { await store.setTaskStatus(task, status: task.isDone ? "todo" : "done", projectID: project.id, organizationID: organizationID) }
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

private struct TaskRow: View {
    let task: MobileTask
    let onToggle: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button(action: onToggle) {
                Image(systemName: task.isDone ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(task.isDone ? Color.accentColor : .secondary)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 4) {
                Text(task.title)
                    .font(.headline)
                    .strikethrough(task.isDone, color: .secondary)
                    .foregroundStyle(task.isDone ? .secondary : .primary)
                if let description = task.description, !description.isEmpty {
                    Text(description).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                HStack(spacing: 8) {
                    StatusBadge(status: task.status)
                    if let priority = task.priority, !priority.isEmpty {
                        StatusBadge(text: priority.capitalized, tint: ArcStatusColor.severity(priority))
                    }
                    if let due = task.dueDateText {
                        Label(due, systemImage: "calendar").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if !task.assignees.isEmpty {
                    Label(task.assignees.joined(separator: ", "), systemImage: "person")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Punch list

struct ProjectPunchView: View {
    @Environment(AppDependencies.self) private var dependencies
    let project: MobileProject

    private var store: FieldStore { dependencies.field }
    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }

    private var openItems: [MobilePunchItem] { store.punchItems.filter { !$0.isClosed } }
    private var closedItems: [MobilePunchItem] { store.punchItems.filter { $0.isClosed } }

    var body: some View {
        List {
            if store.isLoading && store.punchItems.isEmpty {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            } else if let message = store.errorMessage, store.punchItems.isEmpty {
                ContentUnavailableView {
                    Label("Punch list unavailable", systemImage: "exclamationmark.bubble")
                } description: { Text(message) }
            } else if store.punchItems.isEmpty {
                ContentUnavailableView(
                    "No punch items",
                    systemImage: "exclamationmark.bubble",
                    description: Text("Open punch-list items will appear here.")
                )
            } else {
                if !openItems.isEmpty {
                    Section("Open (\(openItems.count))") {
                        ForEach(openItems) { item in PunchRow(item: item, onToggle: { toggle(item) }) }
                    }
                }
                if !closedItems.isEmpty {
                    Section("Closed (\(closedItems.count))") {
                        ForEach(closedItems) { item in PunchRow(item: item, onToggle: { toggle(item) }) }
                    }
                }
            }
        }
        .navigationTitle("Punch List")
        .navigationBarTitleDisplayMode(.inline)
        .projectSwitcherPullOrRefresh { await refresh() }
        .task { await load() }
        .alert("Couldn't update item", isPresented: Binding(
            get: { store.actionError != nil },
            set: { if !$0 { store.actionError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.actionError ?? "")
        }
    }

    private func toggle(_ item: MobilePunchItem) {
        guard let organizationID else { return }
        Task { await store.setPunchStatus(item, status: item.isClosed ? "open" : "closed", projectID: project.id, organizationID: organizationID) }
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

private struct PunchRow: View {
    let item: MobilePunchItem
    let onToggle: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button(action: onToggle) {
                Image(systemName: item.isClosed ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(item.isClosed ? Color.accentColor : .secondary)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.headline)
                    .strikethrough(item.isClosed, color: .secondary)
                    .foregroundStyle(item.isClosed ? .secondary : .primary)
                if let description = item.description, !description.isEmpty {
                    Text(description).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                HStack(spacing: 8) {
                    StatusBadge(status: item.status)
                    if let severity = item.severity, !severity.isEmpty {
                        StatusBadge(text: severity.capitalized, tint: ArcStatusColor.severity(severity))
                    }
                    if let location = item.location, !location.isEmpty {
                        Label(location, systemImage: "mappin").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Shared rows

struct NavigationRow: View {
    let title: String
    let systemImage: String
    var badge: Int? = nil

    var body: some View {
        HStack {
            Label(title, systemImage: systemImage)
            Spacer()
            if let badge, badge > 0 {
                Text("\(badge)")
                    .font(.caption.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Color.accentColor, in: Capsule())
            }
            Image(systemName: "chevron.right")
                .font(.caption.bold())
                .foregroundStyle(.tertiary)
        }
        .foregroundStyle(.primary)
        .contentShape(Rectangle())
    }
}

struct ModuleEmptyRow: View {
    let title: String
    let subtitle: String
    let systemImage: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(.secondary)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}
