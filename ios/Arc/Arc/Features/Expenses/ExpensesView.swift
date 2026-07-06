import PhotosUI
import SwiftUI
import UIKit

struct ProjectExpensesView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(AppRouter.self) private var router
    let project: MobileProject

    private var store: ExpenseStore { dependencies.expenses }
    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }

    var body: some View {
        List {
            Section {
                Button {
                    router.navigate(to: .scanReceipt)
                } label: {
                    Label("Add Expense / Scan Receipt", systemImage: "doc.viewfinder")
                        .font(.headline)
                }
            }

            if !store.expenses.isEmpty {
                Section {
                    HStack {
                        Text("Total submitted").foregroundStyle(.secondary)
                        Spacer()
                        Text(CurrencyFormat.string(cents: store.totalCents)).fontWeight(.semibold)
                    }
                }
            }

            Section("Recent expenses") {
                if store.isLoading && store.expenses.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
                } else if let message = store.errorMessage, store.expenses.isEmpty {
                    Text(message).foregroundStyle(.secondary)
                } else if store.expenses.isEmpty {
                    ModuleEmptyRow(
                        title: "No expenses yet",
                        subtitle: "Scan a receipt to submit your first expense.",
                        systemImage: "receipt"
                    )
                } else {
                    ForEach(store.expenses) { expense in ExpenseRow(expense: expense) }
                }
            }
        }
        .navigationTitle("Expenses")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await refresh() }
        .task { await load() }
    }

    private func load() async {
        guard let organizationID else { return }
        await store.load(projectID: project.id, organizationID: organizationID)
    }

    private func refresh() async {
        guard let organizationID else { return }
        await store.refresh(projectID: project.id, organizationID: organizationID)
    }
}

private struct ExpenseRow: View {
    let expense: MobileExpense

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: expense.receiptUrl == nil ? "receipt" : "doc.text.image")
                .foregroundStyle(.tint)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(expense.vendorName ?? "Expense").font(.headline)
                if let description = expense.description, !description.isEmpty {
                    Text(description).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                HStack(spacing: 8) {
                    if let date = expense.expenseDateText {
                        Text(date).font(.caption).foregroundStyle(.secondary)
                    }
                    StatusBadge(status: expense.status)
                }
            }
            Spacer()
            Text(expense.amountText).fontWeight(.semibold)
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Receipt capture + submission

