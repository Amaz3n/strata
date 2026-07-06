import SwiftUI

/// "Work" consolidates the three actionable item lists that share one mental
/// model — open things on this job you close out — behind a single segmented
/// control, replacing three buried rows in the old More drawer.
struct ProjectWorkView: View {
    private enum Segment: String, CaseIterable, Identifiable {
        case tasks = "Tasks"
        case punch = "Punch"
        case rfis = "RFIs"
        var id: Self { self }
    }

    @Environment(AppDependencies.self) private var dependencies
    @State private var segment: Segment = .tasks
    let project: MobileProject

    var body: some View {
        VStack(spacing: 0) {
            Picker("Work", selection: $segment.animation(.easeInOut(duration: 0.2))) {
                ForEach(Segment.allCases) { segment in
                    Text(label(for: segment)).tag(segment)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(.bar)

            Divider()

            switch segment {
            case .tasks: ProjectTasksView(project: project)
            case .punch: ProjectPunchView(project: project)
            case .rfis: ProjectRfisView(project: project)
            }
        }
        .navigationTitle("Work")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard let organizationID = dependencies.workspace.selectedOrganizationID else { return }
            await dependencies.field.load(projectID: project.id, organizationID: organizationID)
            await dependencies.projectInfo.loadRfis(projectID: project.id, organizationID: organizationID)
        }
    }

    /// Segment labels carry their open counts so crews see outstanding work
    /// without switching segments.
    private func label(for segment: Segment) -> String {
        switch segment {
        case .tasks:
            let count = dependencies.field.openTaskCount
            return count > 0 ? "Tasks (\(count))" : "Tasks"
        case .punch:
            let count = dependencies.field.openPunchCount
            return count > 0 ? "Punch (\(count))" : "Punch"
        case .rfis:
            let count = dependencies.projectInfo.openRfiCount
            return count > 0 ? "RFIs (\(count))" : "RFIs"
        }
    }
}
