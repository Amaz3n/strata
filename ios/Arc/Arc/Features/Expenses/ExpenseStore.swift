import Foundation
import Observation

@MainActor
@Observable
final class ExpenseStore {
    private let api: MobileAPIService

    private(set) var expenses: [MobileExpense] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var loadedProjectID: String?

    init(api: MobileAPIService) {
        self.api = api
    }

    var totalCents: Int { expenses.reduce(0) { $0 + $1.amountCents } }

    func load(projectID: String, organizationID: String, force: Bool = false) async {
        guard force || loadedProjectID != projectID else { return }
        loadedProjectID = projectID
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil
        do {
            expenses = try await api.loadExpenses(projectID: projectID, organizationID: organizationID)
        } catch is CancellationError {
            return
        } catch {
            if expenses.isEmpty {
                errorMessage = (error as? APIError)?.userMessage ?? "Expenses could not be loaded."
            }
        }
    }

    func refresh(projectID: String, organizationID: String) async {
        await load(projectID: projectID, organizationID: organizationID, force: true)
    }

    func scan(receiptURL: URL, projectID: String, organizationID: String) async throws -> MobileReceiptScan {
        try await api.scanReceipt(
            fileURL: receiptURL,
            fileName: receiptURL.lastPathComponent,
            mimeType: "image/jpeg",
            projectID: projectID,
            organizationID: organizationID
        )
    }

    @discardableResult
    func create(
        _ payload: CreateExpensePayload,
        receiptURL: URL?,
        projectID: String,
        organizationID: String
    ) async throws -> MobileExpense {
        let created = try await api.createExpense(
            payload,
            receiptURL: receiptURL,
            receiptFileName: receiptURL?.lastPathComponent,
            receiptMimeType: "image/jpeg",
            projectID: projectID,
            organizationID: organizationID
        )
        expenses.insert(created, at: 0)
        return created
    }
}

extension MobileExpense {
    var amountText: String { CurrencyFormat.string(cents: amountCents) }
    var expenseDateText: String? { MobileDateParser.display(expenseDate) }
    var statusLabel: String { status.replacingOccurrences(of: "_", with: " ").capitalized }
}

enum CurrencyFormat {
    private static let formatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter
    }()

    static func string(cents: Int) -> String {
        formatter.string(from: NSNumber(value: Double(cents) / 100)) ?? "$0.00"
    }
}
