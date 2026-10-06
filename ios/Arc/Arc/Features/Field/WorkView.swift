import SwiftUI
import UniformTypeIdentifiers

/// Everyday field work. RFIs and receipts remain available from the project menu.
struct ProjectWorkView: View {
    private enum Segment: String, CaseIterable, Identifiable {
        case tasks = "Tasks"
        case punch = "Punch"
        case schedule = "Schedule"
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
            case .schedule: ProjectScheduleView(project: project)
            }
        }
        .navigationTitle("Work")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard let organizationID = dependencies.workspace.selectedOrganizationID else { return }
            await dependencies.field.load(projectID: project.id, organizationID: organizationID)

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
        case .schedule: return "Schedule"
        }
    }
}

/// Field-only tools stay contextual; office modules never enter the phone menu.
struct ProjectFieldToolsView: View {
    static let moduleIDs: Set<String> = ["time", "inspections", "safety", "warranty", "submittals", "selections", "decisions"]
    @Environment(AppDependencies.self) private var dependencies
    let project: MobileProject
    @State private var modules: [MobileWorkspaceModule] = []
    @State private var loading = false
    @State private var errorMessage: String?
    private var scope: String { "\(dependencies.workspace.selectedOrganizationID ?? "")/\(project.id)" }

    var body: some View {
        List {
            if loading { ProgressView("Loading field tools…") }
            if let errorMessage {
                Text(errorMessage).foregroundStyle(.secondary)
                Button("Try Again") { Task { await load() } }
            }
            ForEach(modules) { module in
                NavigationLink {
                    FieldWorkspaceListView(module: module, projectID: project.id)
                } label: { Label(module.title, systemImage: module.symbol) }
            }
            if !loading && errorMessage == nil && modules.isEmpty {
                ContentUnavailableView("No additional field tools", systemImage: "wrench.and.screwdriver",
                                       description: Text("Available tools depend on this project and your permissions."))
            }
        }
        .navigationTitle("Field Tools")
        .task(id: scope) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        let requestedScope = scope
        modules = []
        errorMessage = nil
        guard let organizationID = dependencies.workspace.selectedOrganizationID else { return }
        loading = true
        defer { if scope == requestedScope { loading = false } }
        do {
            let loaded = try await dependencies.mobileAPI.loadWorkspaceModules(projectID: project.id, organizationID: organizationID)
            guard !Task.isCancelled, scope == requestedScope else { return }
            modules = loaded.filter { Self.moduleIDs.contains($0.id) }
        } catch is CancellationError {
        } catch {
            guard scope == requestedScope else { return }
            errorMessage = (error as? APIError)?.userMessage ?? "Field tools could not be loaded."
        }
    }
}

struct FieldWorkspaceListView: View {
    @Environment(AppDependencies.self) private var dependencies
    let module: MobileWorkspaceModule
    let projectID: String
    @State private var records: [MobileWorkspaceRecord] = []
    @State private var loading = false
    @State private var errorMessage: String?
    @State private var query = ""
    @State private var composing: MobileWorkspaceModule?
    private var scope: String { "\(dependencies.workspace.selectedOrganizationID ?? "")/\(projectID)/\(module.id)" }
    private var filteredRecords: [MobileWorkspaceRecord] {
        records.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || $0.fields.contains { $0.value?.localizedCaseInsensitiveContains(query) == true } }
    }

    var body: some View {
        List {
            if loading { ProgressView("Loading…") }
            if let errorMessage {
                Text(errorMessage).foregroundStyle(.secondary)
                Button("Try Again") { Task { await load() } }
            }
            ForEach(filteredRecords) { record in
                NavigationLink {
                    FieldWorkspaceRecordView(moduleID: module.id, projectID: projectID, recordID: record.id, title: record.title)
                } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(record.title).font(.headline)
                        if let status = record.status { StatusBadge(status: status) }
                    }
                }
            }
            if !loading && errorMessage == nil && filteredRecords.isEmpty {
                ContentUnavailableView(query.isEmpty ? "No items yet" : "No matches", systemImage: module.symbol)
            }
        }
        .navigationTitle(module.title)
        .searchable(text: $query, prompt: "Search loaded items")
        .task(id: scope) { await load() }
        .refreshable { await load() }
        .toolbar {
            if !module.createFields.isEmpty {
                Button("New", systemImage: "plus") { composing = module }
            }
        }
        .sheet(item: $composing) { selected in
            NativeRecordComposer(module: selected, projectID: projectID) { Task { await load() } }
        }
    }

    private func load() async {
        let requestedScope = scope
        guard let organizationID = dependencies.workspace.selectedOrganizationID else { return }
        loading = true
        errorMessage = nil
        defer { if scope == requestedScope { loading = false } }
        do {
            let loaded = try await dependencies.mobileAPI.loadWorkspaceRecords(moduleID: module.id, projectID: projectID, organizationID: organizationID)
            guard !Task.isCancelled, scope == requestedScope else { return }
            records = loaded
        } catch is CancellationError {
        } catch {
            guard scope == requestedScope else { return }
            errorMessage = (error as? APIError)?.userMessage ?? "Items could not be loaded."
        }
    }
}

