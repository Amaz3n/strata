import SwiftUI
import QuickLook

struct MobileWorkspaceField: Codable, Hashable, Identifiable, Sendable {
    var id: String { key }
    let key: String
    let label: String
    let kind: String
    let required: Bool?
    var value: String?
    var options: [String]? = nil
    var optionLabels: [String: String]? = nil
    var fields: [MobileWorkspaceField]? = nil

    var displayValue: String {
        guard let value else { return "" }
        if kind == "money", let cents = Int(value) { return CurrencyFormat.string(cents: cents) }
        if kind == "date" { return MobileDateParser.display(value) ?? value }
        if key == "status" { return value.replacingOccurrences(of: "_", with: " ").capitalized }
        return value
    }
}

struct MobileWorkspaceModule: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let title: String
    let group: String
    let symbol: String
    let createFields: [MobileWorkspaceField]
    let editFields: [MobileWorkspaceField]?
    var newRecordTitle: String {
        switch id {
        case "estimates": "New Proposal Draft"
        case "pipeline": "New Opportunity"
        case "transmittals": "New Transmittal Draft"
        case "change-orders": "New Change Order Draft"
        case "commitments": "New Commitment Draft"
        case "bids": "New Bid Package"
        case "schedule": "New Schedule Item"
        case "punch": "New Punch Item"
        case "tasks": "New Task"
        case "time": "Log My Time"
        case "rfis": "New RFI Draft"
        case "submittals": "New Submittal Draft"
        case "decisions": "New Decision"
        case "inspections": "New Inspection"
        case "meetings": "New Meeting"
        case "safety": "New Safety Incident"
        case "closeout": "New Closeout Item"
        case "warranty": "New Warranty Request"
        case "directory": "New Company"
        case "contacts": "New Contact"
        case "communities": "New Community"
        case "plans": "New Plan"
        case "chart": "New Ledger Account"
        default: "New Item"
        }
    }
}

struct MobileWorkspaceRecord: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let title: String
    let status: String?
    let fields: [MobileWorkspaceField]
}

struct MobileWorkspaceRecords: Decodable, Sendable {
    let records: [MobileWorkspaceRecord]
}

struct MobileWorkspaceAction: Decodable, Identifiable, Sendable {
    let revision: String?
    let id: String
    let title: String
    let fields: [MobileWorkspaceField]
}

struct MobileWorkspaceSection: Decodable, Identifiable, Sendable {
    let id: String
    let title: String
    let records: [MobileWorkspaceRecord]
}

struct MobileWorkspaceDocument: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let url: URL
}

struct MobileWorkspaceDetail: Decodable, Sendable {
    let documents: [MobileWorkspaceDocument]?
    let record: MobileWorkspaceRecord
    let sections: [MobileWorkspaceSection]
    let actions: [MobileWorkspaceAction]
}

/// iPad keeps its full workspace even in a narrow Stage Manager window.
/// Each surface retains its own selection and navigation history.
struct TabletWorkspaceView<Field: View>: View {
    private enum Mode: String, CaseIterable { case field = "Field", workspace = "Workspace" }
    @State private var mode = Mode.field
    @ViewBuilder let field: () -> Field

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Arc").font(.headline)
                Spacer()
                Picker("Workspace", selection: $mode) {
                    ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 280)
                Spacer()
                Image(systemName: mode == .field ? "hammer" : "sidebar.left")
                    .foregroundStyle(.secondary).accessibilityHidden(true)
            }
            .padding(.horizontal, 20).padding(.vertical, 8)
            .background(.bar)
            Divider()
            ZStack {
                field()
                    .opacity(mode == .field ? 1 : 0)
                    .allowsHitTesting(mode == .field)
                    .accessibilityHidden(mode != .field)
                NativeWorkspaceView()
                    .opacity(mode == .workspace ? 1 : 0)
                    .allowsHitTesting(mode == .workspace)
                    .accessibilityHidden(mode != .workspace)
            }
        }
    }
}

