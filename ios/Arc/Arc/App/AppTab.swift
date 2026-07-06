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

    var id: Self { self }

    static var destinations: [AppTab] { allCases }

    var title: String {
        switch self {
        case .overview: "Overview"
        case .logs: "Logs"
        case .work: "Work"
        case .library: "Library"
        }
    }

    var systemImage: String {
        switch self {
        case .overview: "square.grid.2x2"
        case .logs: "book.pages"
        case .work: "checklist"
        case .library: "folder"
        }
    }

    @ViewBuilder
    func rootView(project: MobileProject) -> some View {
        switch self {
        case .overview: ProjectDashboardView(project: project)
        case .logs: ProjectDailyLogsView(project: project)
        case .work: ProjectWorkView(project: project)
        case .library: ProjectLibraryView(project: project)
        }
    }
}
