import SwiftUI

struct ProjectTeamView: View {
    @Environment(AppDependencies.self) private var dependencies
    let project: MobileProject

    private var store: ProjectInfoStore { dependencies.projectInfo }
    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }

    var body: some View {
        List {
            if store.isLoadingTeam && store.team.isEmpty {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            } else if let message = store.teamError, store.team.isEmpty {
                ContentUnavailableView {
                    Label("Team unavailable", systemImage: "person.2.slash")
                } description: { Text(message) }
            } else if store.team.isEmpty {
                ContentUnavailableView(
                    "No team members",
                    systemImage: "person.2",
                    description: Text("People assigned to this project will appear here.")
                )
            } else {
                Section("\(store.team.count) members") {
                    ForEach(store.team) { member in TeamRow(member: member) }
                }
            }
        }
        .navigationTitle("Team")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load(force: true) }
        .task { await load(force: false) }
    }

    private func load(force: Bool) async {
        guard let organizationID else { return }
        await store.loadTeam(projectID: project.id, organizationID: organizationID, force: force)
    }
}

private struct TeamRow: View {
    let member: MobileTeamMember

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(BrandTheme.midBlue.opacity(0.15)).frame(width: 40, height: 40)
                if let url = member.avatarUrl {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Text(member.initials).font(.subheadline.weight(.semibold)).foregroundStyle(BrandTheme.midBlue)
                    }
                    .frame(width: 40, height: 40)
                    .clipShape(Circle())
                } else {
                    Text(member.initials).font(.subheadline.weight(.semibold)).foregroundStyle(BrandTheme.midBlue)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(member.name).font(.headline)
                if let role = member.role, !role.isEmpty {
                    Text(role).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let email = member.email, let url = URL(string: "mailto:\(email)") {
                Link(destination: url) {
                    Image(systemName: "envelope").foregroundStyle(.tint)
                }
            }
        }
        .padding(.vertical, 4)
    }
}