struct ReceiptCaptureView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(AppRouter.self) private var router
    let project: MobileProject

    @State private var receiptImage: UIImage?
    @State private var receiptURL: URL?
    @State private var showCamera = false
    @State private var photoItem: PhotosPickerItem?

    @State private var vendor = ""
    @State private var date = Date.now
    @State private var amount = ""
    @State private var tax = ""
    @State private var paymentMethod = PaymentMethod.companyCard
    @State private var notes = ""

    @State private var isScanning = false
    @State private var isSubmitting = false
    @State private var scanMessage: String?
    @State private var errorMessage: String?

    private var store: ExpenseStore { dependencies.expenses }
    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }

    private var canSubmit: Bool {
        (Double(amount) ?? 0) > 0 && !isSubmitting
    }

    var body: some View {
        Form {
            Section("Receipt") {
                if let receiptImage {
                    Image(uiImage: receiptImage)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: 220)
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                HStack {
                    Button {
                        showCamera = true
                    } label: {
                        Label(receiptImage == nil ? "Take Photo" : "Retake", systemImage: "camera")
                    }
                    Spacer()
                    PhotosPicker(selection: $photoItem, matching: .images) {
                        Label("Library", systemImage: "photo")
                    }
                }
                if receiptImage != nil {
                    Button {
                        Task { await scan() }
                    } label: {
                        if isScanning {
                            HStack { ProgressView(); Text("Scanning…") }
                        } else {
                            Label("Scan with AI", systemImage: "sparkles")
                        }
                    }
                    .disabled(isScanning)
                }
                if let scanMessage {
                    Text(scanMessage).font(.caption).foregroundStyle(.secondary)
                }
            }

            Section("Details") {
                TextField("Vendor", text: $vendor)
                DatePicker("Date", selection: $date, displayedComponents: .date)
                HStack {
                    Text("Amount")
                    Spacer()
                    TextField("0.00", text: $amount)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                }
                HStack {
                    Text("Tax")
                    Spacer()
                    TextField("0.00", text: $tax)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                }
                Picker("Payment", selection: $paymentMethod) {
                    ForEach(PaymentMethod.allCases) { method in
                        Text(method.label).tag(method)
                    }
                }
                TextField("Notes", text: $notes, axis: .vertical)
                    .lineLimit(2 ... 4)
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red)
                }
            }

            Section {
                Button {
                    Task { await submit() }
                } label: {
                    if isSubmitting {
                        HStack { ProgressView(); Text("Submitting…") }
                    } else {
                        Text("Submit Expense").frame(maxWidth: .infinity)
                    }
                }
                .disabled(!canSubmit)
            }
        }
        .navigationTitle("New Expense")
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(isPresented: $showCamera) {
            ReceiptCameraPicker(
                onCapture: { data in
                    showCamera = false
                    handleCaptured(data)
                },
                onCancel: { showCamera = false }
            )
            .ignoresSafeArea()
        }
        .onChange(of: photoItem) {
            guard let photoItem else { return }
            Task {
                if let data = try? await photoItem.loadTransferable(type: Data.self) {
                    handleCaptured(data)
                }
            }
        }
    }

    private func handleCaptured(_ data: Data) {
        guard let image = UIImage(data: data) else { return }
        receiptImage = image
        scanMessage = nil
        let jpeg = image.jpegData(compressionQuality: 0.85) ?? data
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("receipt-\(UUID().uuidString).jpg")
        try? jpeg.write(to: url)
        receiptURL = url
    }

    private func scan() async {
        guard let receiptURL, let organizationID else { return }
        isScanning = true
        scanMessage = nil
        errorMessage = nil
        defer { isScanning = false }
        do {
            let result = try await store.scan(receiptURL: receiptURL, projectID: project.id, organizationID: organizationID)
            applyScan(result)
        } catch {
            scanMessage = (error as? APIError)?.userMessage ?? "Could not scan receipt. Enter details manually."
        }
    }

    private func applyScan(_ result: MobileReceiptScan) {
        if let vendorName = result.vendorName { vendor = vendorName }
        if let total = result.totalDollars { amount = String(format: "%.2f", total) }
        if let taxDollars = result.taxDollars { tax = String(format: "%.2f", taxDollars) }
        if let description = result.description, notes.isEmpty { notes = description }
        if let parsed = MobileDateParser.dateOnly(result.expenseDate) { date = parsed }
        if let method = result.paymentMethod, let parsed = PaymentMethod(rawValue: method) { paymentMethod = parsed }
        scanMessage = "Scanned (\(result.confidence) confidence). Review the details below."
    }

    private func submit() async {
        guard let organizationID else { return }
        guard let amountValue = Double(amount), amountValue > 0 else {
            errorMessage = "Enter the receipt total."
            return
        }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"

        let payload = CreateExpensePayload(
            clientId: UUID().uuidString,
            expenseDate: formatter.string(from: date),
            amountDollars: amountValue,
            taxDollars: Double(tax),
            vendorName: vendor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : vendor,
            paymentMethod: paymentMethod.rawValue,
            description: notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : notes
        )
        do {
            try await store.create(payload, receiptURL: receiptURL, projectID: project.id, organizationID: organizationID)
            if !router.path.isEmpty { router.path.removeLast() }
        } catch {
            errorMessage = (error as? APIError)?.userMessage ?? "The expense could not be submitted."
        }
    }
}

enum PaymentMethod: String, CaseIterable, Identifiable {
    case cash
    case creditCard = "credit_card"
    case check
    case ach
    case companyCard = "company_card"
    case reimbursablePersonal = "reimbursable_personal"
    case other

    var id: String { rawValue }

    var label: String {
        switch self {
        case .cash: "Cash"
        case .creditCard: "Credit card"
        case .check: "Check"
        case .ach: "ACH"
        case .companyCard: "Company card"
        case .reimbursablePersonal: "Personal (reimburse)"
        case .other: "Other"
        }
    }
}

private struct ReceiptCameraPicker: UIViewControllerRepresentable {
    let onCapture: (Data) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let parent: ReceiptCameraPicker
        init(parent: ReceiptCameraPicker) { self.parent = parent }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let image = info[.originalImage] as? UIImage,
                  let data = image.jpegData(compressionQuality: 0.88) else {
                parent.onCancel()
                return
            }
            parent.onCapture(data)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.onCancel() }
    }
}
