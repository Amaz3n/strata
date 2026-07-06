import SwiftUI
import UIKit

struct DrawingSheetViewerView: View {
    private enum Presentation: String, Identifiable {
        case versions, pins, info
        var id: Self { self }
    }

    @Environment(AppDependencies.self) private var dependencies
    @State private var detail: MobileDrawingSheetDetail?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var presentation: Presentation?
    @State private var selectedPin: MobileDrawingPin?
    @State private var showsPins = true
    let project: MobileProject
    let sheetID: String

    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }
    private var sheet: MobileDrawingSheet? { detail?.sheet ?? dependencies.drawings.sheet(for: sheetID) }
    private var pins: [MobileDrawingPin] { detail?.pins ?? [] }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let sheet {
                DrawingZoomableImage(
                    imageURL: sheet.imageUrl ?? sheet.thumbnailUrl,
                    aspectRatio: sheet.aspectRatio,
                    pins: showsPins ? pins : [],
                    onSelectPin: { selectedPin = $0 }
                )
            }

            if isLoading && detail == nil {
                ProgressView().tint(.white)
            }

            if let errorMessage, detail == nil, sheet?.imageUrl == nil {
                ContentUnavailableView {
                    Label("Couldn't load sheet", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button("Try Again") { Task { await load() } }
                        .buttonStyle(.borderedProminent)
                }
                .padding()
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
                .padding()
            }
        }
        .navigationTitle(sheet?.sheetNumber ?? "Sheet")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    if !pins.isEmpty {
                        Toggle(isOn: $showsPins) { Label("Show Pins", systemImage: "mappin") }
                        Button { presentation = .pins } label: {
                            Label("Pins (\(pins.count))", systemImage: "mappin.and.ellipse")
                        }
                    }
                    if let count = detail?.versions.count, count > 1 {
                        Button { presentation = .versions } label: {
                            Label("Version History (\(count))", systemImage: "clock.arrow.circlepath")
                        }
                    }
                    Button { presentation = .info } label: {
                        Label("Sheet Info", systemImage: "info.circle")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .task(id: sheetID) { await load() }
        .sheet(item: $presentation) { which in
            switch which {
            case .versions:
                DrawingVersionsSheet(sheet: sheet, versions: detail?.versions ?? [])
            case .pins:
                DrawingPinsListSheet(pins: pins) { pin in
                    presentation = nil
                    selectedPin = pin
                }
            case .info:
                DrawingSheetInfoSheet(sheet: sheet, versionCount: detail?.versions.count ?? sheet?.versionCount ?? 0)
            }
        }
        .sheet(item: $selectedPin) { pin in
            DrawingPinDetailSheet(pin: pin)
        }
    }

    private func load() async {
        guard let organizationID else { return }
        if let cached = dependencies.drawings.cachedDetail(for: sheetID) {
            detail = cached
        }
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil
        do {
            detail = try await dependencies.drawings.loadDetail(
                sheetID: sheetID,
                projectID: project.id,
                organizationID: organizationID
            )
        } catch is CancellationError {
        } catch {
            errorMessage = (error as? APIError)?.userMessage ?? "This sheet could not be loaded."
        }
    }
}

// MARK: - Zoomable image with pin overlay

struct DrawingZoomableImage: View {
    let imageURL: URL?
    let aspectRatio: CGFloat?
    let pins: [MobileDrawingPin]
    let onSelectPin: (MobileDrawingPin) -> Void

    @State private var scale: CGFloat = 1
    @GestureState private var gestureScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @GestureState private var gestureOffset: CGSize = .zero

    private let minScale: CGFloat = 1
    private let maxScale: CGFloat = 7

    private var effectiveScale: CGFloat { min(max(scale * gestureScale, minScale * 0.8), maxScale) }