private struct NativeWorkspaceView: View {
    @Environment(AppDependencies.self) private var dependencies
    @State private var projectID: String?
    @State private var modules: [MobileWorkspaceModule] = []
    @State private var selectedModule: MobileWorkspaceModule?
    @State private var selectedRecord: MobileWorkspaceRecord?
    @State private var records: [MobileWorkspaceRecord] = []
    @State private var query = ""
    @State private var isLoadingModules = false
    @State private var isLoadingRecords = false
    @State private var moduleError: String?
    @State private var recordError: String?
    @State private var composing: MobileWorkspaceModule?
    @State private var refreshID = UUID()
    @State private var editing: MobileWorkspaceRecord?
    @State private var loadedRecordScope: String?

    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }
    private var scope: String { "\(organizationID ?? "")/\(projectID ?? "organization")" }
    private var recordScope: String { "\(scope)/\(selectedModule?.id ?? "")/\(refreshID)" }
    private var groups: [String] { modules.reduce(into: []) { if !$0.contains($1.group) { $0.append($1.group) } } }
    private var visibleRecords: [MobileWorkspaceRecord] {
        records.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || $0.fields.contains { $0.value?.localizedCaseInsensitiveContains(query) == true } }
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $selectedModule) {
                Section {
                    Picker("Scope", selection: $projectID) {
                        Text("Organization").tag(String?.none)
                        ForEach(dependencies.workspace.projects) { project in
                            Text(project.name).tag(Optional(project.id))
                        }
                    }
                }
                if isLoadingModules { ProgressView("Loading workspace…") }
                if let moduleError {
                    Text(moduleError).foregroundStyle(.secondary)
                    Button("Try Again") { Task { await loadModules() } }
                }
                ForEach(groups, id: \.self) { group in
                    Section(group) {
                        ForEach(modules.filter { $0.group == group }) { module in
                            NavigationLink(value: module) { Label(module.title, systemImage: module.symbol) }
                        }
                    }
                }
                if !isLoadingModules && moduleError == nil && modules.isEmpty {
                    Text("No modules are available for this workspace.").foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Workspace")
            .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 340)
        } content: {
            Group {
                if let selectedModule {
                    recordList(module: selectedModule)
                } else {
                    ContentUnavailableView("Choose a module", systemImage: "sidebar.left")
                }
            }
            .navigationSplitViewColumnWidth(min: 280, ideal: 360, max: 500)
        } detail: {
            if let selectedRecord, let selectedModule {
                NativeWorkspaceDetail(record: selectedRecord, module: selectedModule, projectID: projectID, onRecordUpdated: { updated in
                    if let index = records.firstIndex(where: { $0.id == updated.id }) { records[index] = updated }
                    self.selectedRecord = updated
                })
                    .id("\(scope)/\(selectedModule.id)/\(selectedRecord.id)")
                    .toolbar {
                        if !(selectedModule.editFields ?? []).isEmpty {
                            Button("Edit", systemImage: "pencil") { editing = selectedRecord }
                        }
                    }
            } else {
                ContentUnavailableView("Select an item", systemImage: "doc.text.magnifyingglass",
                                       description: Text("Details appear here while you browse the list."))
            }
        }
        .task(id: scope) { await loadModules() }
        .task(id: recordScope) { await loadRecords() }
        .onChange(of: organizationID) { _, _ in projectID = nil }
        .sheet(item: $editing) { record in
            if let selectedModule {
                NativeRecordComposer(module: selectedModule, projectID: projectID ?? "", record: record) { refreshID = UUID() }
            }
        }
        .sheet(item: $composing) { module in
            if module.id == "billing", let projectID {
                NativeInvoiceComposer(projectID: projectID) { refreshID = UUID() }
            } else {
                NativeRecordComposer(module: module, projectID: projectID ?? "") { refreshID = UUID() }
            }
        }
    }

    private func recordList(module: MobileWorkspaceModule) -> some View {
        List(selection: $selectedRecord) {
            if isLoadingRecords { ProgressView("Loading…") }
            if let recordError {
                Text(recordError).foregroundStyle(.secondary)
                Button("Try Again") { refreshID = UUID() }
            } else if !isLoadingRecords && visibleRecords.isEmpty {
                ContentUnavailableView(query.isEmpty ? "No items yet" : "No matches", systemImage: module.symbol)
            }
            ForEach(visibleRecords) { record in
                NavigationLink(value: record) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(record.title).font(.headline)
                        if let status = record.status { StatusBadge(status: status) }
                        if let field = record.fields.first(where: { $0.key != "status" }) {
                            Text(field.displayValue).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .navigationTitle(module.title)
        .searchable(text: $query, prompt: "Search \(module.title.lowercased())")
        .refreshable { await loadRecords() }
        .toolbar {
            if !module.createFields.isEmpty {
                Button("New", systemImage: "plus") { composing = module }
                    .keyboardShortcut("n", modifiers: .command)
            }
        }
    }

    private func loadModules() async {
        let requestedScope = scope
        selectedModule = nil
        selectedRecord = nil
        modules = []
        records = []
        moduleError = nil
        guard let organizationID else { return }
        isLoadingModules = true
        defer { if scope == requestedScope { isLoadingModules = false } }
        do {
            let loaded = try await dependencies.mobileAPI.loadWorkspaceModules(projectID: projectID, organizationID: organizationID)
            guard scope == requestedScope else { return }
            modules = loaded
            selectedModule = loaded.first
        } catch is CancellationError {
        } catch {
            guard scope == requestedScope else { return }
            moduleError = (error as? APIError)?.userMessage ?? "The workspace could not be loaded."
        }
    }

    private func loadRecords() async {
        let requestedScope = recordScope
        let identity = "\(scope)/\(selectedModule?.id ?? "")"
        let selectedID = loadedRecordScope == identity ? selectedRecord?.id : nil
        if loadedRecordScope != identity {
            selectedRecord = nil
            records = []
            query = ""
        }
        recordError = nil
        guard let organizationID, let selectedModule else { return }
        isLoadingRecords = true
        defer { if recordScope == requestedScope { isLoadingRecords = false } }
        do {
            let loaded = try await dependencies.mobileAPI.loadWorkspaceRecords(moduleID: selectedModule.id, projectID: projectID, organizationID: organizationID)
            guard recordScope == requestedScope else { return }
            records = loaded
            loadedRecordScope = identity
            selectedRecord = loaded.first { $0.id == selectedID }
        } catch is CancellationError {
        } catch {
            guard recordScope == requestedScope else { return }
            recordError = (error as? APIError)?.userMessage ?? "Items could not be loaded."
        }
    }
}

struct NativeWorkspaceDetail: View {
    @Environment(AppDependencies.self) private var dependencies
    let record: MobileWorkspaceRecord
    let module: MobileWorkspaceModule
    let projectID: String?
    var onRecordUpdated: ((MobileWorkspaceRecord) -> Void)? = nil
    @State private var detail: MobileWorkspaceDetail?
    @State private var loadError: String?
    @State private var loading = false
    @State private var action: MobileWorkspaceAction?
    @State private var reportFilters: [String: String] = [:]
    @State private var previewURL: URL?
    @State private var previewDirectory: URL?
    @State private var loadingDocumentID: String?
    @State private var documentError: String?
    private var currentRecord: MobileWorkspaceRecord { detail?.record ?? record }
    var body: some View {
        Form {
            Section {
                Text(currentRecord.title).font(.title2.weight(.semibold))
                if let status = currentRecord.status { StatusBadge(status: status) }
            }
            Section("Details") {
                ForEach(currentRecord.fields.filter { $0.key != "status" }) { field in
                    if field.kind == "multiline" {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(field.label).font(.caption).foregroundStyle(.secondary)
                            Text(field.displayValue).textSelection(.enabled)
                        }
                    } else {
                        LabeledContent(field.label, value: field.displayValue).textSelection(.enabled)
                    }
                }
            }
            if loading { ProgressView("Loading details…") }
            if let loadError {
                Section {
                    Text(loadError).foregroundStyle(.secondary)
                    Button("Try Again") { Task { await load() } }
                }
            }
            if let detail {
                if let documents = detail.documents, !documents.isEmpty {
                    Section("Documents") {
                        ForEach(documents) { document in
                            Button {
                                Task { await preview(document) }
                            } label: {
                                HStack {
                                    Label(document.name, systemImage: "doc.richtext")
                                    if loadingDocumentID == document.id { Spacer(); ProgressView() }
                                }
                            }.disabled(loadingDocumentID != nil)
                        }
                    }
                }
                ForEach(detail.sections) { section in
                    Section(section.title) {
                        if section.records.isEmpty { Text("No items yet").foregroundStyle(.secondary) }
                        ForEach(section.records) { entry in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(entry.title).font(.headline)
                                ForEach(entry.fields) { field in
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(field.label).font(.caption).foregroundStyle(.secondary)
                                        Text(field.displayValue).textSelection(.enabled)
                                    }
                                }
                            }.padding(.vertical, 4)
                        }
                    }
                }
                if !detail.actions.isEmpty {
                    Section("Actions") {
                        ForEach(detail.actions) { availableAction in
                            Button {
                                if availableAction.id == "preview-estimate" { Task { await previewEstimate() } }
                                else { action = availableAction }
                            } label: {
                                HStack { Text(availableAction.title); if loadingDocumentID == availableAction.id { Spacer(); ProgressView() } }
                            }.disabled(loadingDocumentID != nil)
                        }
                    }
                }
            }
        }
        .navigationTitle(record.title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: record) { await load() }
        .refreshable { await load() }
        .quickLookPreview($previewURL)
        .onChange(of: previewURL) { _, newValue in
            if newValue == nil, let previewDirectory {
                try? FileManager.default.removeItem(at: previewDirectory)
                self.previewDirectory = nil
            }
        }
        .alert("Document unavailable", isPresented: Binding(get: { documentError != nil }, set: { if !$0 { documentError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(documentError ?? "") }
        .sheet(item: $action) { action in
            if action.id == "attach-file", let projectID {
                NativeAttachmentComposer(module: module, recordID: record.id, projectID: projectID) { Task { await load() } }
            } else if action.id == "edit-invoice-draft", let projectID {
                NativeInvoiceComposer(projectID: projectID, invoiceID: record.id) { Task { await load() } }
            } else {
                NativeRecordComposer(module: module, projectID: projectID ?? "", record: record, action: action,
                                     onFilter: action.id == "report-filters" ? { reportFilters = $0 } : nil) { Task { await load() } }
            }
        }
    }
    private func previewEstimate() async {
        guard let projectID, let organizationID = dependencies.workspace.selectedOrganizationID else { return }
        let userID = dependencies.session.userID
        loadingDocumentID = "preview-estimate"
        defer { loadingDocumentID = nil }
        do {
            let temporary = try await dependencies.mobileAPI.downloadEstimatePDF(estimateID: record.id, projectID: projectID, organizationID: organizationID)
            defer { try? FileManager.default.removeItem(at: temporary) }
            try Task.checkCancellation()
            guard dependencies.workspace.selectedOrganizationID == organizationID, dependencies.session.userID == userID else { return }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let destination = directory.appendingPathComponent("Proposal.pdf")
            do {
                try FileManager.default.copyItem(at: temporary, to: destination)
                try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
                previewDirectory = directory
                previewURL = destination
            } catch { try? FileManager.default.removeItem(at: directory); throw error }
        } catch {
            guard dependencies.workspace.selectedOrganizationID == organizationID, dependencies.session.userID == userID else { return }
            documentError = (error as? APIError)?.userMessage ?? "The proposal PDF could not be loaded."
        }
    }

    private func preview(_ document: MobileWorkspaceDocument) async {
        let requestedOrganizationID = dependencies.workspace.selectedOrganizationID
        let requestedUserID = dependencies.session.userID
        loadingDocumentID = document.id
        defer { loadingDocumentID = nil }
        do {
            let (temporaryURL, response) = try await URLSession.shared.download(from: document.url)
            defer { try? FileManager.default.removeItem(at: temporaryURL) }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw APIError.invalidResponse
            }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let name = (document.name as NSString).lastPathComponent
            let destination = directory.appendingPathComponent(name.isEmpty ? "Document.pdf" : name)
            do {
                try FileManager.default.copyItem(at: temporaryURL, to: destination)
                try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
            } catch {
                try? FileManager.default.removeItem(at: directory)
                throw error
            }
            guard !Task.isCancelled,
                  dependencies.workspace.selectedOrganizationID == requestedOrganizationID,
                  dependencies.session.userID == requestedUserID else {
                try? FileManager.default.removeItem(at: directory)
                return
            }
            previewDirectory = directory
            previewURL = destination
        } catch {
            documentError = "This document could not be opened. Refresh the record to get a new download link and try again."
        }
    }

    private func load() async {
        guard let organizationID = dependencies.workspace.selectedOrganizationID else { return }
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            let loaded = try await dependencies.mobileAPI.loadWorkspaceDetail(moduleID: module.id, recordID: record.id, projectID: projectID, organizationID: organizationID, filters: reportFilters)
            guard !Task.isCancelled, dependencies.workspace.selectedOrganizationID == organizationID else { return }
            detail = loaded
            if loaded.record != record { onRecordUpdated?(loaded.record) }
        } catch is CancellationError {
        } catch {
            loadError = (error as? APIError)?.userMessage ?? "Details could not be loaded."
        }
    }

}

