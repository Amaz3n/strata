import PhotosUI
import SwiftUI
import UIKit

/// Field capture of a variance purchase order against one house.
///
/// This is the most-watched cost control in production homebuilding: the cost
/// is caught standing in front of the work, with the photo that proves it,
/// instead of surfacing weeks later on an invoice nobody can argue with.
struct VarianceOrderComposerView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss

    let house: MobileMyHouse

    /// Stable for the life of the composer so a retry after a half-finished
    /// submission re-uses the same variance row instead of filing twice.
    @State private var clientID = UUID()
    @State private var purchaseOrderID: String?
    @State private var reasonID: String?
    @State private var amount = ""
    @State private var note = ""
    @State private var photos: [VarianceOrderPhoto] = []
    @State private var thumbnails: [UUID: UIImage] = [:]
    @State private var showCamera = false
    @State private var photoItem: PhotosPickerItem?
    @State private var filed: MobileVarianceOrder?

    private var store: VarianceOrderStore { dependencies.varianceOrders }
    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }

    private var selectedReason: MobileVarianceReasonCode? {
        store.reasonCodes.first { $0.id == reasonID }
    }

    private var amountCents: Int {
        guard let dollars = Double(amount.replacingOccurrences(of: ",", with: "")), dollars > 0 else { return 0 }
        return Int((dollars * 100).rounded())
    }

    private var trimmedNote: String {
        note.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSubmit: Bool {
        purchaseOrderID != nil
            && selectedReason != nil
            && amountCents > 0
            && !trimmedNote.isEmpty
            && !store.isOffline
            && !store.isSubmitting
    }

    var body: some View {
        NavigationStack {
            Group {
                if let filed {
                    filedResult(filed)
                } else {
                    composer
                }
            }
            .navigationTitle(filed == nil ? "Variance PO" : "Filed")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(filed == nil ? "Cancel" : "Done") { dismiss() }
                }
            }
            .task { await loadContext() }
            .fullScreenCover(isPresented: $showCamera) {
                FieldCameraPicker(
                    onCapture: { data in
                        showCamera = false
                        attach(data)
                    },
                    onCancel: { showCamera = false }
                )
                .ignoresSafeArea()
            }
            .onChange(of: photoItem) {
                guard let photoItem else { return }
                Task {
                    if let data = try? await photoItem.loadTransferable(type: Data.self) {
                        attach(data)
                    }
                }
            }
        }
    }

    // MARK: - Composer

    private var composer: some View {
        Form {
            Section {
                LabeledContent("House", value: "\(house.lotLabel) · \(house.communityName)")
                if let plan = house.planText {
                    LabeledContent("Plan", value: plan)
                }
            }

            purchaseOrderSection
            reasonSection

            Section {
                HStack {
                    Text(selectedReason?.isBackcharge == true ? "Backcharge" : "Cost")
                    Spacer()
                    TextField("0.00", text: $amount)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                }
                if amountCents > 0, let reason = selectedReason {
                    LabeledContent("Posts as") {
                        Text(CurrencyFormat.string(cents: reason.signedAmountCents(fromPositive: amountCents)))
                            .monospacedDigit()
                            .foregroundStyle(reason.isBackcharge ? .green : .primary)
                    }
                }
            } header: {
                Text("Amount")
            } footer: {
                if selectedReason?.isBackcharge == true {
                    Text("Backcharges bill the trade, so this posts as a credit against the purchase order.")
                }
            }

            Section("What happened") {
                TextField("Describe the variance", text: $note, axis: .vertical)
                    .lineLimit(3 ... 6)
            }

            photoSection

            if store.isOffline {
                Section {
                    Label(
                        "You're offline. A variance has to upload with its photos, so this one can't be filed until you have signal — the form stays as you left it.",
                        systemImage: "wifi.slash"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }

            if let message = store.submitError {
                Section {
                    Text(message).foregroundStyle(.red)
                }
            }

            Section {
                Button {
                    Task { await submit() }
                } label: {
                    if store.isSubmitting {
                        HStack { ProgressView(); Text("Filing…") }
                    } else {
                        Text("File Variance PO").frame(maxWidth: .infinity)
                    }
                }
                .disabled(!canSubmit)
            }
        }
    }

    @ViewBuilder
    private var purchaseOrderSection: some View {
        Section {
            if store.isLoadingContext {
                HStack { ProgressView().controlSize(.small); Text("Loading purchase orders…") }
                    .foregroundStyle(.secondary)
            } else if let message = store.contextError {
                VStack(alignment: .leading, spacing: 8) {
                    Text(message).foregroundStyle(.secondary)
                    Button("Try Again") { Task { await loadContext(force: true) } }
                }
            } else if store.purchaseOrders.isEmpty {
                ModuleEmptyRow(
                    title: "No purchase order available",
                    subtitle: "Arc can't list this house's purchase orders on mobile yet, so a variance can only be charged to a PO that already carries one. Raise the first one on the web.",
                    systemImage: "doc.text.magnifyingglass"
                )
            } else {
                Picker("Purchase order", selection: $purchaseOrderID) {
                    Text("Select").tag(String?.none)
                    ForEach(store.purchaseOrders) { order in
                        Text(order.companyName.map { "\(order.title) — \($0)" } ?? order.title)
                            .tag(String?.some(order.id))
                    }
                }
            }
        } header: {
            Text("Charge to")
        }
    }

    @ViewBuilder
    private var reasonSection: some View {
        Section("Reason") {
            if store.reasonCodes.isEmpty {
                Text(store.isLoadingContext ? "Loading reasons…" : "No active variance reasons are configured.")
                    .foregroundStyle(.secondary)
            } else {
                Picker("Reason", selection: $reasonID) {
                    Text("Select").tag(String?.none)
                    ForEach(store.reasonCodes) { reason in
                        Text(reason.label).tag(String?.some(reason.id))
                    }
                }
                if let reason = selectedReason, let description = reason.description, !description.isEmpty {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var photoSection: some View {
        Section("Evidence") {
            if !photos.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(photos) { photo in
                            thumbnail(for: photo)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            HStack {
                Button {
                    showCamera = true
                } label: {
                    Label("Take Photo", systemImage: "camera")
                }
                Spacer()
                PhotosPicker(selection: $photoItem, matching: .images) {
                    Label("Library", systemImage: "photo")
                }
            }
        }
    }

    private func thumbnail(for photo: VarianceOrderPhoto) -> some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let image = thumbnails[photo.id] {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    Color(.tertiarySystemFill)
                }
            }
            .frame(width: 88, height: 88)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

            Button {
                remove(photo)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.body)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.5))
            }
            .buttonStyle(.plain)
            .padding(4)
            .accessibilityLabel("Remove photo")
        }
    }

    // MARK: - Filed result

    private func filedResult(_ order: MobileVarianceOrder) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.largeTitle)
                        .foregroundStyle(.green)
                    Text(order.title)
                        .font(.title3.weight(.semibold))
                    Text("\(house.lotLabel) · \(house.communityName)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                ArcGlassCard {
                    VStack(alignment: .leading, spacing: 12) {
                        LabeledContent("Amount") {
                            Text(order.amountText)
                                .monospacedDigit()
                                .fontWeight(.semibold)
                                .foregroundStyle(order.isBackcharge ? .green : .primary)
                        }
                        Divider()
                        LabeledContent("Status") { StatusBadge(status: order.status) }
                        if !order.photoFileIds.isEmpty {
                            Divider()
                            LabeledContent("Evidence", value: "\(order.photoFileIds.count) photo\(order.photoFileIds.count == 1 ? "" : "s")")
                        }
                    }
                }

                // The mobile create route returns the saved row and nothing
                // else — the approval band that decides who can release it is
                // evaluated on approval, not on capture, so this is the whole
                // outcome the server reports.
                Label(
                    "Filed as \(order.status). It posts to the budget once someone other than you approves it — the approval band Arc applies depends on the amount.",
                    systemImage: "info.circle"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)

                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
        .background(ArcAmbientBackground())
    }

    // MARK: - Actions

    private func loadContext(force: Bool = false) async {
        guard let organizationID else { return }
        await store.loadContext(projectID: house.projectId, organizationID: organizationID, force: force)
        if purchaseOrderID == nil, store.purchaseOrders.count == 1 {
            purchaseOrderID = store.purchaseOrders.first?.id
        }
    }

    private func attach(_ data: Data) {
        guard let image = UIImage(data: data) else { return }
        let id = UUID()
        let jpeg = image.jpegData(compressionQuality: 0.88) ?? data
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("variance-\(id.uuidString).jpg")
        guard (try? jpeg.write(to: url)) != nil else { return }
        photos.append(VarianceOrderPhoto(id: id, fileURL: url, fileName: url.lastPathComponent))
        thumbnails[id] = image
    }

    private func remove(_ photo: VarianceOrderPhoto) {
        photos.removeAll { $0.id == photo.id }
        thumbnails[photo.id] = nil
        try? FileManager.default.removeItem(at: photo.fileURL)
    }

    private func submit() async {
        guard let organizationID, let purchaseOrderID, let reason = selectedReason else { return }
        let created = await store.file(
            clientID: clientID,
            purchaseOrderID: purchaseOrderID,
            reason: reason,
            amountCents: amountCents,
            note: trimmedNote,
            photos: photos,
            projectID: house.projectId,
            organizationID: organizationID
        )
        if let created {
            photos.forEach { try? FileManager.default.removeItem(at: $0.fileURL) }
            filed = created
        }
    }
}
