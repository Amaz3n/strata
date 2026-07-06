import PhotosUI
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

struct ProjectDocumentsView: View {
    let project: MobileProject

    var body: some View {
        DocumentsFolderView(project: project, folder: "/", title: "Documents")
    }
}

private struct DocumentsFolderView: View {
    @Environment(AppDependencies.self) private var dependencies
    let project: MobileProject
    let folder: String
    let title: String

    @AppStorage("documents.gridLayout") private var isGrid = false
    @State private var contents: MobileFiles?
    @State private var isLoading = false
    @State private var errorMessage: String?

    @State private var galleryStart: MobileFile?
    @State private var sharePayload: SharePayload?
    @State private var pendingDelete: MobileFile?
    @State private var showFileImporter = false
    @State private var showPhotoPicker = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var uploadingCount = 0
    @State private var banner: String?

    private var store: DocumentsStore { dependencies.documents }
    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }
    private var previewableFiles: [MobileFile] { (contents?.files ?? []).filter { $0.downloadUrl != nil } }

    var body: some View {
        browser
            .fullScreenCover(item: $galleryStart) { start in
                FileGalleryView(files: previewableFiles, start: start, store: store)
            }
            .sheet(item: $sharePayload) { payload in
                ShareSheet(items: [payload.url])
            }
            .fileImporter(
                isPresented: $showFileImporter,
                allowedContentTypes: [.item],
                allowsMultipleSelection: true
            ) { result in handleImport(result) }
            .photosPicker(isPresented: $showPhotoPicker, selection: $photoItems, matching: .images)
            .onChange(of: photoItems) { _, items in
                guard !items.isEmpty else { return }
                Task { await handlePhotos(items) }
            }
            .confirmationDialog(
                "Delete this file?",
                isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                presenting: pendingDelete
            ) { file in
                Button("Delete", role: .destructive) { delete(file) }
                Button("Cancel", role: .cancel) {}
            } message: { file in Text(file.fileName) }
            .overlay(alignment: .bottom) { statusOverlay }
    }

    private var browser: some View {
        content
            .background(Color(.systemGroupedBackground))
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .projectSwitcherPullOrRefresh { await load() }
            .task { await load() }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading && contents == nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorMessage, contents == nil {
            ContentUnavailableView {
                Label("Documents unavailable", systemImage: "folder.badge.questionmark")
            } description: { Text(errorMessage) } actions: {
                Button("Try Again") { Task { await load() } }.buttonStyle(.borderedProminent)
            }
        } else if let contents, contents.folders.isEmpty && contents.files.isEmpty {
            emptyState
        } else if isGrid {
            gridContent
        } else {
            listContent
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Picker("View", selection: $isGrid) {
                    Label("List", systemImage: "list.bullet").tag(false)
                    Label("Grid", systemImage: "square.grid.2x2").tag(true)
                }
            } label: {
                Image(systemName: isGrid ? "square.grid.2x2" : "list.bullet")
            }
            .accessibilityIdentifier("documents-layout")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button { showFileImporter = true } label: { Label("Choose Files", systemImage: "folder") }
                Button { showPhotoPicker = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
            } label: {
                Image(systemName: "plus.circle.fill")
            }
            .accessibilityIdentifier("documents-add")
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("Empty folder", systemImage: "folder")
        } description: {
            Text("Upload files with the + button, or drop them in from the web.")
        } actions: {
            Button { showFileImporter = true } label: { Label("Upload Files", systemImage: "arrow.up.doc") }
                .buttonStyle(.borderedProminent)
        }
    }

    // MARK: - List

    private var listContent: some View {
        List {
            if let contents, !contents.folders.isEmpty {
                Section("Folders") {
                    ForEach(contents.folders) { subfolder in
                        NavigationLink {
                            DocumentsFolderView(project: project, folder: subfolder.path, title: subfolder.name)
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "folder.fill").foregroundStyle(.tint).frame(width: 28)
                                Text(subfolder.name)
                                Spacer()
                                Text("\(subfolder.fileCount)").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            if let contents, !contents.files.isEmpty {
                Section("Files") {
                    ForEach(contents.files) { file in
                        Button { open(file) } label: { FileRow(file: file, store: store) }
                            .buttonStyle(.plain)
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) { pendingDelete = file } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                            .swipeActions(edge: .leading) {
                                Button { share(file) } label: { Label("Share", systemImage: "square.and.arrow.up") }
                                    .tint(.blue)
                            }
                            .contextMenu { fileMenu(file) }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Grid

    private var gridContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let contents, !contents.folders.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        ArcSectionHeader(title: "Folders")
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
                            ForEach(contents.folders) { subfolder in
                                NavigationLink {
                                    DocumentsFolderView(project: project, folder: subfolder.path, title: subfolder.name)
                                } label: { FolderCard(folder: subfolder) }
                                    .buttonStyle(.plain)
                            }
                        }
                    }
                }
                if let contents, !contents.files.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        ArcSectionHeader(title: "Files")
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 12)], spacing: 16) {
                            ForEach(contents.files) { file in
                                Button { open(file) } label: { FileGridCard(file: file, store: store) }
                                    .buttonStyle(.plain)
                                    .contextMenu { fileMenu(file) }
                            }
                        }
                    }
                }
            }
            .padding()
        }
    }

    @ViewBuilder
    private func fileMenu(_ file: MobileFile) -> some View {
        Button { open(file) } label: { Label("Quick Look", systemImage: "eye") }
        Button { share(file) } label: { Label("Share", systemImage: "square.and.arrow.up") }
        Divider()
        Button(role: .destructive) { pendingDelete = file } label: { Label("Delete", systemImage: "trash") }
    }

    @ViewBuilder
    private var statusOverlay: some View {
        VStack(spacing: 8) {
            if uploadingCount > 0 {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Uploading \(uploadingCount) file\(uploadingCount == 1 ? "" : "s")…").font(.subheadline)
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(.ultraThinMaterial, in: Capsule())
                .shadow(radius: 8, y: 2)
            }
            if let banner {
                Text(banner)
                    .font(.subheadline)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .shadow(radius: 8, y: 2)
                    .task(id: banner) {
                        try? await Task.sleep(for: .seconds(3))
                        self.banner = nil
                    }
            }
        }
        .padding(.bottom, 16)
        .animation(.snappy, value: uploadingCount)
        .animation(.snappy, value: banner)
    }

    // MARK: - Actions

    private func open(_ file: MobileFile) {
        guard file.downloadUrl != nil else { banner = "This file isn't ready to view yet."; return }
        galleryStart = file
    }

    private func share(_ file: MobileFile) {
        Task {
            do {
                let url = try await store.ensureLocal(file)
                sharePayload = SharePayload(url: url)
            } catch {
                banner = (error as? APIError)?.userMessage ?? "Couldn't prepare the file to share."
            }
        }
    }

    private func delete(_ file: MobileFile) {
        guard let organizationID else { return }
        if let contents {
            self.contents = MobileFiles(folders: contents.folders, files: contents.files.filter { $0.id != file.id })
        }
        Task {
            do {
                try await store.delete(file, projectID: project.id, organizationID: organizationID)
                await load()
            } catch {
                banner = (error as? APIError)?.userMessage ?? "The file could not be deleted."
                await load()
            }
        }
    }

    private func handleImport(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            banner = error.localizedDescription
        case .success(let urls):
            for url in urls {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let name = url.lastPathComponent
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                let temp = FileManager.default.temporaryDirectory
                    .appendingPathComponent("arc-upload-\(UUID().uuidString)-\(name)")
                do {
                    try? FileManager.default.removeItem(at: temp)
                    try FileManager.default.copyItem(at: url, to: temp)
                } catch {
                    banner = "Couldn't read \(name)."
                    continue
                }
                startUpload(tempURL: temp, fileName: name, mimeType: mime)
            }
        }
    }

    private func handlePhotos(_ items: [PhotosPickerItem]) async {
        defer { photoItems = [] }
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let type = item.supportedContentTypes.first
            let ext = type?.preferredFilenameExtension ?? "jpg"
            let mime = type?.preferredMIMEType ?? "image/jpeg"
            let name = "photo-\(UUID().uuidString.prefix(8)).\(ext)"
            let temp = FileManager.default.temporaryDirectory.appendingPathComponent("arc-upload-\(name)")
            do {
                try data.write(to: temp, options: .atomic)
            } catch { continue }
            startUpload(tempURL: temp, fileName: name, mimeType: mime)
        }
    }

    private func startUpload(tempURL: URL, fileName: String, mimeType: String) {
        guard let organizationID else { return }
        uploadingCount += 1
        Task {
            defer {
                uploadingCount -= 1
                try? FileManager.default.removeItem(at: tempURL)
            }
            do {
                _ = try await store.upload(
                    fileURL: tempURL,
                    fileName: fileName,
                    mimeType: mimeType,
                    folder: folder,
                    projectID: project.id,
                    organizationID: organizationID
                )
                await load()
            } catch {
                banner = (error as? APIError)?.userMessage ?? "“\(fileName)” failed to upload."
            }
        }
    }

    private func load() async {
        guard let organizationID else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            contents = try await store.contents(projectID: project.id, folder: folder, organizationID: organizationID)
            errorMessage = nil
        } catch {
            if contents == nil {
                errorMessage = (error as? APIError)?.userMessage ?? "Documents could not be loaded."
            }
        }
    }
}

