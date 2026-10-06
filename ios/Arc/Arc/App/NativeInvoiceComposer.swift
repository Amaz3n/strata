import SwiftUI

struct NativeInvoiceInput: Codable, Sendable {
    struct Line: Codable, Sendable {
        var id: String? = nil
        let description: String
        let quantity: Double
        let unit: String
        let unitCost: Double
        let taxable: Bool
    }
    let projectId: String
    let invoiceNumber: String
    let title: String
    let issueDate: String
    let dueDate: String
    let notes: String
    let taxRate: Double
    let lines: [Line]
}

struct NativeInvoiceLineDraft: Identifiable, Equatable {
    let id = UUID()
    var sourceID: String?
    var description = ""
    var quantity = "1"
    var unit = "unit"
    var unitPrice = ""
    var taxable = true

    static func number(_ text: String) -> Double? {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: Locale.current.decimalSeparator ?? ".", with: ".")
        guard let value = Double(normalized), value.isFinite else { return nil }
        return value
    }
    var input: NativeInvoiceInput.Line? {
        guard !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let quantityValue = Self.number(quantity), quantityValue >= 0.01, quantityValue <= 1_000_000,
              let priceValue = Self.number(unitPrice), priceValue >= 0, priceValue <= 100_000_000,
              abs(priceValue * 100 - (priceValue * 100).rounded()) < 0.00001 else { return nil }
        return .init(id: sourceID, description: description.trimmingCharacters(in: .whitespacesAndNewlines), quantity: quantityValue,
                     unit: unit.isEmpty ? "unit" : unit, unitCost: priceValue, taxable: taxable)
    }
    var subtotalCents: Int? {
        guard let input else { return nil }
        return Int((input.quantity * (input.unitCost * 100).rounded()).rounded())
    }
}

struct NativeInvoiceDraftSnapshot: Decodable, Sendable {
    let revision: String
    let input: NativeInvoiceInput
}