struct NativeRecordComposer: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss
    let module: MobileWorkspaceModule
    let projectID: String
    let onSaved: () -> Void
    let record: MobileWorkspaceRecord?
    let action: MobileWorkspaceAction?
    let onFilter: (([String: String]) -> Void)?
    private let initialValues: [String: String]
    @State private var values: [String: String]
    @State private var draftCache: FieldReferenceCache?
    @State private var restoredDraft = false
    @State private var draftSaveFailed = false
    private var draftKey: String { "workspace-draft/\(projectID)/\(module.id)" }
    private var savesLocalDraft: Bool { record == nil && action == nil && onFilter == nil }


    init(module: MobileWorkspaceModule, projectID: String, record: MobileWorkspaceRecord? = nil, action: MobileWorkspaceAction? = nil, onFilter: (([String: String]) -> Void)? = nil, onSaved: @escaping () -> Void) {
        self.module = module
        self.projectID = projectID
        self.record = record
        self.action = action
        self.onFilter = onFilter
        self.onSaved = onSaved
        var initial = Dictionary(uniqueKeysWithValues: (record?.fields ?? []).map { ($0.key, $0.value ?? "") })
        if let record { initial["title"] = record.title }
        let fields = action?.fields ?? (record == nil ? module.createFields : module.editFields ?? [])
        if action != nil { initial = Dictionary(uniqueKeysWithValues: fields.map { ($0.key, $0.value ?? "") }) }
        for field in fields where initial[field.key]?.isEmpty != false {
            if let option = field.options?.first { initial[field.key] = option }
            if field.key == "progress", initial[field.key]?.isEmpty != false { initial[field.key] = "0" }
            if field.kind == "date", field.required == true { initial[field.key] = MobileDateParser.todayKey }
        }
        initialValues = initial
        _values = State(initialValue: initial)
    }
    private var fields: [MobileWorkspaceField] { action?.fields ?? (record == nil ? module.createFields : module.editFields ?? []) }
    private var hasChanges: Bool { values != initialValues }

    @State private var isSaving = false
    @State private var confirmDiscard = false
    @State private var errorMessage: String?

    private var canSave: Bool {
        !isSaving && fields.allSatisfy { $0.accepts(values[$0.key] ?? "") }
    }

    var body: some View {
        NavigationStack {
            Form {
                if savesLocalDraft && draftCache != nil {
                    Label(draftSaveFailed ? "Could not save this draft on the device" : restoredDraft ? "Recovered your saved draft" : "Draft saved on this device", systemImage: "square.and.pencil")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if fields.isEmpty { Text("Confirm this action for \(record?.title ?? "this item").") }
                ForEach(fields) { field in
                    Section(field.label) {
                        if field.kind == "rows" {
                            NativeWorkspaceRowsEditor(field: field, value: Binding(get: { values[field.key] ?? "" }, set: { values[field.key] = $0 }))
                        } else if let options = field.options {
                            Picker(field.label, selection: Binding(get: { values[field.key] ?? options.first ?? "" }, set: { values[field.key] = $0 })) {
                                ForEach(options, id: \.self) { option in
                                    Text(field.optionLabels?[option] ?? option.replacingOccurrences(of: "_", with: " ").capitalized).tag(option)
                                }
                            }
                        } else if field.kind == "date" {
                            Toggle("Set date", isOn: Binding(get: { values[field.key]?.isEmpty == false }, set: {
                                values[field.key] = $0 ? MobileDateParser.todayKey : nil
                            }))
                            if values[field.key]?.isEmpty == false {
                                DatePicker(field.label, selection: Binding(get: {
                                    MobileDateParser.dateOnly(values[field.key]) ?? .now
                                }, set: { date in
                                    let formatter = DateFormatter()
                                    formatter.dateFormat = "yyyy-MM-dd"
                                    formatter.locale = Locale(identifier: "en_US_POSIX")
                                    values[field.key] = formatter.string(from: date)
                                }), displayedComponents: .date)
                            }
                        } else {
                            TextField(field.label, text: Binding(get: { values[field.key] ?? "" }, set: { values[field.key] = $0 }), axis: field.kind == "multiline" ? .vertical : .horizontal)
                                .lineLimit(field.kind == "multiline" ? 3...8 : 1...1)
                                .keyboardType(field.kind == "number" || field.kind == "money" ? .decimalPad : .default)
                        }
                    }
                }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            }
            .navigationTitle(action?.title ?? (record == nil ? module.newRecordTitle : "Edit Item"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") {
                    if hasChanges { confirmDiscard = true } else { dismiss() }
                }.disabled(isSaving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : (onFilter != nil ? "Apply" : action != nil ? "Confirm" : "Save")) { Task { await save() } }.disabled(!canSave)
                }
            }
            .task {
                guard savesLocalDraft, let userID = dependencies.session.userID, let orgID = dependencies.workspace.selectedOrganizationID else { return }
                let cache = FieldReferenceCache(userID: userID, organizationID: orgID)
                if let saved = cache.read([String: String].self, key: draftKey) {
                    let keys = Set(fields.map(\.key))
                    values.merge(saved.filter { keys.contains($0.key) }) { _, saved in saved }
                    restoredDraft = true
                }
                draftCache = cache
            }
            .onChange(of: values) { _, updated in
                if savesLocalDraft, let draftCache {
                    do { try draftCache.write(updated, key: draftKey); draftSaveFailed = false }
                    catch { draftSaveFailed = true }
                }
            }
            .onChange(of: dependencies.workspace.selectedOrganizationID) { _, _ in dismiss() }
            .onChange(of: dependencies.session.userID) { _, _ in dismiss() }
            .interactiveDismissDisabled(isSaving || hasChanges)
            .confirmationDialog("Discard this draft?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                if savesLocalDraft { Button("Keep Draft and Close") { dismiss() } }
                Button("Discard Draft", role: .destructive) { if savesLocalDraft { draftCache?.remove(key: draftKey) }; dismiss() }
                Button("Keep Editing", role: .cancel) {}
            }
        }
    }

    private func save() async {
        if let onFilter {
            onFilter(values)
            onSaved()
            dismiss()
            return
        }
        guard let organizationID = dependencies.workspace.selectedOrganizationID else { return }
        let userID = dependencies.session.userID
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            if let action, let record {
                try await dependencies.mobileAPI.performWorkspaceAction(moduleID: module.id, recordID: record.id, projectID: projectID, actionID: action.id, expectedRevision: action.revision, values: values, organizationID: organizationID)
            } else if let record {
                let submitted = Dictionary(uniqueKeysWithValues: fields.map { ($0.key, values[$0.key] ?? "") })
                try await dependencies.mobileAPI.editWorkspaceRecord(moduleID: module.id, recordID: record.id, projectID: projectID, values: submitted, organizationID: organizationID)
            } else {
                try await dependencies.mobileAPI.createWorkspaceRecord(moduleID: module.id, projectID: projectID, values: values, organizationID: organizationID)
            }
            if savesLocalDraft { draftCache?.remove(key: draftKey) }
            guard dependencies.session.userID == userID, dependencies.workspace.selectedOrganizationID == organizationID else { return }
            onSaved()
            dismiss()
        } catch {
            errorMessage = (error as? APIError)?.userMessage ?? "This item could not be saved."
        }
    }
}