private struct SharePayload: Identifiable {
    let id = UUID()
    let url: URL
}

// MARK: - Rows & cards

private struct FileRow: View {
    let file: MobileFile
    let store: DocumentsStore

    var body: some View {
        HStack(spacing: 12) {
            FileThumbnail(file: file, store: store, size: 44, cornerRadius: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.fileName).foregroundStyle(.primary).lineLimit(2)
                HStack(spacing: 8) {
                    if let size = file.sizeText {
                        Text(size).font(.caption).foregroundStyle(.secondary)
                    }
                    if let category = file.category, !category.isEmpty {
                        Text(category.capitalized).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer()
            if file.downloadUrl == nil {
                Image(systemName: "exclamationmark.icloud").font(.caption).foregroundStyle(.tertiary)
            } else {
                Image(systemName: "chevron.right").font(.caption.bold()).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}

private struct FileGridCard: View {
    let file: MobileFile
    let store: DocumentsStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            FileThumbnail(file: file, store: store, size: nil, cornerRadius: 12)
                .aspectRatio(1, contentMode: .fit)
                .frame(maxWidth: .infinity)
            Text(file.fileName)
                .font(.caption)
                .foregroundStyle(.primary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let size = file.sizeText {
                Text(size).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}

private struct FolderCard: View {
    let folder: MobileFolder

    var body: some View {
        ArcCard(padding: 14) {
            HStack(spacing: 12) {
                Image(systemName: "folder.fill")
                    .font(.title2)
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(folder.name).font(.subheadline.weight(.medium)).lineLimit(1)
                    Text("\(folder.fileCount) item\(folder.fileCount == 1 ? "" : "s")")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
        }
    }
}

private struct FileThumbnail: View {
    let file: MobileFile
    let store: DocumentsStore
    let size: CGFloat?
    var cornerRadius: CGFloat = 8

    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                Rectangle().fill(file.kindTint.opacity(0.14))
                Image(systemName: file.systemImage)
                    .font(size.map { .system(size: $0 * 0.42) } ?? .title)
                    .foregroundStyle(file.kindTint)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.06))
        )
        .task(id: file.id) {
            if let cached = store.cachedThumbnail(for: file) { image = cached; return }
            image = await store.thumbnail(for: file)
        }
    }
}

extension MobileFile {
    var kindTint: Color {
        if isImage { return .blue }
        let name = fileName.lowercased()
        if name.hasSuffix(".pdf") { return .red }
        if name.hasSuffix(".doc") || name.hasSuffix(".docx") { return .indigo }
        if name.hasSuffix(".xls") || name.hasSuffix(".xlsx") || name.hasSuffix(".csv") { return .green }
        if name.hasSuffix(".zip") { return .orange }
        return .secondary
    }
}

// MARK: - Share sheet

private struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

// MARK: - Swipeable QuickLook gallery

private struct FileGalleryView: View {
    @Environment(\.dismiss) private var dismiss
    let files: [MobileFile]
    let start: MobileFile
    let store: DocumentsStore

    @State private var ready = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if ready {
                QuickLookGallery(
                    files: files,
                    startIndex: files.firstIndex(of: start) ?? 0,
                    store: store,
                    onDismiss: { dismiss() }
                )
                .ignoresSafeArea()
            } else {
                ProgressView().tint(.white)
            }
        }
        .task {
            try? await store.ensureLocal(start)
            ready = true
        }
    }
}

private struct QuickLookGallery: UIViewControllerRepresentable {
    let files: [MobileFile]
    let startIndex: Int
    let store: DocumentsStore
    let onDismiss: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIViewController(context: Context) -> UINavigationController {
        let preview = QLPreviewController()
        preview.dataSource = context.coordinator
        preview.delegate = context.coordinator
        preview.currentPreviewItemIndex = startIndex
        preview.navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done,
            target: context.coordinator,
            action: #selector(Coordinator.done)
        )
        context.coordinator.preview = preview
        return UINavigationController(rootViewController: preview)
    }

    func updateUIViewController(_ controller: UINavigationController, context: Context) {}

    final class Coordinator: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
        private let parent: QuickLookGallery
        weak var preview: QLPreviewController?
        private var downloading: Set<String> = []

        init(_ parent: QuickLookGallery) { self.parent = parent }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { parent.files.count }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            let file = parent.files[index]
            let url = parent.store.localURL(for: file)
            if !FileManager.default.fileExists(atPath: url.path) { download(file, at: index) }
            return GalleryPreviewItem(url: url, title: file.fileName)
        }

        // QuickLook prefetches neighbours by calling previewItemAt:, so this only
        // pulls what the user is actually viewing — not the whole folder.
        private func download(_ file: MobileFile, at index: Int) {
            guard !downloading.contains(file.id) else { return }
            downloading.insert(file.id)
            Task { @MainActor in
                _ = try? await parent.store.ensureLocal(file)
                downloading.remove(file.id)
                guard let preview else { return }
                let current = preview.currentPreviewItemIndex
                preview.reloadData()
                preview.currentPreviewItemIndex = current
            }
        }

        @objc func done() { parent.onDismiss() }
    }
}

private final class GalleryPreviewItem: NSObject, QLPreviewItem {
    let previewItemURL: URL?
    let previewItemTitle: String?

    init(url: URL, title: String) {
        previewItemURL = url
        previewItemTitle = title
    }
}