struct NativeInvoiceComposer: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss
    let projectID: String
    var invoiceID: String? = nil
    let onSaved: () -> Void
    @State private var invoiceNumber = ""
    @State private var title = ""
    @State private var issueDate = Date.now
    @State private var dueDate = Calendar.current.date(byAdding: .day, value: 30, to: .now) ?? .now
    @State private var taxRate = "0"
    @State private var notes = ""
    @State private var lines = [NativeInvoiceLineDraft()]
    @State private var revision: String?
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var confirmDiscard = false

    private var hasDraft: Bool {
        !invoiceNumber.isEmpty || !title.isEmpty || !notes.isEmpty || taxRate != "0" || lines.count > 1 || lines.contains { !$0.description.isEmpty || !$0.unitPrice.isEmpty }
    }
    private var canSave: Bool {
        !isSaving && !isLoading && (invoiceID == nil || revision != nil) && !invoiceNumber.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && title.trimmingCharacters(in: .whitespacesAndNewlines).count >= 3 && !lines.isEmpty && lines.allSatisfy { $0.input != nil } && validTax != nil && Calendar.current.startOfDay(for: dueDate) >= Calendar.current.startOfDay(for: issueDate)
    }
    private var validTax: Double? {
        guard let value = NativeInvoiceLineDraft.number(taxRate), (0...20).contains(value) else { return nil }
        return value
    }
    var body: some View {
        NavigationStack {
            Form {
                if isLoading { ProgressView("Loading draft…") }
                if invoiceID != nil && revision == nil && !isLoading {
                    Button("Reload Draft") { Task { await loadDraft() } }
                }
                Section("Invoice") {
                    TextField("Invoice number", text: $invoiceNumber)
                    TextField("Title", text: $title)
                    DatePicker("Issue date", selection: $issueDate, displayedComponents: .date)
                    DatePicker("Due date", selection: $dueDate, displayedComponents: .date)
                }
                ForEach($lines) { $line in
                    Section {
                        TextField("Description", text: $line.description, axis: .vertical).lineLimit(2...5)
                        HStack {
                            TextField("Quantity", text: $line.quantity).keyboardType(.decimalPad).accessibilityLabel("Quantity")
                            TextField("Unit", text: $line.unit).accessibilityLabel("Unit")
                        }
                        TextField("Unit price", text: $line.unitPrice).keyboardType(.decimalPad).accessibilityLabel("Unit price in dollars")
                        Toggle("Taxable", isOn: $line.taxable)
                        if let cents = line.subtotalCents { LabeledContent("Line amount", value: CurrencyFormat.string(cents: cents)) }
                        Button("Remove Line", role: .destructive) { lines.removeAll { $0.id == line.id } }.disabled(lines.count == 1 || isSaving)
                    } header: { Text("Line Item") }
                }
                Section {
                    Button("Add Line", systemImage: "plus") { lines.append(NativeInvoiceLineDraft()) }.disabled(lines.count >= 100 || isSaving)
                    if lines.allSatisfy({ $0.input != nil }) {
                        LabeledContent("Subtotal before tax", value: CurrencyFormat.string(cents: lines.compactMap(\.subtotalCents).reduce(0, +)))
                    }
                    TextField("Tax rate (%)", text: $taxRate).keyboardType(.decimalPad).accessibilityLabel("Tax rate percent")
                    TextField("Notes", text: $notes, axis: .vertical).lineLimit(3...8)
                } footer: {
                    Text("Saves a draft for this project. Arc calculates the final tax and totals. Prices use up to two decimal places.")
                }
                if let errorMessage { Section { Text(errorMessage).foregroundStyle(.red) } }
            }
            .disabled(isSaving || isLoading)
            .navigationTitle(invoiceID == nil ? "New Invoice Draft" : "Edit Invoice Draft")
            .task(id: invoiceID) { await loadDraft() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { if hasDraft { confirmDiscard = true } else { dismiss() } }.disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save Draft") { Task { await save() } }.disabled(!canSave)
                }
            }
            .onChange(of: dependencies.workspace.selectedOrganizationID) { _, _ in dismiss() }
            .interactiveDismissDisabled(isSaving || hasDraft)
            .confirmationDialog("Discard this invoice draft?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard Draft", role: .destructive) { dismiss() }
                Button("Keep Editing", role: .cancel) {}
            }
        }
    }
    private func loadDraft() async {
        guard let invoiceID, let organizationID = dependencies.workspace.selectedOrganizationID else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let snapshot = try await dependencies.mobileAPI.loadInvoiceDraft(invoiceID: invoiceID, projectID: projectID, organizationID: organizationID)
            guard !Task.isCancelled, dependencies.workspace.selectedOrganizationID == organizationID else { return }
            let input = snapshot.input
            revision = snapshot.revision
            invoiceNumber = input.invoiceNumber
            title = input.title
            issueDate = MobileDateParser.dateOnly(input.issueDate) ?? .now
            dueDate = MobileDateParser.dateOnly(input.dueDate) ?? .now
            taxRate = String(input.taxRate)
            notes = input.notes
            lines = input.lines.map { line in
                NativeInvoiceLineDraft(sourceID: line.id, description: line.description, quantity: String(line.quantity), unit: line.unit,
                                       unitPrice: String(line.unitCost), taxable: line.taxable)
            }
        } catch is CancellationError {
        } catch {
            errorMessage = (error as? APIError)?.userMessage ?? "This draft could not be loaded."
        }
    }

    private func save() async {
        guard canSave, let organizationID = dependencies.workspace.selectedOrganizationID, let rate = validTax else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        let input = NativeInvoiceInput(projectId: projectID, invoiceNumber: invoiceNumber.trimmingCharacters(in: .whitespacesAndNewlines), title: title.trimmingCharacters(in: .whitespacesAndNewlines), issueDate: formatter.string(from: issueDate), dueDate: formatter.string(from: dueDate), notes: notes, taxRate: rate, lines: lines.compactMap(\.input))
        do {
            if let invoiceID, let revision {
                try await dependencies.mobileAPI.updateInvoiceDraft(input, invoiceID: invoiceID, revision: revision, organizationID: organizationID)
            } else {
                try await dependencies.mobileAPI.createInvoiceDraft(input, organizationID: organizationID)
            }
            guard dependencies.workspace.selectedOrganizationID == organizationID else { return }
            onSaved()
            dismiss()
        } catch {
            errorMessage = (error as? APIError)?.userMessage ?? "The draft could not be saved. Check Billing before retrying if the connection was interrupted."
        }
    }
}