    var body: some View {
        GeometryReader { geo in
            let fitted = fittedSize(in: geo.size)
            ZStack {
                AsyncImage(url: imageURL) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFit()
                    case .empty:
                        ProgressView().tint(.white)
                    default:
                        Image(systemName: "exclamationmark.triangle")
                            .font(.largeTitle)
                            .foregroundStyle(.white.opacity(0.5))
                    }
                }
                .frame(width: fitted.width, height: fitted.height)

                ForEach(pins) { pin in
                    PinMarker(pin: pin)
                        .scaleEffect(1 / effectiveScale)
                        .position(
                            x: CGFloat(pin.xPosition) * fitted.width,
                            y: CGFloat(pin.yPosition) * fitted.height
                        )
                        .onTapGesture { onSelectPin(pin) }
                }
            }
            .frame(width: fitted.width, height: fitted.height)
            .scaleEffect(effectiveScale)
            .offset(x: offset.width + gestureOffset.width, y: offset.height + gestureOffset.height)
            .frame(width: geo.size.width, height: geo.size.height)
            .contentShape(Rectangle())
            .gesture(
                MagnificationGesture()
                    .updating($gestureScale) { value, state, _ in state = value }
                    .onEnded { value in
                        scale = min(max(scale * value, minScale), maxScale)
                        if scale <= minScale { withAnimation(.spring) { offset = .zero } }
                    }
            )
            .simultaneousGesture(
                DragGesture()
                    .updating($gestureOffset) { value, state, _ in
                        guard effectiveScale > minScale else { return }
                        state = value.translation
                    }
                    .onEnded { value in
                        guard effectiveScale > minScale else { return }
                        offset.width += value.translation.width
                        offset.height += value.translation.height
                    }
            )
            .onTapGesture(count: 2) {
                withAnimation(.spring) {
                    if scale > minScale {
                        scale = minScale
                        offset = .zero
                    } else {
                        scale = 3
                    }
                }
            }
        }
    }

    private func fittedSize(in container: CGSize) -> CGSize {
        let ratio = aspectRatio ?? 1.294 // sensible default for a landscape sheet
        let widthConstrained = CGSize(width: container.width, height: container.width / ratio)
        if widthConstrained.height <= container.height {
            return widthConstrained
        }
        return CGSize(width: container.height * ratio, height: container.height)
    }
}

private struct PinMarker: View {
    let pin: MobileDrawingPin

    var body: some View {
        Image(systemName: DrawingPinAppearance.symbol(for: pin.entityType))
            .font(.title2)
            .symbolRenderingMode(.palette)
            .foregroundStyle(.white, pinColor)
            .background(
                Circle().fill(.white).frame(width: 12, height: 12).offset(y: 1)
            )
            .shadow(color: .black.opacity(0.4), radius: 2, y: 1)
            .accessibilityLabel(DrawingPinAppearance.typeLabel(for: pin.entityType))
    }

    private var pinColor: Color {
        switch pin.status {
        case "closed", "approved", "completed": .green
        case "in_progress": .blue
        default: .orange
        }
    }
}

// MARK: - Pin detail

private struct DrawingPinDetailSheet: View {
    @Environment(\.dismiss) private var dismiss
    let pin: MobileDrawingPin

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label(DrawingPinAppearance.typeLabel(for: pin.entityType),
                          systemImage: DrawingPinAppearance.symbol(for: pin.entityType))
                        .font(.headline)
                    if let title = pin.entityTitle ?? pin.label {
                        Text(title)
                    }
                }
                if let status = pin.entityStatus ?? pin.status {
                    Section("Status") {
                        Text(status.replacingOccurrences(of: "_", with: " ").capitalized)
                    }
                }
            }
            .navigationTitle("Pin")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium])
    }
}

// MARK: - Pins list

private struct DrawingPinsListSheet: View {
    @Environment(\.dismiss) private var dismiss
    let pins: [MobileDrawingPin]
    let onSelect: (MobileDrawingPin) -> Void

