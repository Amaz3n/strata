import SwiftUI

struct ProjectsView: View {
    @Environment(AppDependencies.self) private var dependencies
    @State private var query = ""
    let onOpenProject: (String) -> Void

    private var filteredProjects: [MobileProject] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return dependencies.workspace.projects }
        return dependencies.workspace.projects.filter {
            $0.name.localizedCaseInsensitiveContains(term) ||
            ($0.address?.localizedCaseInsensitiveContains(term) ?? false)
        }
    }

    var body: some View {
        Group {
            if dependencies.workspace.isLoading {
                ProgressView("Loading projects…")
            } else if let error = dependencies.workspace.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't load projects", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try Again") {
                        Task { await dependencies.workspace.bootstrap() }
                    }
                    .buttonStyle(.borderedProminent)
                }
            } else if dependencies.workspace.projects.isEmpty {
                ContentUnavailableView(
                    "No projects available",
                    systemImage: "building.2",
                    description: Text("Projects assigned to you will appear here.")
                )
            } else {
                List {
                    if let current = dependencies.workspace.selectedProject {
                        Section("Continue working") {
                            ProjectRow(project: current, showsContinue: true) {
                                onOpenProject(current.id)
                            }
                        }
                    }

                    Section("All projects") {
                        ForEach(filteredProjects) { project in
                            ProjectRow(project: project) {
                                onOpenProject(project.id)
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
        .searchable(text: $query, prompt: "Search projects")
        .navigationTitle("Projects")
        .toolbar {
            if !dependencies.workspace.organizations.isEmpty {
                ToolbarItem(placement: .topBarLeading) {
                    Menu(dependencies.workspace.selectedOrganization?.name ?? "Organization") {
                        ForEach(dependencies.workspace.organizations) { organization in
                            Button {
                                Task { await dependencies.workspace.selectOrganization(organization.id) }
                            } label: {
                                if organization.id == dependencies.workspace.selectedOrganizationID {
                                    Label(organization.name, systemImage: "checkmark")
                                } else {
                                    Text(organization.name)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private struct ProjectRow: View {
    let project: MobileProject
    var showsContinue = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: "building.2.fill")
                    .font(.title3)
                    .foregroundStyle(.tint)
                    .frame(width: 42, height: 42)
                    .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 4) {
                    Text(project.name)
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Text([project.status.replacingOccurrences(of: "_", with: " ").capitalized, project.address]
                        .compactMap { $0 }
                        .joined(separator: " · "))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Image(systemName: showsContinue ? "arrow.right.circle.fill" : "chevron.right")
                    .foregroundStyle(showsContinue ? Color.accentColor : Color.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("project-\(project.id)")
    }
}

struct ProjectDetailView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(AppRouter.self) private var router
    let projectID: String

    private var info: ProjectInfoStore { dependencies.projectInfo }
    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }

    var body: some View {
        if let project = dependencies.workspace.projects.first(where: { $0.id == projectID }) {
            List {
                Section("Project") {
                    LabeledContent("Status") { StatusBadge(status: project.status) }
                    if let address = project.address { LabeledContent("Address", value: address) }
                    if let startDate = project.startDate { LabeledContent("Start", value: startDate) }
                    if let endDate = project.endDate { LabeledContent("Completion", value: endDate) }
                }

                Section {
                    if info.team.isEmpty {
                        Text(info.isLoadingTeam ? "Loading team…" : "No team members yet.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(info.team.prefix(5)) { member in
                            HStack(spacing: 10) {
                                Image(systemName: "person.circle.fill").foregroundStyle(.tint)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(member.name)
                                    if let role = member.role { Text(role).font(.caption).foregroundStyle(.secondary) }
                                }
                            }
                        }
                        if info.team.count > 5 {
                            Button("View all \(info.team.count) members") { router.navigate(to: .team) }
                        }
                    }
                } header: {
                    Text("Team")
                }

                Section {
                    Button { router.navigate(to: .rfis) } label: {
                        NavigationRow(title: "RFIs", systemImage: "questionmark.bubble", badge: info.openRfiCount)
                    }
                    Button { router.navigate(to: .schedule) } label: {
                        NavigationRow(title: "Schedule", systemImage: "calendar")
                    }
                }
                .buttonStyle(.plain)
            }
            .navigationTitle("Project Details")
            .task {
                guard let organizationID else { return }
                await info.loadTeam(projectID: projectID, organizationID: organizationID)
                await info.loadRfis(projectID: projectID, organizationID: organizationID)
            }
        } else {
            ContentUnavailableView("Project unavailable", systemImage: "exclamationmark.triangle")
        }
    }
}
