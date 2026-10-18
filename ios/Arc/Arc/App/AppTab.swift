import SwiftUI

/// Project-workspace destinations, ordered by how often a hand on a jobsite
/// reaches for them. Capture is not a tab — creating a log or scanning a
/// receipt starts from within the surfaces themselves (the Logs capture bar,
/// the Overview capture cards), so every tab is a real place.
enum AppTab: String, CaseIterable, Hashable, Identifiable {
    case overview
    case logs
    case work
    case library
    case schedule, tasks, punch, rfis, drawings, documents, contacts, expenses, photos

    var id: Self { self }

    static let phoneTabs: [AppTab] = [.overview, .logs, .work, .library]
    static let destinations: [AppTab] = [.overview, .logs, .schedule, .tasks, .punch, .rfis, .drawings, .documents, .contacts, .expenses, .photos]

    var title: String {
        switch self {
        case .overview: "Overview"
        case .logs: "Logs"
        case .work: "Work"
        case .library: "Library"
        case .schedule: "Schedule"
        case .tasks: "Tasks"
        case .punch: "Punch"
        case .rfis: "RFIs"
        case .drawings: "Drawings"
        case .documents: "Documents"
        case .contacts: "Contacts"
        case .expenses: "Receipts & Expenses"
        case .photos: "Photos"
        }
    }

    var systemImage: String {
        switch self {
        case .overview: "square.grid.2x2"
        case .logs: "book.pages"
        case .work: "checklist"
        case .library: "folder"
        case .schedule: "calendar"
        case .tasks: "checklist"
        case .punch: "exclamationmark.bubble"
        case .rfis: "questionmark.bubble"
        case .drawings: "map"
        case .documents: "doc"
        case .contacts: "person.2"
        case .expenses: "receipt"
        case .photos: "photo.on.rectangle"
        }
    }

    @ViewBuilder
    func rootView(project: MobileProject) -> some View {
        switch self {
        case .overview: ProjectDashboardView(project: project)
        case .logs: ProjectDailyLogsView(project: project)
        case .work: ProjectWorkView(project: project)
        case .library: ProjectLibraryView(project: project)
        case .schedule: ProjectScheduleView(project: project)
        case .tasks: ProjectTasksView(project: project)
        case .punch: ProjectPunchView(project: project)
        case .rfis: ProjectRfisView(project: project)
        case .drawings: ProjectDrawingsView(project: project)
        case .documents: ProjectDocumentsView(project: project)
        case .contacts: ProjectTeamView(project: project)
        case .expenses: ProjectExpensesView(project: project)
        case .photos: ProjectPhotosView(project: project)
        }
    }
}