/// The same permission-checked detail and actions power phone and tablet.
struct FieldWorkspaceRecordView: View {
    @Environment(AppDependencies.self) private var dependencies
    let moduleID: String
    let projectID: String
    let recordID: String
    let title: String
    @State private var module: MobileWorkspaceModule?
    @State private var record: MobileWorkspaceRecord?
    @State private var editing: MobileWorkspaceRecord?
    @State private var errorMessage: String?
    @State private var refreshID = UUID()
    private var scope: String { "\(dependencies.workspace.selectedOrganizationID ?? "")/\(projectID)/\(moduleID)/\(recordID)" }

    var body: some View {
        Group {
            if let module, let record {
                NativeWorkspaceDetail(record: record, module: module, projectID: projectID) { updated in self.record = updated }
                    .id(refreshID)
                    .toolbar {
                        if !(module.editFields ?? []).isEmpty {
                            Button("Edit", systemImage: "pencil") { editing = record }
                        }
                    }
            } else if let errorMessage {
                ContentUnavailableView {
                    Label("Unable to open item", systemImage: "exclamationmark.triangle")
                } description: { Text(errorMessage) } actions: {
                    Button("Try Again") { Task { await load() } }
                }
            } else { ProgressView("Loading…") }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: scope) { await load() }
        .sheet(item: $editing) { selected in
            if let module {
                NativeRecordComposer(module: module, projectID: projectID, record: selected) { refreshID = UUID() }
            }
        }
    }

    private func load() async {
        let requestedScope = scope
        module = nil
        record = nil
        errorMessage = nil
        guard let organizationID = dependencies.workspace.selectedOrganizationID else { return }
        do {
            let modules = try await dependencies.mobileAPI.loadWorkspaceModules(projectID: projectID, organizationID: organizationID)
            guard let selected = modules.first(where: { $0.id == moduleID }) else {
                guard scope == requestedScope else { return }
                errorMessage = "This tool is not available for this project or your permissions."
                return
            }
            let detail = try await dependencies.mobileAPI.loadWorkspaceDetail(moduleID: moduleID, recordID: recordID, projectID: projectID, organizationID: organizationID)
            guard !Task.isCancelled, scope == requestedScope else { return }
            module = selected
            record = detail.record
        } catch is CancellationError {
        } catch {
            guard scope == requestedScope else { return }
            errorMessage = (error as? APIError)?.userMessage ?? "This item could not be loaded."
        }
    }
}

