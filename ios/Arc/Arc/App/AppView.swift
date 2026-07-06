import SwiftUI

struct AppView: View {
    private enum ShellMode {
        case projects
        case project
    }

    @Environment(AppDependencies.self) private var dependencies
    /// Set only when the user explicitly navigates. Until then the shell is
    /// driven by the persisted project selection, so a returning user lands
    /// straight back in their last job instead of the directory.
    @State private var explicitMode: ShellMode?

    private var mode: ShellMode {
        if let explicitMode { return explicitMode }
        return dependencies.workspace.selectedProjectID != nil ? .project : .projects
    }

    var body: some View {
        Group {
            switch mode {
            case .project:
                ProjectContextShell(
                    onShowProjects: { explicitMode = .projects },
                    onOpenProject: openProject
                )
            case .projects:
                GlobalProjectsShell(onOpenProject: openProject)
            }
        }
        .onChange(of: dependencies.workspace.selectedProjectID) { _, newValue in
            if newValue == nil { explicitMode = .projects }
        }
    }

    private func openProject(_ projectID: String) {
        dependencies.workspace.selectProject(projectID)
        explicitMode = .project
    }
}

/// Resolves the persisted project id into a `MobileProject`. While the workspace
/// is still bootstrapping we stay in the project context (a spinner) rather than
/// flashing the directory; if the id is no longer valid we fall back to it.
private struct ProjectContextShell: View {
    @Environment(AppDependencies.self) private var dependencies
    let onShowProjects: () -> Void
    let onOpenProject: (String) -> Void

    var body: some View {
        if let project = dependencies.workspace.selectedProject {
            ProjectWorkspaceShell(
                project: project,
                onShowProjects: onShowProjects,
                onSelectProject: onOpenProject
            )
            .id(project.id)
        } else if dependencies.workspace.isLoading || dependencies.workspace.projects.isEmpty {
            ProgressView("Loading project…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemGroupedBackground))
        } else {
            Color(.systemGroupedBackground)
                .onAppear(perform: onShowProjects)
        }
    }
}

private struct GlobalProjectsShell: View {
    @Environment(AppDependencies.self) private var dependencies
    @State private var presentedSheet: SheetDestination?
    let onOpenProject: (String) -> Void

    var body: some View {
        NavigationStack {
            ProjectsView(onOpenProject: onOpenProject)
                .toolbar {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        SyncStatusIndicator()
                        ProfileToolbarButton { presentedSheet = .account }
                    }
                }
        }
        .sheet(item: $presentedSheet) { destination in
            switch destination {
            case .account: AccountView()
            case .newDailyLog: EmptyView() // only presented inside a project workspace
            }
        }
    }
}

private struct ProjectWorkspaceShell: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var selectedTab: AppTab = .overview
    @State private var tabRouter = TabRouter()
    @State private var switcher = ProjectSwitcherModel()

    let project: MobileProject
    let onShowProjects: () -> Void
    let onSelectProject: (String) -> Void

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                ProjectSidebarShell(
                    project: project,
                    selectedTab: $selectedTab,
                    tabRouter: tabRouter,
                    onShowProjects: onShowProjects,
                    onSelectProject: onSelectProject
                )
            } else {
                ProjectTabShell(
                    project: project,
                    selectedTab: $selectedTab,
                    tabRouter: tabRouter,
                    onShowProjects: onShowProjects
                )
                .projectSwitcher(
                    model: switcher,
                    currentProjectID: project.id,
                    onSelectProject: onSelectProject
                )
            }
        }
    }
}

private struct ProjectTabShell: View {
    let project: MobileProject
    @Binding var selectedTab: AppTab
    let tabRouter: TabRouter
    let onShowProjects: () -> Void

    var body: some View {
        TabView(selection: $selectedTab) {
            ForEach(AppTab.allCases) { tab in
                ProjectNavigationStack(
                    project: project,
                    tab: tab,
                    tabRouter: tabRouter
                )
                .tabItem { Label(tab.title, systemImage: tab.systemImage) }
                .tag(tab)
            }
        }
    }
}

private struct ProjectSidebarShell: View {
    let project: MobileProject
    @Binding var selectedTab: AppTab
    let tabRouter: TabRouter
    let onShowProjects: () -> Void
    let onSelectProject: (String) -> Void

