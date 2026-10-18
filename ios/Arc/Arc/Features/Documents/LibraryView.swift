import SwiftUI

/// "Library" is the project's reference material — drawings and documents —
/// the two things people pull up on site. One segmented surface instead of two
/// separate tabs.
struct ProjectLibraryView: View {
    private enum Segment: String, CaseIterable, Identifiable {
        case drawings = "Drawings"
        case documents = "Documents"
        case photos = "Photos"
        var id: Self { self }
    }

    @State private var segment: Segment = .drawings
    let project: MobileProject

    var body: some View {
        VStack(spacing: 0) {
            Picker("Library", selection: $segment.animation(.easeInOut(duration: 0.2))) {
                ForEach(Segment.allCases) { segment in
                    Text(segment.rawValue).tag(segment)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(.bar)

            Divider()

            switch segment {
            case .drawings: ProjectDrawingsView(project: project)
            case .documents: ProjectDocumentsView(project: project)
            case .photos: ProjectPhotosView(project: project)
            }
        }
        .navigationTitle("Library")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct ProjectOfflineDownloadView: View {
    private struct SavedDownload: Codable {
        let date: Date
        let documents: Int
        let drawings: Int
    }
    @Environment(AppDependencies.self) private var dependencies
    let project: MobileProject
    @State private var attempt = 0
    @State private var running = false
    @State private var completed = 0
    @State private var total = 0
    @State private var currentName = ""
    @State private var failures: [String] = []
    @State private var errorMessage: String?
    @State private var saved: SavedDownload?
    @State private var downloadDocuments = true
    @State private var downloadDrawings = true
    private var scope: String { "\(dependencies.session.userID ?? "")/\(dependencies.workspace.selectedOrganizationID ?? "")/\(project.id)" }
    private var runScope: String { "\(scope)/\(attempt)" }

    var body: some View {
        Form {
            Section {
                Text(project.name).font(.headline)
                Toggle("Documents", isOn: $downloadDocuments).disabled(running)
                Toggle("Current drawing sheets", isOn: $downloadDrawings).disabled(running)
            } footer: {
                Text("Keep this screen open while downloading. Refresh before heading to the site to save the latest revisions. Large projects can use significant storage and mobile data.")
            }
            if let saved {
                Section("Last Completed Download") {
                    LabeledContent("Saved", value: saved.date.formatted(date: .abbreviated, time: .shortened))
                    LabeledContent("Documents", value: String(saved.documents))
                    LabeledContent("Drawing sheets", value: String(saved.drawings))
                    Text("This is the last downloaded snapshot. New changes require another download.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Section {
                if running {
                    ProgressView(value: Double(completed), total: Double(max(total, 1)))
                    Text(total == 0 ? "Preparing download…" : "\(completed) of \(total) checked")
                    Text(currentName).font(.caption).lineLimit(2)
                    Button("Stop Download", role: .cancel) { attempt = 0 }
                } else {
                    Button(saved == nil ? "Download for Offline" : "Check for Updates & Download", systemImage: "arrow.down.circle") {
                        attempt += 1
                    }.disabled(!downloadDocuments && !downloadDrawings)
                }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            }
            if !failures.isEmpty {
                Section("Not Downloaded (\(failures.count))") {
                    ForEach(Array(failures.enumerated()), id: \.offset) { _, name in Text(name) }
                    Text("Retry the download when connected. Files already saved are kept.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Offline Project")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: runScope) {
            if attempt == 0 { restore(); return }
            await download()
        }
        .onChange(of: scope) { _, _ in attempt = 0; saved = nil; failures = []; errorMessage = nil }
    }

    private func cache() -> FieldReferenceCache {
        FieldReferenceCache(userID: dependencies.session.userID ?? "signed-out", organizationID: dependencies.workspace.selectedOrganizationID ?? "none")
    }
    private func restore() {
        saved = cache().read(SavedDownload.self, key: "offline-project/\(project.id)")
        running = false
    }
    private func download() async {
        let requestedScope = runScope
        guard let organizationID = dependencies.workspace.selectedOrganizationID else { return }
        let requestedCache = cache()
        running = true
        completed = 0
        total = 0
        failures = []
        errorMessage = nil
        defer { if runScope == requestedScope { running = false } }
        do {
            var files: [MobileFile] = []
            var sheets: [MobileDrawingSheet] = []
            if downloadDocuments {
                currentName = "Preparing document folders"
                files = try await dependencies.documents.prepareProjectDownload(projectID: project.id, organizationID: organizationID)
            }
            if downloadDrawings {
                currentName = "Checking current drawing revisions"
                await dependencies.drawings.refresh(projectID: project.id, organizationID: organizationID)
                try Task.checkCancellation()
                if let error = dependencies.drawings.errorMessage {
                    throw APIError.server(statusCode: 503, code: nil, message: error, requestID: nil)
                }
                guard !dependencies.drawings.isUsingOfflineData else { throw APIError.transport(description: "Offline") }
                sheets = dependencies.drawings.sheets
            }
            guard requestedScope == runScope else { return }
            total = files.count + sheets.count
            for file in files {
                try Task.checkCancellation()
                guard requestedScope == runScope else { return }
                currentName = file.fileName
                do { _ = try await dependencies.documents.ensureLocal(file, organizationID: organizationID) }
                catch is CancellationError { throw CancellationError() }
                catch { failures.append(file.fileName) }
                completed += 1
            }
            for sheet in sheets {
                try Task.checkCancellation()
                guard requestedScope == runScope else { return }
                currentName = "\(sheet.sheetNumber) \(sheet.sheetTitle ?? "")"
                do { try await dependencies.drawings.download(sheetID: sheet.id, projectID: project.id, organizationID: organizationID) }
                catch is CancellationError { throw CancellationError() }
                catch { failures.append(currentName) }
                completed += 1
            }
            guard !Task.isCancelled, requestedScope == runScope else { return }
            if failures.isEmpty {
                let result = SavedDownload(date: .now, documents: files.count, drawings: sheets.count)
                try requestedCache.write(result, key: "offline-project/\(project.id)")
                saved = result
            }
        } catch is CancellationError {
        } catch {
            guard requestedScope == runScope else { return }
            errorMessage = (error as? APIError)?.userMessage ?? "The download could not finish. Saved files are still available; reconnect and try again."
        }
    }
}

extension View {
    func projectOfflineDownload(project: MobileProject) -> some View {
        toolbar {
            ToolbarItem(placement: .secondaryAction) {
                NavigationLink {
                    ProjectOfflineDownloadView(project: project)
                } label: { Label("Offline Project", systemImage: "arrow.down.circle") }
            }
        }
    }
}