/// Reuses the permission-checked native composer on the field screens.
private struct FieldCreateModifier: ViewModifier {
    @Environment(AppDependencies.self) private var dependencies
    let moduleID: String
    let projectID: String
    let onSaved: () async -> Void
    @State private var module: MobileWorkspaceModule?
    @State private var composing = false
    private var scope: String { "\(dependencies.workspace.selectedOrganizationID ?? ""):\(projectID)" }

    func body(content: Content) -> some View {
        content
            .toolbar {
                if let module, !module.createFields.isEmpty {
                    ToolbarItem(placement: .primaryAction) {
                        Button("New", systemImage: "plus") { composing = true }
                    }
                }
            }
            .task(id: scope) {
                module = nil
                let requestedScope = scope
                guard let organizationID = dependencies.workspace.selectedOrganizationID else { return }
                let modules = try? await dependencies.mobileAPI.loadWorkspaceModules(projectID: projectID, organizationID: organizationID)
                guard requestedScope == scope else { return }
                module = modules?.first { $0.id == moduleID }
            }
            .sheet(isPresented: $composing) {
                if let module {
                    NativeRecordComposer(module: module, projectID: projectID) { Task { await onSaved() } }
                }
            }
    }
}

extension View {
    func fieldCreateAction(moduleID: String, projectID: String, onSaved: @escaping () async -> Void) -> some View {
        modifier(FieldCreateModifier(moduleID: moduleID, projectID: projectID, onSaved: onSaved))
    }
}