    var body: some View {
        NavigationSplitView {
            List {
                Section {
                    ProjectPickerButton(project: project, onShowProjects: onShowProjects, onSelectProject: onSelectProject)
                }

                Section("Capture") {
                    Button {
                        tabRouter.router(for: selectedTab).presentedSheet = .newDailyLog(camera: false)
                    } label: {
                        Label("New Daily Log", systemImage: "square.and.pencil")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)

                    Button {
                        tabRouter.router(for: selectedTab).navigate(to: .scanReceipt)
                    } label: {
                        Label("Scan Receipt", systemImage: "doc.viewfinder")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                }

                Section("Project workspace") {
                    ForEach(AppTab.destinations) { tab in
                        Button {
                            selectedTab = tab
                        } label: {
                            Label(tab.title, systemImage: tab.systemImage)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(selectedTab == tab ? Color.accentColor.opacity(0.14) : Color.clear)
                        .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
                    }
                }

                Section {
                    Button(action: onShowProjects) {
                        Label("All Projects", systemImage: "arrow.left")
                    }
                }
            }
            .navigationTitle("Arc")
        } detail: {
            ProjectNavigationStack(
                project: project,
                tab: selectedTab,
                tabRouter: tabRouter,
                enablesPullToSwitch: false
            )
        }
    }
}

private struct ProjectNavigationStack: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(ProjectSwitcherModel.self) private var switcher: ProjectSwitcherModel?

    let project: MobileProject
    let tab: AppTab
    let tabRouter: TabRouter
    var enablesPullToSwitch = true

    /// Fades the nav title out as the switcher pull is dragged down.
    private var titleOpacity: Double {
        guard enablesPullToSwitch, let switcher else { return 1 }
        return 1 - Double(min(1, switcher.pullProgress * 1.5))
    }

    private var router: AppRouter { tabRouter.router(for: tab) }

    var body: some View {
        NavigationStack(path: tabRouter.binding(for: tab)) {
            tab.rootView(project: project)
                .environment(\.projectSwitcherPullEnabled, enablesPullToSwitch)
                .toolbar {
                    if enablesPullToSwitch {
                        ToolbarItem(placement: .principal) {
                            Text(tab.title)
                                .font(.headline)
                                .opacity(titleOpacity)
                        }
                    }
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        SyncStatusIndicator()
                        ProfileToolbarButton { router.presentedSheet = .account }
                    }
                }
                .navigationDestination(for: AppRoute.self) { route in
                    switch route {
                    case .schedule: ProjectScheduleView(project: project)
                    case .tasks: ProjectTasksView(project: project)
                    case .punch: ProjectPunchView(project: project)
                    case .rfis: ProjectRfisView(project: project)
                    case .team: ProjectTeamView(project: project)
                    case .expenses: ProjectExpensesView(project: project)
                    case .projectDetails: ProjectDetailView(projectID: project.id)
                    case .dailyLog(let id): DailyLogDetailView(project: project, logID: id)
                    case .scanReceipt: ReceiptCaptureView(project: project)
                    case .drawingSheet(let id): DrawingSheetViewerView(project: project, sheetID: id)
                    }
                }
        }
        .environment(router)
        .sheet(item: Binding(
            get: { router.presentedSheet },
            set: { router.presentedSheet = $0 }
        )) { destination in
            switch destination {
            case .account: AccountView()
            case .newDailyLog(let camera): DailyLogComposerView(project: project, autoOpensCamera: camera)
            }
        }
    }
}

private struct ProjectPickerButton: View {
    private enum Presentation: String, Identifiable {
        case picker
        var id: Self { self }
    }

    @State private var presentation: Presentation?
    let project: MobileProject
    let onShowProjects: () -> Void
    let onSelectProject: (String) -> Void

    var body: some View {
        Button {
            presentation = .picker
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "building.2.fill")
                    .foregroundStyle(.tint)
                Text(project.name)
                    .fontWeight(.semibold)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
            }
        }
        .accessibilityIdentifier("project-switcher")
        .sheet(item: $presentation) { _ in
            ProjectPickerView(
                currentProjectID: project.id,
                onShowProjects: {
                    presentation = nil
                    onShowProjects()
                },
                onSelectProject: { projectID in
                    presentation = nil
                    onSelectProject(projectID)
                }
            )
        }
    }
}

private struct ProjectPickerView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    let currentProjectID: String
    let onShowProjects: () -> Void
    let onSelectProject: (String) -> Void

    private var filteredProjects: [MobileProject] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return dependencies.workspace.projects }
        return dependencies.workspace.projects.filter { $0.name.localizedCaseInsensitiveContains(term) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button(action: onShowProjects) {
                        Label("All Projects", systemImage: "square.grid.2x2")
                    }
                }

                Section("Switch project") {
                    ForEach(filteredProjects) { project in
                        Button {
                            onSelectProject(project.id)
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "building.2")
                                    .frame(width: 28, height: 28)
                                    .background(.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(project.name).foregroundStyle(.primary)
                                    Text(project.status.replacingOccurrences(of: "_", with: " ").capitalized)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if project.id == currentProjectID {
                                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
                                }
                            }
                        }
                    }
                }
            }
            .searchable(text: $query, prompt: "Find a project")
            .navigationTitle("Projects")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

struct SyncStatusIndicator: View {
    @Environment(AppDependencies.self) private var dependencies

    var body: some View {
        let engine = dependencies.syncEngine
        switch engine.status {
        case .syncing:
            HStack(spacing: 4) {
                ProgressView().controlSize(.small)
            }
            .accessibilityLabel("Syncing")
        case .offline:
            badge(systemImage: "wifi.slash", tint: .secondary, count: engine.pendingMutationCount)
                .accessibilityLabel("Offline\(engine.pendingMutationCount > 0 ? ", \(engine.pendingMutationCount) queued" : "")")
        case .failed:
            badge(systemImage: "exclamationmark.triangle.fill", tint: .red, count: engine.pendingMutationCount)
                .accessibilityLabel("Sync needs attention")
        case .idle:
            if engine.pendingMutationCount > 0 {
                badge(systemImage: "clock.arrow.circlepath", tint: .orange, count: engine.pendingMutationCount)
                    .accessibilityLabel("\(engine.pendingMutationCount) changes pending sync")
            }
        }
    }

    private func badge(systemImage: String, tint: Color, count: Int) -> some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage).foregroundStyle(tint)
            if count > 0 {
                Text("\(count)").font(.caption2.weight(.semibold)).foregroundStyle(tint)
            }
        }
    }
}

/// Single account/profile entry point in the top-right of every shell. Opens
/// the account sheet (profile, organization, platform tools). In-app
/// notifications are intentionally omitted — the app relies on iOS push.
struct ProfileToolbarButton: View {
    @Environment(AppDependencies.self) private var dependencies
    let action: () -> Void

    private var initials: String {
        let source = dependencies.session.user?.email ?? "A"
        return String(source.prefix(1)).uppercased()
    }

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().fill(BrandTheme.buttonGradient)
                Text(initials)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 28, height: 28)
        }
        .accessibilityIdentifier("account-button")
        .accessibilityLabel("Account and settings")
    }
}

#Preview("iPhone") {
    AppView().environment(AppDependencies())
}