/// Cross-house technician queue. The current API day boundary is explicitly UTC.
struct ServiceVisitsView: View {
    @Environment(AppDependencies.self) private var dependencies
    @State private var store = ServiceVisitsStore()
    @State private var day = Date.now
    private var dateKey: String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: day)
    }
    private var scope: String { "\(dependencies.mobileAPI.userID ?? "")/\(dependencies.workspace.selectedOrganizationID ?? "")/\(dateKey)" }

    var body: some View {
        List {
            Section {
                DatePicker("Service day (UTC)", selection: $day, displayedComponents: .date)
                    .environment(\.timeZone, TimeZone(secondsFromGMT: 0)!)
                    .environment(\.calendar, Calendar(identifier: .gregorian))
            } footer: {
                Text("Visit windows use UTC days. Times below are shown in your device time zone.")
            }
            if let error = store.errorMessage {
                Section {
                    Text(error).foregroundStyle(.secondary)
                    Button("Try Again") {
                        Task {
                            if store.nextCursor != nil { await store.loadMore(load: loadPage) }
                            else { await refresh() }
                        }
                    }.disabled(store.isLoading)
                }
            }
            ForEach(store.rows) { visit in
                if visit.request != nil {
                    NavigationLink {
                        ServiceVisitDetailView(visitID: visit.id) { Task { await refresh() } }
                    } label: { visitRow(visit) }
                } else { visitRow(visit) }
            }
            if store.isLoading { ProgressView("Loading visits…") }
            else if store.nextCursor != nil {
                Button("Load more visits") { Task { await store.loadMore(load: loadPage) } }
            } else if dependencies.workspace.selectedOrganizationID == nil {
                ContentUnavailableView("Choose an organization", systemImage: "building.2")
            } else if store.rows.isEmpty && store.errorMessage == nil {
                ContentUnavailableView("No assigned visits", systemImage: "wrench.and.screwdriver",
                                       description: Text("No service visits are assigned to you on this UTC day."))
            }
        }
        .navigationTitle("My Service Visits")
        .task(id: scope) { await refresh() }
        .refreshable { await refresh() }
    }

    private func visitRow(_ visit: MobileServiceVisit) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(visit.request?.title ?? "Request unavailable").font(.headline)
            Text(visit.project?.name ?? "House").foregroundStyle(.secondary)
            HStack {
                Text("Visit \(visit.visitNumber)")
                StatusBadge(status: visit.status)
            }
            Text("\(visit.windowStart.formatted(date: .abbreviated, time: .shortened)) – \(visit.windowEnd.formatted(date: .abbreviated, time: .shortened))")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func loadPage(_ org: String, _ date: String, _ cursor: String?) async throws -> MobileServiceVisitPage {
        try await dependencies.mobileAPI.loadServiceVisits(organizationID: org, date: date, cursor: cursor)
    }
    private func refresh() async {
        await store.refresh(organizationID: dependencies.mobileAPI.userID == nil ? nil : dependencies.workspace.selectedOrganizationID, date: dateKey, load: loadPage)
    }
}

struct ServiceVisitDetailView: View {
    @Environment(AppDependencies.self) private var dependencies
    let visitID: String
    var onCompleted: () -> Void = {}
    @State private var visit: MobileServiceVisit?
    @State private var loadedScope: String?
    @State private var loadGeneration = UUID()
    @State private var loading = false
    @State private var errorMessage: String?
    @State private var completion = ServiceVisitCompletionStore()
    @State private var outcome = "resolved"
    @State private var note = ""
    @State private var hours = ""
    @State private var rate = ""
    @State private var materials = ""
    @State private var evidence: [(id: String, name: String)] = []
    @State private var showFiles = false
    @State private var uploading = false
    @State private var pendingUpload: (url: URL, id: String)?
    private var scope: String { "\(dependencies.mobileAPI.userID ?? "")/\(dependencies.workspace.selectedOrganizationID ?? "")/\(visitID)" }
    private var currentVisit: MobileServiceVisit? { loadedScope == scope ? visit : nil }

