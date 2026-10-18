import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct NativeAttachmentComposer: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss
    let module: MobileWorkspaceModule
    let recordID: String
    let projectID: String
    let onSaved: () -> Void
    @State private var fileURL: URL?
    @State private var fileName = ""
    @State private var mimeType = "application/octet-stream"
    @State private var clientID = UUID().uuidString
    @State private var uploadedFileID: String?
    @State private var photo: PhotosPickerItem?
    @State private var showFiles = false
    @State private var showCamera = false
    @State private var saving = false
    @State private var preparing = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Attachment") {
                    Button("Take Photo", systemImage: "camera") { showCamera = true }
                    PhotosPicker(selection: $photo, matching: .images) { Label("Choose Photo", systemImage: "photo") }
                    Button("Choose Document", systemImage: "doc") { showFiles = true }
                    if !fileName.isEmpty { Label(fileName, systemImage: "paperclip") }
                    if preparing { ProgressView("Preparing attachment…") }
                }.disabled(saving || preparing || uploadedFileID != nil)
                if uploadedFileID != nil {
                    Text("The file is uploaded. Tap Attach to finish linking it to this item.").font(.caption).foregroundStyle(.secondary)
                }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            }
            .navigationTitle("Add Attachment")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving || preparing) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Attaching…" : "Attach") { Task { await save() } }.disabled(fileURL == nil || saving || preparing)
                }
            }
            .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item]) { result in
                do {
                    let source = try result.get()
                    let access = source.startAccessingSecurityScopedResource()
                    defer { if access { source.stopAccessingSecurityScopedResource() } }
                    let attributes = try source.resourceValues(forKeys: [.fileSizeKey, .isDirectoryKey])
                    guard attributes.isDirectory != true, (attributes.fileSize ?? 0) <= 100 * 1024 * 1024 else {
                        errorMessage = "Choose a file smaller than 100 MB."
                        return
                    }
                    let directory = try temporaryDirectory()
                    let destination = directory.appendingPathComponent(source.lastPathComponent)
                    try FileManager.default.copyItem(at: source, to: destination)
                    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
                    replaceFile(destination, name: source.lastPathComponent, type: UTType(filenameExtension: source.pathExtension)?.preferredMIMEType ?? "application/octet-stream")
                } catch { errorMessage = "This document could not be prepared." }
            }
            .fullScreenCover(isPresented: $showCamera) {
                FieldCameraPicker(onCapture: { data in
                    showCamera = false
                    preparePhoto(data)
                }, onCancel: { showCamera = false })
            }
            .task(id: photo) {
                guard let photo else { return }
                preparing = true
                defer { preparing = false }
                do {
                    guard let data = try await photo.loadTransferable(type: Data.self) else { throw APIError.invalidResponse }
                    try Task.checkCancellation()
                    preparePhoto(data, type: photo.supportedContentTypes.first)
                } catch is CancellationError {
                } catch { errorMessage = "This photo could not be prepared." }
            }
            .interactiveDismissDisabled(saving || preparing)
            .onChange(of: dependencies.workspace.selectedOrganizationID) { _, _ in dismiss() }
            .onDisappear { if !showCamera { removeTemporaryFile() } }
        }
    }

    private func temporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ArcAttachment-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
    private func preparePhoto(_ data: Data, type: UTType? = .jpeg) {
        do {
            let directory = try temporaryDirectory()
            let name = "Photo.\(type?.preferredFilenameExtension ?? "jpg")"
            let destination = directory.appendingPathComponent(name)
            try data.write(to: destination, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            replaceFile(destination, name: name, type: type?.preferredMIMEType ?? "image/jpeg")
        } catch { errorMessage = "The photo could not be saved on this device." }
    }
    private func replaceFile(_ url: URL, name: String, type: String) {
        removeTemporaryFile()
        fileURL = url
        fileName = name
        mimeType = type
        clientID = UUID().uuidString
        uploadedFileID = nil
        errorMessage = nil
    }
    private func removeTemporaryFile() {
        if let fileURL { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
    }
    private func save() async {
        guard let fileURL, let organizationID = dependencies.workspace.selectedOrganizationID else { return }
        let userID = dependencies.session.userID
        saving = true
        errorMessage = nil
        defer { saving = false }
        do {
            if uploadedFileID == nil {
                let file = try await dependencies.mobileAPI.uploadFile(fileURL: fileURL, fileName: fileName, mimeType: mimeType,
                    clientID: clientID, folder: "/Field Attachments", category: "other", projectID: projectID,
                    organizationID: organizationID, downscalesImages: mimeType.hasPrefix("image/"))
                guard dependencies.session.userID == userID, dependencies.workspace.selectedOrganizationID == organizationID else { return }
                uploadedFileID = file.id
            }
            guard let uploadedFileID else { return }
            try await dependencies.mobileAPI.performWorkspaceAction(moduleID: module.id, recordID: recordID, projectID: projectID,
                actionID: "attach-file", expectedRevision: nil, values: ["file_id": uploadedFileID], organizationID: organizationID)
            guard dependencies.session.userID == userID, dependencies.workspace.selectedOrganizationID == organizationID else { return }
            onSaved()
            dismiss()
        } catch {
            errorMessage = (error as? APIError)?.userMessage ?? "The attachment could not be completed. Retry to finish attaching this file."
        }
    }
}
