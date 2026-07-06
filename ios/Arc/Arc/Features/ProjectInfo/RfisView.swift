import SwiftUI

struct ProjectRfisView: View {
    @Environment(AppDependencies.self) private var dependencies
    let project: MobileProject

    private var store: ProjectInfoStore { dependencies.projectInfo }
    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }

    private var openRfis: [MobileRfi] { store.rfis.filter(\.isOpen) }
    private var resolvedRfis: [MobileRfi] { store.rfis.filter { !$0.isOpen } }

    var body: some View {
        List {
            if store.isLoadingRfis && store.rfis.isEmpty {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            } else if let message = store.rfisError, store.rfis.isEmpty {
                ContentUnavailableView {
                    Label("RFIs unavailable", systemImage: "questionmark.bubble")
                } description: { Text(message) }
            } else if store.rfis.isEmpty {
                ContentUnavailableView(
                    "No RFIs",
                    systemImage: "questionmark.bubble",
                    description: Text("Requests for information on this project will appear here.")
                )
            } else {
                if !openRfis.isEmpty {
                    Section("Open (\(openRfis.count))") {
                        ForEach(openRfis) { rfi in RfiRow(rfi: rfi) }
                    }
                }
                if !resolvedRfis.isEmpty {
                    Section("Answered & closed (\(resolvedRfis.count))") {
                        ForEach(resolvedRfis) { rfi in RfiRow(rfi: rfi) }
                    }
                }
            }
        }
        .navigationTitle("RFIs")
        .navigationBarTitleDisplayMode(.inline)
        .projectSwitcherPullOrRefresh { await load(force: true) }
        .task { await load(force: false) }
    }

    private func load(force: Bool) async {
        guard let organizationID else { return }
        await store.loadRfis(projectID: project.id, organizationID: organizationID, force: force)
    }
}

private struct RfiRow: View {
    let rfi: MobileRfi

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("#\(rfi.rfiNumber)")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
                Text(rfi.subject)
                    .font(.headline)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let question = rfi.question, !question.isEmpty {
                Text(question).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack(spacing: 8) {
                StatusBadge(status: rfi.status)
                if let priority = rfi.priority, !priority.isEmpty {
                    StatusBadge(text: priority.capitalized, tint: ArcStatusColor.severity(priority))
                }
                if let assignee = rfi.assigneeName {
                    Label(assignee, systemImage: "person").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                if let due = rfi.dueDateText {
                    Label(due, systemImage: "calendar").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}
