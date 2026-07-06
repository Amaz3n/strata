import Foundation
import Observation

@MainActor
@Observable
final class ScheduleStore {
    private let api: MobileAPIService

    private(set) var items: [MobileScheduleItem] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var loadedProjectID: String?

    init(api: MobileAPIService) {
        self.api = api
    }

    func load(projectID: String, organizationID: String, force: Bool = false) async {
        guard force || loadedProjectID != projectID else { return }
        loadedProjectID = projectID
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil
        do {
            items = try await api.loadSchedule(projectID: projectID, organizationID: organizationID)
        } catch is CancellationError {
            return
        } catch {
            if items.isEmpty {
                errorMessage = (error as? APIError)?.userMessage ?? "The schedule could not be loaded."
            }
        }
    }

    func refresh(projectID: String, organizationID: String) async {
        await load(projectID: projectID, organizationID: organizationID, force: true)
    }

    /// Items active or starting within the next `days` window, for the project dashboard.
    func upcoming(days: Int = 7) -> [MobileScheduleItem] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: .now)
        guard let horizon = calendar.date(byAdding: .day, value: days, to: today) else { return [] }
        return items.filter { item in
            if item.isComplete { return false }
            if item.statusGroup == .inProgress { return true }
            guard let start = item.startDateValue else { return false }
            return start <= horizon
        }
    }
}

enum ScheduleStatusGroup: String, CaseIterable, Identifiable {
    case overdue
    case inProgress
    case upcoming
    case completed

    var id: String { rawValue }

    var title: String {
        switch self {
        case .overdue: "Overdue"
        case .inProgress: "In progress"
        case .upcoming: "Upcoming"
        case .completed: "Completed"
        }
    }

    var systemImage: String {
        switch self {
        case .overdue: "exclamationmark.triangle.fill"
        case .inProgress: "hammer.fill"
        case .upcoming: "calendar"
        case .completed: "checkmark.circle.fill"
        }
    }
}

extension MobileScheduleItem {
    var isComplete: Bool {
        status == "completed" || status == "cancelled" || progress >= 100
    }

    var startDateValue: Date? { MobileDateParser.dateOnly(startDate) }
    var endDateValue: Date? { MobileDateParser.dateOnly(endDate) }

    var statusGroup: ScheduleStatusGroup {
        if status == "completed" || progress >= 100 { return .completed }
        let today = Calendar.current.startOfDay(for: .now)
        if let end = endDateValue, end < today, status != "cancelled" { return .overdue }
        if status == "in_progress" || status == "at_risk" || (progress > 0 && progress < 100) { return .inProgress }
        return .upcoming
    }

    var dateRangeText: String? {
        let formatter = MobileDateParser.shortFormatter
        switch (startDateValue, endDateValue) {
        case let (start?, end?):
            if Calendar.current.isDate(start, inSameDayAs: end) { return formatter.string(from: start) }
            return "\(formatter.string(from: start)) – \(formatter.string(from: end))"
        case let (start?, nil): return formatter.string(from: start)
        case let (nil, end?): return "Due \(formatter.string(from: end))"
        default: return nil
        }
    }
}

enum MobileDateParser {
    static let shortFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    private static let dateOnlyFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func dateOnly(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        return dateOnlyFormatter.date(from: String(value.prefix(10)))
    }

    static func display(_ value: String?) -> String? {
        guard let date = dateOnly(value) else { return nil }
        return shortFormatter.string(from: date)
    }
}
