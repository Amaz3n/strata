import Foundation

// MARK: - My Houses

/// One assigned house (a production project — a house on a lot) from
/// `GET /my-houses`. The route is org-scoped, never project-scoped: a
/// superintendent running fifteen lots asks for all of them at once.
struct MobileMyHouse: Codable, Equatable, Identifiable, Sendable {
    var id: String { projectId }

    let projectId: String
    let lotLabel: String
    let communityId: String
    let communityName: String
    let planCode: String?
    let elevationCode: String?
    let startDate: String?
    let targetDays: Int?
    let daysInProgress: Int
    let percentComplete: Int
    let currentPhase: String?
    let lateCount: Int
    let openPunch: Int
    let openTasks: Int
    let lastDailyLogDate: String?
}

/// `GET /my-houses/work?window=…` groups the window's schedule items by
/// activity, not by house — the job is one activity across many lots.
struct MobileMyHouseWorkGroup: Codable, Equatable, Identifiable, Sendable {
    var id: String { groupKey }

    let groupKey: String
    let groupLabel: String
    let items: [MobileMyHouseWorkItem]
}

struct MobileMyHouseWorkItem: Codable, Equatable, Identifiable, Sendable {
    var id: String { scheduleItemId }

    let scheduleItemId: String
    let projectId: String
    let lotLabel: String
    let communityName: String
    let name: String
    let trade: String?
    let status: String
    let startDate: String?
    let endDate: String?
    let daysLate: Int
}

/// `POST /my-houses/schedule-items/{id}/complete` response.
struct MobileMyHouseCompletion: Codable, Equatable, Sendable {
    let completed: Bool
    let progress: Int
}

struct CompleteScheduleItemRequest: Encodable, Sendable {
    let progress: Int
}

/// The window the work feed is asked for. Raw values are the only three the
/// server accepts (`lib/mobile/my-houses.ts`); anything else is a 400.
enum MyHouseWorkWindow: String, CaseIterable, Identifiable, Sendable {
    case today
    case week
    case twoweek

    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: "Today"
        case .week: "This week"
        case .twoweek: "2 weeks"
        }
    }
}

// MARK: - Variance purchase orders

/// A variance reason from `GET /organizations/{orgId}/reason-codes`. Only
/// active codes are returned, already ordered by `sort_order` then label.
struct MobileVarianceReasonCode: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let code: String
    let label: String
    let description: String?
    let isBackcharge: Bool
    let sortOrder: Int
}

/// A variance purchase order — a `commitment_change_orders` row carrying a
/// variance reason code.
///
/// `GET /projects/{id}/vpos` embeds the commitment, company, and reason; the
/// `POST` response is a bare `select("*")` of the inserted row, so every
/// embedded relation is optional and callers must not depend on it.
struct MobileVarianceOrder: Codable, Equatable, Identifiable, Sendable {
    struct Commitment: Codable, Equatable, Sendable {
        let title: String?
    }

    struct Company: Codable, Equatable, Sendable {
        let name: String?
    }

    struct Reason: Codable, Equatable, Sendable {
        let code: String?
        let label: String?
        let isBackcharge: Bool?
    }

    let id: String
    let projectId: String
    let commitmentId: String
    let title: String
    let description: String?
    let status: String
    let totalCents: Int
    let reasonCodeId: String?
    let origin: String?
    let photoFileIds: [String]
    let createdAt: Date
    let commitment: Commitment?
    let company: Company?
    let reason: Reason?
}

/// Request body for `POST /projects/{id}/vpos`. Mirrors `mobileVpoSchema`
/// exactly — the server rejects a zero amount, a non-purchase-order
/// commitment, an inactive reason, and a positive amount on a backcharge.
struct CreateVarianceOrderRequest: Encodable, Sendable {
    let commitmentId: String
    let reasonCodeId: String
    let amountCents: Int
    let note: String
    let photoFileIds: [String]
    let clientId: String
}

/// A purchase order a variance can be charged to. The mobile API has no
/// purchase-order listing route, so these are recovered from the commitments
/// already referenced by this house's variance history.
struct MobileVarianceCommitment: Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let companyName: String?
}

extension MobileVarianceReasonCode {
    /// Backcharges bill the trade, so the server requires a negative amount.
    func signedAmountCents(fromPositive amountCents: Int) -> Int {
        isBackcharge ? -amountCents : amountCents
    }
}

extension MobileVarianceOrder {
    var amountText: String { CurrencyFormat.string(cents: totalCents) }
    var isBackcharge: Bool { totalCents < 0 }
    var purchaseOrderTitle: String? { commitment?.title }
    var reasonLabel: String? { reason?.label }
}

extension MobileDateParser {
    private static let dayKeyFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// Today in the same `yyyy-MM-dd` form the API returns date-only fields in.
    static var todayKey: String { dayKeyFormatter.string(from: .now) }
}

extension MobileMyHouse {
    var planText: String? {
        switch (planCode, elevationCode) {
        case let (plan?, elevation?): "\(plan) · \(elevation)"
        case let (plan?, nil): plan
        case let (nil, elevation?): elevation
        default: nil
        }
    }

    /// Positive when the house has run past its scheduled duration.
    var daysVersusTarget: Int? {
        guard let targetDays else { return nil }
        return daysInProgress - targetDays
    }

    var phaseLabel: String? {
        guard let currentPhase, !currentPhase.isEmpty else { return nil }
        return currentPhase.replacingOccurrences(of: "_", with: " ").capitalized
    }

    var lastLogText: String {
        guard let lastDailyLogDate, !lastDailyLogDate.isEmpty else { return "No logs" }
        guard let date = MobileDateParser.dateOnly(lastDailyLogDate) else { return lastDailyLogDate }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Logged today" }
        if calendar.isDateInYesterday(date) { return "Logged yesterday" }
        return "Logged \(MobileDateParser.shortFormatter.string(from: date))"
    }

    func hasLog(on dayKey: String) -> Bool {
        lastDailyLogDate?.hasPrefix(dayKey) == true
    }
}

extension MobileMyHouseWorkItem {
    var lotText: String { "\(lotLabel) · \(communityName)" }

    var dateRangeText: String? {
        let formatter = MobileDateParser.shortFormatter
        switch (MobileDateParser.dateOnly(startDate), MobileDateParser.dateOnly(endDate)) {
        case let (start?, end?):
            if Calendar.current.isDate(start, inSameDayAs: end) { return formatter.string(from: start) }
            return "\(formatter.string(from: start)) – \(formatter.string(from: end))"
        case let (start?, nil): return formatter.string(from: start)
        case let (nil, end?): return "Due \(formatter.string(from: end))"
        default: return nil
        }
    }
}
