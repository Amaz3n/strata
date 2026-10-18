import SwiftUI
import PhotosUI
import AVKit
import UniformTypeIdentifiers

struct MobileProjectPhoto: Decodable, Identifiable, Sendable {
    let id: String
    let fileName: String
    let mediaKind: String
    let takenAt: String
    let thumbnailUrl: URL
    let downloadUrl: URL
    let aiCaption: String?
    let locations: [String]
}
struct MobilePhotoAlbum: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let photoCount: Int
}
struct MobilePhotoPage: Decodable, Sendable {
    let photos: [MobileProjectPhoto]
    let albums: [MobilePhotoAlbum]
    let nextCursor: String?
    let canUpload: Bool?
}

struct ProjectPhotosView: View {
    @Environment(AppDependencies.self) private var dependencies
    let project: MobileProject
    @State private var photos: [MobileProjectPhoto] = []
    @State private var albums: [MobilePhotoAlbum] = []
    @State private var albumID = ""
    @State private var query = ""
    @State private var cursor: String?
    @State private var loading = false
    @State private var uploading = false
    @State private var canUpload = false
    @State private var errorMessage: String?
    @State private var selectedPhoto: MobileProjectPhoto?
    @State private var pickedPhotos: [PhotosPickerItem] = []
    private var scope: String { "\(dependencies.workspace.selectedOrganizationID ?? "")/\(project.id)/\(albumID)/\(query)" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if uploading { ProgressView("Adding photos to today’s log…") }
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.secondary)
                    Button("Try Again") { Task { await load(reset: true) } }
                }
                if !loading && photos.isEmpty && errorMessage == nil {
                    ContentUnavailableView("No photos", systemImage: "photo.on.rectangle", description: Text("Add site photos or choose a different album."))
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 12)], spacing: 16) {
                    ForEach(photos) { photo in
                        Button { selectedPhoto = photo } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                ZStack {
                                    Rectangle().fill(.quaternary)
                                    if photo.mediaKind == "video" {
                                        Image(systemName: "play.rectangle.fill").font(.largeTitle)
                                    } else {
                                        AsyncImage(url: photo.thumbnailUrl) { image in image.resizable().scaledToFill() } placeholder: { ProgressView() }
                                    }
                                }.frame(height: 150).clipped().clipShape(RoundedRectangle(cornerRadius: 12))
                                Text(photo.aiCaption ?? photo.fileName).font(.subheadline).lineLimit(2)
                                Text(MobileDateParser.display(photo.takenAt) ?? photo.takenAt).font(.caption).foregroundStyle(.secondary)
                            }
                        }.buttonStyle(.plain)
                    }
                }
                if loading { ProgressView().frame(maxWidth: .infinity) }
                if cursor != nil && !loading { Button("Load More") { Task { await load(reset: false) } }.frame(maxWidth: .infinity) }
            }.padding()
        }
        .navigationTitle("Photos")
        .searchable(text: $query, prompt: "Search photos")
        .toolbar {
            ToolbarItem {
                Menu {
                    Picker("Album", selection: $albumID) {
                        Text("All photos").tag("")
                        ForEach(albums) { Text("\($0.name) (\($0.photoCount))").tag($0.id) }
                    }
                } label: { Label("Albums", systemImage: "rectangle.stack") }
            }
            if canUpload { ToolbarItem {
                PhotosPicker(selection: $pickedPhotos, maxSelectionCount: 20, matching: .images) {
                    Label("Add Photos", systemImage: "plus")
                }.disabled(uploading)
            } }
        }
        .task(id: scope) {
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            await load(reset: true)
        }
        .refreshable { await load(reset: true) }
        .onChange(of: pickedPhotos) { _, items in
            guard !items.isEmpty else { return }
            Task { await upload(items) }
        }
        .sheet(item: $selectedPhoto) { photo in
            ProjectPhotoViewer(photo: photo)
        }
    }

    private func load(reset: Bool) async {
        guard let organizationID = dependencies.workspace.selectedOrganizationID else { return }
        let requestedScope = scope
        if reset { photos = []; cursor = nil }
        loading = true
        errorMessage = nil
        defer { if requestedScope == scope { loading = false } }
        do {
            let page = try await dependencies.mobileAPI.loadProjectPhotos(projectID: project.id, organizationID: organizationID, cursor: reset ? nil : cursor, albumID: albumID, search: query)
            guard requestedScope == scope, !Task.isCancelled else { return }
            let existingIDs = Set(photos.map(\.id))
            photos += page.photos.filter { !existingIDs.contains($0.id) }
            canUpload = page.canUpload == true
            albums = page.albums
            cursor = page.nextCursor
        } catch {
            guard requestedScope == scope, !Task.isCancelled else { return }
            errorMessage = (error as? APIError)?.userMessage ?? "Photos could not be loaded."
        }
    }

    private func upload(_ items: [PhotosPickerItem]) async {
        guard let organizationID = dependencies.workspace.selectedOrganizationID else { return }
        let requestedUserID = dependencies.session.userID
        uploading = true
        defer { uploading = false; pickedPhotos = [] }
        do {
            let logID = try await dependencies.mobileAPI.ensurePhotoLog(projectID: project.id, organizationID: organizationID)
            for item in items {
                guard !Task.isCancelled, dependencies.session.userID == requestedUserID,
                      dependencies.workspace.selectedOrganizationID == organizationID else { return }
                guard let data = try await item.loadTransferable(type: Data.self) else { throw APIError.invalidResponse }
                guard !Task.isCancelled, dependencies.session.userID == requestedUserID,
                      dependencies.workspace.selectedOrganizationID == organizationID else { return }
                let type = item.supportedContentTypes.first ?? .jpeg
                let name = "Site Photo \(UUID().uuidString).\(type.preferredFilenameExtension ?? "jpg")"
                let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
                try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                defer { try? FileManager.default.removeItem(at: url) }
                _ = try await dependencies.mobileAPI.uploadDailyLogPhoto(fileURL: url, fileName: name, mimeType: type.preferredMIMEType ?? "image/jpeg", clientID: UUID(), projectID: project.id, dailyLogID: logID, organizationID: organizationID)
            }
            guard dependencies.session.userID == requestedUserID,
                  dependencies.workspace.selectedOrganizationID == organizationID else { return }
            if !albumID.isEmpty || !query.isEmpty { albumID = ""; query = "" } else { await load(reset: true) }
        } catch {
            guard dependencies.session.userID == requestedUserID,
                  dependencies.workspace.selectedOrganizationID == organizationID else { return }
            errorMessage = (error as? APIError)?.userMessage ?? "Some photos could not be uploaded. Check the timeline before retrying."
        }
    }
}

private struct ProjectPhotoViewer: View {
    @Environment(\.dismiss) private var dismiss
    let photo: MobileProjectPhoto
    @State private var player: AVPlayer?
    var body: some View {
        NavigationStack {
            Group {
                if photo.mediaKind == "video" {
                    VideoPlayer(player: player)
                        .onAppear { player = AVPlayer(url: photo.downloadUrl) }
                        .onDisappear { player?.pause(); player = nil }
                } else {
                    DrawingZoomableImage(imageURL: photo.downloadUrl, aspectRatio: nil, pins: [], onSelectPin: { _ in })
                }
            }
            .background(.black)
            .navigationTitle(photo.fileName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