    var body: some View {
        NavigationStack {
            List {
                ForEach(pins) { pin in
                    Button {
                        onSelect(pin)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: DrawingPinAppearance.symbol(for: pin.entityType))
                                .foregroundStyle(.tint)
                                .frame(width: 26)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(pin.entityTitle ?? pin.label ?? DrawingPinAppearance.typeLabel(for: pin.entityType))
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Text(DrawingPinAppearance.typeLabel(for: pin.entityType))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if let status = pin.entityStatus ?? pin.status {
                                Text(status.replacingOccurrences(of: "_", with: " ").capitalized)
                                    .font(.caption2.weight(.medium))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(Color(.secondarySystemBackground), in: Capsule())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .navigationTitle("Pins")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }
}

// MARK: - Version history (with compare)

private struct DrawingVersionsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let sheet: MobileDrawingSheet?
    let versions: [MobileDrawingSheetVersion]
    @State private var compareVersion: MobileDrawingSheetVersion?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(Array(versions.enumerated()), id: \.element.id) { index, version in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 10) {
                                DrawingThumbnail(url: version.thumbnailUrl ?? version.imageUrl, discipline: sheet?.disciplineKey ?? "X")
                                    .frame(width: 64, height: 48)
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack(spacing: 6) {
                                        Text(version.revisionLabel ?? "Version")
                                            .font(.subheadline.weight(.semibold))
                                        if index == 0 {
                                            Text("Current")
                                                .font(.caption2.weight(.bold))
                                                .padding(.horizontal, 6).padding(.vertical, 2)
                                                .background(Color.green.opacity(0.18), in: Capsule())
                                                .foregroundStyle(.green)
                                        }
                                    }
                                    Text(version.createdAt.formatted(date: .abbreviated, time: .shortened))
                                        .font(.caption).foregroundStyle(.secondary)
                                    if let creator = version.creatorName {
                                        Text(creator).font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                            }
                            if let note = version.changeDescription, !note.isEmpty {
                                Text(note).font(.caption).foregroundStyle(.secondary)
                            }
                            if index != 0 {
                                Button {
                                    compareVersion = version
                                } label: {
                                    Label("Compare with current", systemImage: "rectangle.split.2x1")
                                        .font(.caption.weight(.medium))
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                } header: {
                    Text("\(versions.count) version\(versions.count == 1 ? "" : "s")")
                }
            }
            .navigationTitle("Version History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .fullScreenCover(item: $compareVersion) { version in
                if let current = versions.first {
                    DrawingCompareView(current: current, previous: version, sheet: sheet)
                }
            }
        }
    }
}

private struct DrawingCompareView: View {
    @Environment(\.dismiss) private var dismiss
    let current: MobileDrawingSheetVersion
    let previous: MobileDrawingSheetVersion
    let sheet: MobileDrawingSheet?

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                let isWide = geo.size.width > geo.size.height
                let stack = isWide
                    ? AnyLayout(HStackLayout(spacing: 2))
                    : AnyLayout(VStackLayout(spacing: 2))
                stack {
                    ComparePane(title: previous.revisionLabel ?? "Previous", url: previous.imageUrl, aspect: sheet?.aspectRatio)
                    ComparePane(title: current.revisionLabel ?? "Current", url: current.imageUrl, aspect: sheet?.aspectRatio, isCurrent: true)
                }
            }
            .background(Color.black)
            .ignoresSafeArea(edges: .bottom)
            .navigationTitle("Compare")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
            }
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }
}

private struct ComparePane: View {
    let title: String
    let url: URL?
    let aspect: CGFloat?
    var isCurrent = false

    var body: some View {
        ZStack(alignment: .top) {
            DrawingZoomableImage(imageURL: url, aspectRatio: aspect, pins: [], onSelectPin: { _ in })
                .background(Color.black)
            Text(title)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(isCurrent ? Color.green.opacity(0.85) : Color.black.opacity(0.6), in: Capsule())
                .foregroundStyle(.white)
                .padding(.top, 8)
        }
    }
}

// MARK: - Sheet info

private struct DrawingSheetInfoSheet: View {
    @Environment(\.dismiss) private var dismiss
    let sheet: MobileDrawingSheet?
    let versionCount: Int

    var body: some View {
        NavigationStack {
            List {
                if let sheet {
                    Section {
                        LabeledContent("Sheet Number", value: sheet.sheetNumber)
                        if let title = sheet.sheetTitle { LabeledContent("Title", value: title) }
                        LabeledContent("Discipline", value: DrawingDisciplinePalette.label(for: sheet.disciplineKey))
                        if let set = sheet.setTitle { LabeledContent("Set", value: set) }
                    }
                    Section {
                        if let revision = sheet.currentRevisionLabel {
                            LabeledContent("Current Revision", value: revision)
                        }
                        LabeledContent("Versions", value: "\(versionCount)")
                        LabeledContent("Pins", value: "\(sheet.totalPinsCount)")
                        LabeledContent("Updated", value: sheet.updatedAt.formatted(date: .abbreviated, time: .shortened))
                    }
                }
            }
            .navigationTitle("Sheet Info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