    var body: some View {
        Form {
            if let visit = currentVisit {
                Section("Visit") {
                    Text(visit.request?.title ?? "Warranty request")
                    Text(visit.project?.name ?? "House").foregroundStyle(.secondary)
                    StatusBadge(status: completion.completedVisit?.status ?? visit.status)
                    Text(visit.windowStart.formatted(date: .abbreviated, time: .shortened))
                    if let description = visit.request?.description { Text(description) }
                    NavigationLink("Open warranty request") {
                        FieldWorkspaceRecordView(moduleID: "warranty", projectID: visit.projectId,
                                                 recordID: visit.requestId, title: visit.request?.title ?? "Warranty request")
                    }
                }
                if completion.completedVisit != nil {
                    Section { Label("Visit completed", systemImage: "checkmark.circle") }
                } else if visit.canComplete == true || completion.attempted != nil {
                    Section("Completion") {
                        Picker("Outcome", selection: $outcome) {
                            Text("Resolved").tag("resolved")
                            Text("Follow-up needed").tag("needs_followup")
                            Text("Parts needed").tag("needs_parts")
                            Text("Not warrantable").tag("not_warrantable")
                        }
                        TextField("Work performed and next steps", text: $note, axis: .vertical)
                            .lineLimit(3...8)
                        TextField("Labor hours", text: $hours).keyboardType(.decimalPad)
                        TextField("Labor rate per hour", text: $rate).keyboardType(.decimalPad)
                        TextField("Materials amount", text: $materials).keyboardType(.decimalPad)
                    }.disabled(completion.attempted != nil || completion.needsRefresh || uploading)
                    Section("Photo evidence") {
                        ForEach(evidence, id: \.id) { photo in Text(photo.name) }
                        if let pendingUpload {
                            Text(pendingUpload.url.lastPathComponent)
                            Button("Retry photo upload") { Task { await uploadPhoto() } }
                        } else {
                            Button("Choose repair photo") { showFiles = true }
                        }
                        if uploading { ProgressView("Uploading photo…") }
                    }.disabled(completion.attempted != nil || completion.needsRefresh || uploading || evidence.count >= 20)
                    if completion.attempted != nil {
                        Section {
                            Text(completion.isDurable
                                 ? "These submitted details are saved on this device. Retry uses the same details to recover the original completion receipt."
                                 : "These details have not been saved on this device yet. Keep this screen open and retry before closing it.")
                                .foregroundStyle(.secondary)
                        }
                    }
                    if completion.needsRefresh { Button("Refresh visit") { Task { await load() } } }
                    Button(completion.attempted == nil ? "Complete visit" : "Retry same completion") {
                        Task { await submit() }
                    }.disabled(completion.isSaving || completion.needsRefresh || uploading || pendingUpload != nil)
                    if completion.isSaving { ProgressView("Confirming completion…") }
                } else if visit.status == "completed" {
                    Section("Recorded outcome") {
                        if let outcome = visit.outcome { Text(outcome.replacingOccurrences(of: "_", with: " ").capitalized) }
                        if let note = visit.outcomeNote { Text(note) }
                    }
                } else {
                    Section { Text("Completion is unavailable for this visit or your access. Contact your service coordinator.").foregroundStyle(.secondary) }
                }
            } else if loading { ProgressView("Loading visit…") }
            if let message = completion.errorMessage ?? errorMessage {
                Section { Text(message).foregroundStyle(.secondary) }
            }
            if currentVisit == nil && !loading { Button("Try Again") { Task { await load() } } }
        }
        .navigationTitle("Service Visit")
        .task(id: scope) { await load() }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.image]) { result in
            do {
                let url = try result.get()
                pendingUpload = (url, UUID().uuidString)
                Task { await uploadPhoto() }
            } catch { errorMessage = "The photo could not be selected." }
        }
    }

    private func load() async {
        let requestedScope = scope
        let requestedGeneration = UUID()
        loadGeneration = requestedGeneration
        visit = nil
        loadedScope = nil
        completion.reset()
        evidence = []
        uploading = false
        pendingUpload = nil
        errorMessage = nil
        guard let org = dependencies.workspace.selectedOrganizationID, let actorID = dependencies.mobileAPI.userID else { return }
        loading = true
        defer { if scope == requestedScope && loadGeneration == requestedGeneration { loading = false } }
        do {
            let loaded = try await dependencies.mobileAPI.loadServiceVisit(visitID: visitID, organizationID: org)
            guard !Task.isCancelled, scope == requestedScope, loadGeneration == requestedGeneration else { return }
            let journal = ServiceVisitCompletionJournal(secrets: dependencies.keychain, actorID: actorID, organizationID: org,
                                                         projectID: loaded.projectId, visitID: visitID)
            let pending = try await journal.read()
            guard !Task.isCancelled, scope == requestedScope, loadGeneration == requestedGeneration else { return }
            completion.restore(pending?.input)
            visit = loaded
            loadedScope = requestedScope
            outcome = pending?.input.outcome ?? loaded.outcome ?? "resolved"
            note = pending?.input.outcomeNote ?? loaded.outcomeNote ?? ""
            if let pending {
                hours = pending.input.laborHours.map { String($0) } ?? ""
                rate = MobileServiceVisitCompletion.amountText(pending.input.laborRateCents)
                materials = MobileServiceVisitCompletion.amountText(pending.input.materialCents)
            } else {
                hours = loaded.laborHours.map { String($0) } ?? ""
                rate = MobileServiceVisitCompletion.amountText(loaded.laborRateCents)
                materials = MobileServiceVisitCompletion.amountText(loaded.internalMaterialCents)
            }
            evidence = (pending?.input.photoFileIds ?? []).enumerated().map { ($0.element, "Saved repair photo \($0.offset + 1)") }
        } catch is CancellationError {
        } catch {
            guard scope == requestedScope, loadGeneration == requestedGeneration else { return }
            errorMessage = (error as? APIError)?.userMessage ?? "The visit could not be loaded."
        }
    }

    private func uploadPhoto() async {
        guard !uploading, completion.attempted == nil, let pending = pendingUpload, let visit = currentVisit,
              let org = dependencies.workspace.selectedOrganizationID, let actorID = dependencies.mobileAPI.userID else { return }
        let requestedScope = scope
        let requestedGeneration = loadGeneration
        uploading = true
        errorMessage = nil
        let accessed = pending.url.startAccessingSecurityScopedResource()
        defer {
            if accessed { pending.url.stopAccessingSecurityScopedResource() }
            if requestedScope == scope && loadGeneration == requestedGeneration { uploading = false }
        }
        do {
            let type = try pending.url.resourceValues(forKeys: [.contentTypeKey]).contentType
            guard type?.conforms(to: .image) == true, let mime = type?.preferredMIMEType else { throw APIError.invalidRequest }
            let file = try await dependencies.mobileAPI.uploadFile(fileURL: pending.url, fileName: pending.url.lastPathComponent,
                mimeType: mime, clientID: pending.id, folder: "/Warranty Evidence", category: "other",
                projectID: visit.projectId, organizationID: org, downscalesImages: true, expectedUserID: actorID)
            guard !Task.isCancelled, scope == requestedScope, loadGeneration == requestedGeneration else { return }
            evidence.append((file.id, pending.url.lastPathComponent))
            pendingUpload = nil
        } catch {
            guard scope == requestedScope, loadGeneration == requestedGeneration else { return }
            errorMessage = (error as? APIError)?.userMessage ?? "The photo upload could not be confirmed. Retry the same upload."
        }
    }

    private func submit() async {
        guard let org = dependencies.workspace.selectedOrganizationID, let actorID = dependencies.mobileAPI.userID, let visit = currentVisit,
              completion.attempted != nil || visit.canComplete == true else { return }
        errorMessage = nil
        do {
            let input: MobileServiceVisitCompletion
            if let attempted = completion.attempted { input = attempted }
            else {
                guard let expectedVisitAt = visit.updatedAt, !expectedVisitAt.isEmpty, note.utf16.count <= 4000, ["resolved", "needs_followup", "needs_parts", "not_warrantable"].contains(outcome) else { throw APIError.invalidRequest }
                let hoursText = hours.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
                let laborHours = hoursText.isEmpty ? nil : Double(hoursText)
                guard hoursText.isEmpty || (laborHours != nil && laborHours!.isFinite && laborHours! >= 0 && laborHours! <= 24) else { throw APIError.invalidRequest }
                let laborRate = try MobileServiceVisitCompletion.cents(rate)
                guard (laborHours == nil) == (laborRate == nil) else { throw APIError.invalidRequest }
                input = MobileServiceVisitCompletion(expectedVisitAt: expectedVisitAt, outcome: outcome, outcomeNote: note, photoFileIds: evidence.map(\.id),
                    laborHours: laborHours, laborRateCents: laborRate,
                    materialCents: try MobileServiceVisitCompletion.cents(materials) ?? 0)
            }
            let requestedScope = scope
            let requestedGeneration = loadGeneration
            let journal = ServiceVisitCompletionJournal(secrets: dependencies.keychain, actorID: actorID, organizationID: org,
                                                         projectID: visit.projectId, visitID: visitID)
            await completion.submit(input) { payload in
                try await journal.submit(payload, isCurrent: { requestedScope == scope && loadGeneration == requestedGeneration },
                                         onReserved: { completion.markDurable(payload) }) { savedPayload in
                    try await dependencies.mobileAPI.completeServiceVisit(visitID: visitID, organizationID: org, actorID: actorID, input: savedPayload)
                }
            }
            if completion.completedVisit != nil, requestedScope == scope { onCompleted() }
        } catch { errorMessage = "Enter labor hours (0–24) and a rate together; use at most two decimals for amounts. Check notes and photos." }
    }
}
