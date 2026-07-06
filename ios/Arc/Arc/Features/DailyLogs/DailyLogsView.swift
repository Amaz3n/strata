import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The Logs tab, redesigned as a day-first site diary. The screen answers one
/// question — "what happened on site this day?" — with a week strip to move
/// between days, the day's log rendered as a document, and a persistent
/// capture bar so starting today's log is always one tap away.
struct ProjectDailyLogsView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(AppRouter.self) private var router
    @State private var selectedDay = DailyLogDate.todayKey
    @State private var showsHistory = false
    @State private var hapticTick = 0
    let project: MobileProject

    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }

    private var logsByDay: [String: [MobileDailyLog]] {
        Dictionary(grouping: dependencies.dailyLogs.logs, by: \.date)
    }

    private var dayLogs: [MobileDailyLog] { logsByDay[selectedDay] ?? [] }
    private var isViewingToday: Bool { selectedDay == DailyLogDate.todayKey }

    var body: some View {
        Group {
            if dependencies.dailyLogs.isLoading && dependencies.dailyLogs.logs.isEmpty {
                ProgressView("Loading daily logs…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(ArcAmbientBackground())
            } else if let error = dependencies.dailyLogs.errorMessage, dependencies.dailyLogs.logs.isEmpty {
                ContentUnavailableView {
                    Label("Couldn't load daily logs", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try Again") { Task { await refresh() } }
                        .buttonStyle(.borderedProminent)
                }
                .background(ArcAmbientBackground())
            } else {
                diary
            }
        }
        .navigationTitle("Logs")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("History", systemImage: "clock.arrow.circlepath") { showsHistory = true }
                    .accessibilityIdentifier("daily-log-history")
            }
        }
        .sheet(isPresented: $showsHistory) {
            DailyLogHistoryView(logs: dependencies.dailyLogs.logs) { log in
                showsHistory = false
                router.navigate(to: .dailyLog(id: log.id))
            }
        }
        .task(id: project.id) {
            guard let organizationID else { return }
            await dependencies.dailyLogs.load(projectID: project.id, organizationID: organizationID)
        }
        .sensoryFeedback(.selection, trigger: selectedDay)
        .sensoryFeedback(.impact(weight: .light), trigger: hapticTick)
    }

    // MARK: Diary

    private var diary: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                DailyLogDayStrip(
                    days: DailyLogDate.recentKeys(count: 14),
                    activeDays: Set(logsByDay.keys),
                    selection: $selectedDay
                )
                .arcReveal()

                dayHeader
                    .arcReveal(delay: 0.05)
                    .padding(.horizontal, 20)

                dayContent
                    .arcReveal(delay: 0.1)
                    .padding(.horizontal, 20)
            }
            .frame(maxWidth: 640, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.top, 10)
            .padding(.bottom, 24)
        }
        .background(ArcAmbientBackground())
        .projectSwitcherPullOrRefresh { await refresh() }
        .safeAreaInset(edge: .top, spacing: 0) {
            if dependencies.dailyLogs.isUsingOfflineData {
                Label("Showing downloaded logs", systemImage: "icloud.slash")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background(.bar)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            composeButton
        }
    }

    private var dayHeader: some View {
        let hours = dayLogs.flatMap(\.entries).compactMap(\.hours).reduce(0, +)
        let photos = dayLogs.map(\.photoCount).reduce(0, +)
        return HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(DailyLogDate.relativeTitle(selectedDay))
                    .font(.system(.title2, design: .rounded, weight: .bold))
                    .contentTransition(.numericText())
                Text(DailyLogDate.full(selectedDay))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            HStack(spacing: 12) {
                if hours > 0 {
                    Label(hours.formatted() + "h", systemImage: "clock")
                }
                if photos > 0 {
                    Label("\(photos)", systemImage: "photo")
                }
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
        }
        .animation(.snappy, value: selectedDay)
    }

    @ViewBuilder
    private var dayContent: some View {
        if dayLogs.isEmpty {
            if isViewingToday {
                todayEmptyState
            } else {
                pastEmptyState
            }
        } else {
            VStack(spacing: 14) {
                ForEach(dayLogs) { log in
                    Button {
                        hapticTick += 1
                        router.navigate(to: .dailyLog(id: log.id))
                    } label: {
                        DailyLogDayDocument(log: log)
                    }
                    .buttonStyle(.arcPress)
                    .contextMenu {
                        Button("Delete Log", systemImage: "trash", role: .destructive) {
                            Task { await delete(log) }
                        }
                    }
                }
            }
        }
    }

    /// Capture-first invitation shown when today has nothing yet — the two big
    /// targets a PM actually reaches for: the camera, or a quick written note.
    private var todayEmptyState: some View {
        VStack(spacing: 12) {
            VStack(spacing: 4) {
                Image(systemName: "sun.max")
                    .font(.title)
                    .foregroundStyle(BrandTheme.brightBlue)
                Text("Nothing logged yet")
                    .font(.headline)
                Text("A few photos and one line is a great log.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 22)
            .padding(.bottom, 6)

            HStack(spacing: 12) {
                captureHeroButton("Take Photos", systemImage: "camera.fill", tint: BrandTheme.midBlue) {
                    router.presentedSheet = .newDailyLog(camera: true)
                }
                captureHeroButton("Write Log", systemImage: "square.and.pencil", tint: BrandTheme.brightBlue) {
                    router.presentedSheet = .newDailyLog(camera: false)
                }
            }
            .glassGroup(spacing: 12)
            .padding(.bottom, 4)
        }
    }

    private var pastEmptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "moon.zzz")
                .font(.title2)
                .foregroundStyle(.tertiary)
            Text("No log for this day")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            Text("Use the composer's date picker to backfill a day.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
    }

    private func captureHeroButton(
        _ title: String, systemImage: String, tint: Color, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(tint.gradient, in: Circle())
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 20)
            .liquidGlass(in: RoundedRectangle(cornerRadius: 24, style: .continuous), interactive: true)
            .contentShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
        .buttonStyle(.arcPress)
    }

    /// Floating compose button — the single, always-there way to start a log.
    /// A long press jumps straight into the camera.
    private var composeButton: some View {
        Button {
            hapticTick += 1
            router.presentedSheet = .newDailyLog(camera: false)
        } label: {
            Image(systemName: "plus")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(BrandTheme.buttonGradient, in: Circle())
                .overlay(Circle().stroke(.white.opacity(0.16), lineWidth: 1))
                .shadow(color: BrandTheme.deepBlue.opacity(0.32), radius: 14, y: 7)
                .contentShape(Circle())
        }
        .buttonStyle(.arcPress)
        .contextMenu {
            Button("Take Photos", systemImage: "camera") {
                router.presentedSheet = .newDailyLog(camera: true)
            }
        }
        .accessibilityLabel("New daily log")
        .accessibilityIdentifier("new-daily-log")
        .padding(.trailing, 20)
        .padding(.bottom, 16)
    }

    private func refresh() async {
        guard let organizationID else { return }
        await dependencies.dailyLogs.refresh(projectID: project.id, organizationID: organizationID)
    }

    private func delete(_ log: MobileDailyLog) async {
        guard let organizationID else { return }
        do {
            try await dependencies.dailyLogs.delete(logID: log.id, projectID: project.id, organizationID: organizationID)
            hapticTick += 1
        } catch { }
    }
}

// MARK: - Week strip

/// Horizontal strip of the last two weeks. Each chip is weekday-over-day with
/// an activity dot; the selection floats on Liquid Glass. Lands scrolled to
/// today, which sits at the trailing edge.
private struct DailyLogDayStrip: View {
    let days: [String]
    let activeDays: Set<String>
    @Binding var selection: String

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(days, id: \.self) { day in
                        chip(day)
                            .id(day)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 4)
            }
            .onAppear { proxy.scrollTo(days.last, anchor: .trailing) }
        }
    }

    private func chip(_ day: String) -> some View {
        let isSelected = day == selection
        let isToday = day == DailyLogDate.todayKey
        return Button {
            withAnimation(.snappy) { selection = day }
        } label: {
            VStack(spacing: 3) {
                Text(DailyLogDate.weekdayLetter(day))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(isSelected ? Color.accentColor : .secondary)
                Text(DailyLogDate.day(day))
                    .font(.callout.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(isSelected ? Color.accentColor : (isToday ? Color.primary : Color.secondary))
                Circle()
                    .fill(activeDays.contains(day) ? BrandTheme.brightBlue : .clear)
                    .frame(width: 4.5, height: 4.5)
            }
            .frame(width: 44, height: 62)
            .background {
                if isSelected {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(Color.accentColor.opacity(0.1))
                }
            }
            .liquidGlassIf(isSelected, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.arcPress)
        .accessibilityLabel(DailyLogDate.full(day))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private extension View {
    @ViewBuilder
    func liquidGlassIf(_ condition: Bool, in shape: some Shape) -> some View {
        if condition {
            liquidGlass(in: shape)
        } else {
            self
        }
    }
}

// MARK: - Day document

/// A day's log rendered like a page from a site diary: conditions on top, the
/// narrative as the lead, a photo filmstrip, then the structured entries.
private struct DailyLogDayDocument: View {
    let log: MobileDailyLog

    private var hours: Double { log.entries.compactMap(\.hours).reduce(0, +) }
    private var failedInspections: Int {
        log.entries.count { $0.entryType == "inspection" && $0.inspectionResult == "fail" }
    }
    private var photos: [MobileDailyLogPhoto] { log.photos ?? [] }

    var body: some View {
        ArcGlassCard(padding: 16, cornerRadius: 24) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    if let weather = log.weather {
                        Label(weather, systemImage: DailyLogWeather.symbol(weather))
                            .lineLimit(1)
                    } else {
                        Label("Site log", systemImage: "book.pages")
                    }
                    if hours > 0 {
                        Text("·").foregroundStyle(.tertiary)
                        Label(hours.formatted() + "h", systemImage: "clock")
                    }
                    Spacer(minLength: 4)
                    if log.syncState == "pending" {
                        Label("Syncing", systemImage: "arrow.triangle.2.circlepath")
                            .foregroundStyle(.orange)
                    } else {
                        Image(systemName: "chevron.right")
                            .foregroundStyle(.tertiary)
                    }
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)

                if let summary = log.summary, !summary.isEmpty {
                    Text(summary)
                        .font(.callout)
                        .foregroundStyle(.primary)
                        .lineLimit(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text("No notes")
                        .font(.callout)
                        .italic()
                        .foregroundStyle(.tertiary)
                }

                if !photos.isEmpty {
                    filmstrip
                }

                if !log.entries.isEmpty {
                    Divider().opacity(0.5)
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(log.entries.prefix(3)) { entry in
                            entryLine(entry)
                        }
                        if log.entries.count > 3 {
                            Text("\(log.entries.count - 3) more…")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }

                if !log.comments.isEmpty || failedInspections > 0 {
                    HStack(spacing: 12) {
                        if failedInspections > 0 {
                            Label("\(failedInspections) failed inspection\(failedInspections == 1 ? "" : "s")",
                                  systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(.red)
                        }
                        if !log.comments.isEmpty {
                            Label("\(log.comments.count)", systemImage: "bubble.left")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .font(.caption.weight(.medium))
                }
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private var filmstrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(photos.prefix(8)) { photo in
                    AsyncImage(url: photo.downloadUrl) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Color.secondary.opacity(0.1)
                    }
                    .frame(width: 84, height: 84)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                if log.photoCount > 8 {
                    Text("+\(log.photoCount - 8)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 84, height: 84)
                        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
        }
        .scrollClipDisabled()
    }

    private func entryLine(_ entry: MobileDailyLogEntry) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: entry.entryType == "inspection" ? "checkmark.seal" : "hammer")
                .font(.caption)
                .foregroundStyle(entry.entryType == "inspection"
                                 ? ArcStatusColor.color(for: entry.inspectionResult ?? "")
                                 : BrandTheme.midBlue)
                .frame(width: 16)
            Text(entry.description?.isEmpty == false ? entry.description! : (entry.trade ?? "Entry"))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 0)
            if let entryHours = entry.hours {
                Text(entryHours.formatted() + "h")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
        }
    }
}

// MARK: - History

/// Searchable archive of every log, one row per log, newest first. Lives in a
/// sheet so the diary itself stays a single calm page.
private struct DailyLogHistoryView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    let logs: [MobileDailyLog]
    let onOpen: (MobileDailyLog) -> Void

    private var filtered: [MobileDailyLog] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !term.isEmpty else { return logs }
        return logs.filter { log in
            [
                log.summary,
                log.weather,
                log.entries.compactMap(\.description).joined(separator: " "),
                log.entries.compactMap(\.trade).joined(separator: " "),
                log.entries.compactMap(\.location).joined(separator: " "),
            ]
            .compactMap { $0 }
            .joined(separator: " ")
            .lowercased()
            .contains(term)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if filtered.isEmpty {
                    ContentUnavailableView(
                        query.isEmpty ? "No logs yet" : "No matching logs",
                        systemImage: "book.pages",
                        description: Text(query.isEmpty
                                          ? "Logs you capture will build the project's history here."
                                          : "Try a different search.")
                    )
                } else {
                    List(filtered) { log in
                        Button {
                            onOpen(log)
                        } label: {
                            row(log)
                        }
                        .buttonStyle(.plain)
                    }
                    .listStyle(.plain)
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search logs")
            .navigationTitle("History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
    }

    private func row(_ log: MobileDailyLog) -> some View {
        HStack(spacing: 12) {
            VStack(spacing: 0) {
                Text(DailyLogDate.month(log.date)).font(.caption2.weight(.semibold))
                Text(DailyLogDate.day(log.date)).font(.title3.bold())
            }
            .foregroundStyle(DailyLogDate.isToday(log.date) ? Color.accentColor : Color.primary)
            .frame(width: 44, height: 44)
            .background(Color.secondary.opacity(0.09), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

            VStack(alignment: .leading, spacing: 2) {
                Text(DailyLogDate.relativeTitle(log.date))
                    .font(.subheadline.weight(.semibold))
                Text(log.summary?.isEmpty == false ? log.summary! : "No notes")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 4)
            if log.photoCount > 0 {
                Label("\(log.photoCount)", systemImage: "photo")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

struct DailyLogDetailView: View {
    private enum Presentation: String, Identifiable {
        case edit
        var id: Self { self }
    }

    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss
    @State private var presentation: Presentation?
    @State private var confirmsDeletion = false
    @State private var commentBody = ""
    @State private var commentMentionIDs: [String] = []
    @State private var isSubmittingComment = false
    @State private var galleryIndex: Int?
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var showsLibrary = false
    @State private var showsCamera = false
    @State private var isImportingPhotos = false
    @FocusState private var commentFocused: Bool
    let project: MobileProject
    let logID: String

    private var log: MobileDailyLog? { dependencies.dailyLogs.logs.first { $0.id == logID } }

    var body: some View {
        if let log {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    DailyLogDetailHeader(log: log)

                    photoSection(log.photos ?? [])

                    if let summary = log.summary, !summary.isEmpty {
                        DailyLogDetailSection(title: "Site summary", systemImage: "text.alignleft") {
                            Text(summary).font(.callout)
                        }
                    }

                    if !log.entries.isEmpty {
                        DailyLogDetailSection(title: "Detailed entries", systemImage: "list.bullet.rectangle") {
                            VStack(spacing: 10) {
                                ForEach(log.entries) { entry in
                                    DailyLogEntryRow(entry: entry, context: dependencies.dailyLogs.context)
                                }
                            }
                        }
                    }

                    if let mentionIDs = log.mentionedUserIds, !mentionIDs.isEmpty {
                        let names = dependencies.dailyLogs.context.team
                            .filter { mentionIDs.contains($0.id) }
                            .map(\.name)
                        if !names.isEmpty {
                            DailyLogDetailSection(title: "Mentioned", systemImage: "at") {
                                Text(names.joined(separator: ", "))
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }

                    DailyLogDetailSection(title: "Comments", systemImage: "bubble.left.and.bubble.right") {
                        if log.comments.isEmpty {
                            Text("No comments yet.")
                                .font(.callout)
                                .foregroundStyle(.tertiary)
                        } else {
                            VStack(spacing: 10) {
                                ForEach(log.comments) { comment in
                                    DailyLogCommentBubble(comment: comment)
                                }
                            }
                        }
                    }
                }
                .frame(maxWidth: 760, alignment: .leading)
                .padding()
            }
            .background(ArcAmbientBackground())
            .photosPicker(isPresented: $showsLibrary, selection: $photoSelection, maxSelectionCount: 20, matching: .images)
            .onChange(of: photoSelection) {
                Task { await importPhotos() }
            }
            .fullScreenCover(isPresented: $showsCamera) {
                CameraPicker { data in
                    showsCamera = false
                    Task { await addPhotos([(data, "site-photo-\(UUID().uuidString).jpg", "image/jpeg")]) }
                } onCancel: {
                    showsCamera = false
                }
                .ignoresSafeArea()
            }
            .safeAreaInset(edge: .bottom) {
                CommentComposerBar(
                    text: $commentBody,
                    mentionIDs: $commentMentionIDs,
                    isSubmitting: isSubmittingComment,
                    isFocused: $commentFocused,
                    team: dependencies.dailyLogs.context.team,
                    onSend: { Task { await postComment() } }
                )
            }
            .fullScreenCover(item: Binding(get: { galleryIndex.map(GalleryPresentation.init) },
                                           set: { galleryIndex = $0?.index })) { presentation in
                PhotoGalleryView(photos: log.photos ?? [], initialIndex: presentation.index)
            }
            .navigationTitle(DailyLogDate.relativeTitle(log.date))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Edit Log", systemImage: "pencil") { presentation = .edit }
                        Button("Delete Log", systemImage: "trash", role: .destructive) { confirmsDeletion = true }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .sheet(item: $presentation) { _ in
                EditDailyLogView(project: project, log: log)
            }
            .confirmationDialog("Delete this daily log?", isPresented: $confirmsDeletion, titleVisibility: .visible) {
                Button("Delete Daily Log", role: .destructive) { Task { await deleteLog() } }
            } message: {
                Text("This removes the log, its structured entries, and comments. Uploaded photos remain in project files.")
            }
        } else {
            ContentUnavailableView("Log unavailable", systemImage: "doc.text.magnifyingglass")
        }
    }

    /// Always present so photos can keep landing on the log all day long —
    /// the add tile is the first cell, camera first.
    private func photoSection(_ photos: [MobileDailyLogPhoto]) -> some View {
        DailyLogDetailSection(
            title: photos.isEmpty ? "Photos" : "Photos (\(photos.count))",
            systemImage: "photo.on.rectangle"
        ) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 8) {
                addPhotoTile
                ForEach(Array(photos.enumerated()), id: \.element.id) { index, photo in
                    Button {
                        galleryIndex = index
                    } label: {
                        AsyncImage(url: photo.downloadUrl) { image in
                            image.resizable().scaledToFill()
                        } placeholder: {
                            Color.secondary.opacity(0.1)
                        }
                        .aspectRatio(1, contentMode: .fill)
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var addPhotoTile: some View {
        Menu {
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button("Take Photo", systemImage: "camera") { showsCamera = true }
            }
            Button("Choose from Library", systemImage: "photo.on.rectangle") { showsLibrary = true }
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.accentColor.opacity(0.08))
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Color.accentColor.opacity(0.3), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                if isImportingPhotos {
                    ProgressView()
                } else {
                    VStack(spacing: 4) {
                        Image(systemName: "camera.fill").font(.title3)
                        Text("Add").font(.caption.weight(.medium))
                    }
                    .foregroundStyle(Color.accentColor)
                }
            }
            .aspectRatio(1, contentMode: .fit)
        }
        .disabled(isImportingPhotos)
        .accessibilityLabel("Add photos to this log")
    }

    private func importPhotos() async {
        guard !photoSelection.isEmpty else { return }
        isImportingPhotos = true
        defer {
            isImportingPhotos = false
            photoSelection = []
        }
        var imports: [(Data, String, String)] = []
        for item in photoSelection {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let normalized = UIImage(data: data)?.jpegData(compressionQuality: 0.88) ?? data
            imports.append((normalized, "site-photo-\(UUID().uuidString).jpg", "image/jpeg"))
        }
        await addPhotos(imports)
    }

    private func addPhotos(_ items: [(data: Data, fileName: String, mimeType: String)]) async {
        guard let organizationID = dependencies.workspace.selectedOrganizationID, !items.isEmpty else { return }
        isImportingPhotos = true
        defer { isImportingPhotos = false }
        let attachments = items.compactMap { item in
            try? dependencies.dailyLogs.persistAttachment(
                data: item.data,
                fileName: item.fileName,
                mimeType: item.mimeType
            )
        }
        await dependencies.dailyLogs.addPhotos(
            attachments,
            to: logID,
            projectID: project.id,
            organizationID: organizationID
        )
    }

    private func postComment() async {
        guard let organizationID = dependencies.workspace.selectedOrganizationID else { return }
        isSubmittingComment = true
        defer { isSubmittingComment = false }
        do {
            try await dependencies.dailyLogs.addComment(
                logID: logID,
                body: commentBody.trimmingCharacters(in: .whitespacesAndNewlines),
                mentionedUserIDs: commentMentionIDs,
                projectID: project.id,
                organizationID: organizationID
            )
            commentBody = ""
            commentMentionIDs = []
            commentFocused = false
        } catch { }
    }

    private func deleteLog() async {
        guard let organizationID = dependencies.workspace.selectedOrganizationID else { return }
        do {
            try await dependencies.dailyLogs.delete(logID: logID, projectID: project.id, organizationID: organizationID)
            dismiss()
        } catch { }
    }
}

/// Header card on the detail screen: full date, weather, total hours and sync state.
private struct DailyLogDetailHeader: View {
    let log: MobileDailyLog

    private var hours: Double { log.entries.compactMap(\.hours).reduce(0, +) }

    var body: some View {
        ArcGlassCard {
            VStack(alignment: .leading, spacing: 12) {
                Text(DailyLogDate.full(log.date))
                    .font(.title3.bold())
                HStack(spacing: 10) {
                    if let weather = log.weather {
                        Label(weather, systemImage: DailyLogWeather.symbol(weather))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    if hours > 0 {
                        Label(hours.formatted() + "h", systemImage: "clock")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    if log.photoCount > 0 {
                        Label("\(log.photoCount)", systemImage: "camera")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                if log.syncState == "pending" {
                    Label("Waiting to sync", systemImage: "arrow.triangle.2.circlepath")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.orange)
                }
            }
        }
    }
}

/// Titled card wrapper used throughout the detail screen.
private struct DailyLogDetailSection<Content: View>: View {
    let title: String
    var systemImage: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            ArcGlassCard { content }
        }
    }
}

private struct DailyLogCommentBubble: View {
    let comment: MobileDailyLogComment

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(comment.authorName ?? "Team member")
                    .font(.caption.weight(.semibold))
                Spacer()
                Text(comment.createdAt, format: .relative(presentation: .named))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Text(comment.body).font(.callout)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

private struct GalleryPresentation: Identifiable {
    let index: Int
    var id: Int { index }
}

private struct CommentComposerBar: View {
    @Binding var text: String
    @Binding var mentionIDs: [String]
    let isSubmitting: Bool
    var isFocused: FocusState<Bool>.Binding
    let team: [DailyLogTeamMember]
    let onSend: () -> Void

    @State private var showsMentions = false

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSubmitting
    }

    var body: some View {
        // Floating iMessage-style capsule: everything (mention accessory, field,
        // send arrow) lives inside one Liquid Glass pill that floats over content.
        HStack(alignment: .bottom, spacing: 6) {
            if !team.isEmpty {
                Button {
                    showsMentions = true
                } label: {
                    Image(systemName: mentionIDs.isEmpty ? "at" : "at.circle.fill")
                        .font(.title3)
                        .foregroundStyle(mentionIDs.isEmpty ? Color.secondary : Color.accentColor)
                }
                .accessibilityLabel("Mention team members")
                .padding(.leading, 4)
                .padding(.bottom, 5)
            }

            TextField("Comment", text: $text, axis: .vertical)
                .focused(isFocused)
                .lineLimit(1...5)
                .padding(.vertical, 8)
                .padding(.leading, team.isEmpty ? 14 : 0)

            Button {
                onSend()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(canSend ? Color.accentColor : Color.secondary)
            }
            .disabled(!canSend)
            .padding(.trailing, 4)
            .padding(.bottom, 4)
        }
        .padding(.horizontal, 4)
        .liquidGlass(in: Capsule(), interactive: true)
        .overlay(Capsule().stroke(Color.primary.opacity(0.06), lineWidth: 1))
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .sheet(isPresented: $showsMentions) {
            NavigationStack {
                List {
                    MentionPicker(title: "Mention team members", selection: $mentionIDs, team: team)
                }
                .navigationTitle("Mentions")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { showsMentions = false }
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
    }
}

private struct PhotoGalleryView: View {
    @Environment(\.dismiss) private var dismiss
    let photos: [MobileDailyLogPhoto]
    @State private var index: Int

    init(photos: [MobileDailyLogPhoto], initialIndex: Int) {
        self.photos = photos
        _index = State(initialValue: initialIndex)
    }

    var body: some View {
        NavigationStack {
            TabView(selection: $index) {
                ForEach(Array(photos.enumerated()), id: \.element.id) { offset, photo in
                    ZoomableImage(url: photo.downloadUrl).tag(offset)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: photos.count > 1 ? .automatic : .never))
            .background(Color.black)
            .ignoresSafeArea(edges: .bottom)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .principal) {
                    if photos.count > 1 {
                        Text("\(index + 1) of \(photos.count)").font(.subheadline)
                    }
                }
            }
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }
}

private struct ZoomableImage: View {
    let url: URL
    @State private var scale: CGFloat = 1

    var body: some View {
        AsyncImage(url: url) { image in
            image.resizable().scaledToFit()
        } placeholder: {
            ProgressView().tint(.white)
        }
        .scaleEffect(scale)
        .gesture(
            MagnificationGesture()
                .onChanged { scale = max(1, $0) }
                .onEnded { _ in withAnimation(.spring) { scale = 1 } }
        )
        .onTapGesture(count: 2) {
            withAnimation(.spring) { scale = scale > 1 ? 1 : 2.5 }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct EditDailyLogView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss
    @State private var summary: String
    @State private var weather: String?
    @State private var mentionedUserIDs: [String]
    @State private var isSaving = false
    let project: MobileProject
    let log: MobileDailyLog

    init(project: MobileProject, log: MobileDailyLog) {
        self.project = project
        self.log = log
        _summary = State(initialValue: log.summary ?? "")
        _weather = State(initialValue: log.weather)
        _mentionedUserIDs = State(initialValue: log.mentionedUserIds ?? [])
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Weather") {
                    Picker("Conditions", selection: $weather) {
                        Text("None").tag(String?.none)
                        ForEach(["Sunny", "Partly Cloudy", "Cloudy", "Light Rain", "Heavy Rain", "Windy", "Hot"], id: \.self) {
                            Text($0).tag(String?.some($0))
                        }
                    }
                }
                Section("Site summary") {
                    TextEditor(text: $summary).frame(minHeight: 140)
                }
                Section {
                    MentionPicker(
                        title: "Mention team members",
                        selection: $mentionedUserIDs,
                        team: dependencies.dailyLogs.context.team
                    )
                }
            }
            .navigationTitle("Edit Daily Log")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") { Task { await save() } }.disabled(isSaving)
                }
            }
        }
    }

    private func save() async {
        guard let organizationID = dependencies.workspace.selectedOrganizationID else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            try await dependencies.dailyLogs.update(
                logID: log.id,
                summary: summary,
                weather: weather,
                mentionedUserIDs: mentionedUserIDs,
                projectID: project.id,
                organizationID: organizationID
            )
            dismiss()
        } catch { }
    }
}

private struct DailyLogEntryRow: View {
    let entry: MobileDailyLogEntry
    let context: MobileDailyLogContext

    private var title: String {
        switch entry.entryType {
        case "inspection": "Inspection"
        case "task_update": context.tasks.first { $0.id == entry.taskId }?.title ?? "Task update"
        case "punch_update": context.punchItems.first { $0.id == entry.punchItemId }?.title ?? "Punch update"
        default: context.scheduleItems.first { $0.id == entry.scheduleItemId }?.name ?? "Work performed"
        }
    }

    private var icon: String {
        switch entry.entryType {
        case "inspection": "checkmark.seal"
        case "task_update": "checkmark.circle"
        case "punch_update": "wrench.and.screwdriver"
        default: "hammer"
        }
    }

    private var tint: Color {
        if entry.entryType == "inspection" {
            return ArcStatusColor.color(for: entry.inspectionResult ?? "")
        }
        return BrandTheme.midBlue
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.callout)
                .foregroundStyle(tint)
                .frame(width: 26, height: 26)
                .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.subheadline.weight(.semibold))
                if let description = entry.description, !description.isEmpty {
                    Text(description).font(.callout).foregroundStyle(.secondary)
                }
                HStack(spacing: 10) {
                    if let hours = entry.hours { metaChip("\(hours.formatted())h") }
                    if let progress = entry.progress { metaChip("\(progress.formatted())%") }
                    if let trade = entry.trade, !trade.isEmpty { metaChip(trade) }
                    if let result = entry.inspectionResult {
                        StatusBadge(text: result.replacingOccurrences(of: "_", with: " ").capitalized,
                                    tint: ArcStatusColor.color(for: result))
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func metaChip(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
    }
}

/// The quick-log composer, presented as a slide-up sheet over the diary. The
/// note and the photo carousel are the whole story; date, weather, mentions
/// and structured details are quiet glass chips underneath.
struct DailyLogComposerView: View {
    private enum Presentation: String, Identifiable {
        case camera
        var id: Self { self }
    }

    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss
    @State private var draft = DailyLogDraft()
    @State private var didRestoreDraft = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var isImportingPhotos = false
    @State private var presentation: Presentation?
    @State private var showsLibrary = false
    @State private var showsMentionSheet = false
    @State private var showsDatePicker = false
    @FocusState private var summaryFocused: Bool
    let project: MobileProject
    /// Jumps straight into the camera on appear — the "Take Photos" fast path.
    var autoOpensCamera = false

    private let weatherOptions = ["Sunny", "Partly Cloudy", "Cloudy", "Light Rain", "Heavy Rain", "Windy", "Hot"]
    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }
    private var detailCount: Int {
        draft.workEntries.count + draft.inspectionEntries.count + draft.taskUpdates.count + draft.punchUpdates.count
    }
    private var canSubmit: Bool {
        !draft.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
        draft.weather != nil || !draft.workEntries.isEmpty || !draft.inspectionEntries.isEmpty ||
        !draft.taskUpdates.isEmpty || !draft.punchUpdates.isEmpty || !draft.attachments.isEmpty
    }

    private var titleText: String {
        if Calendar.current.isDateInToday(draft.date) { return "Today" }
        if Calendar.current.isDateInYesterday(draft.date) { return "Yesterday" }
        return draft.date.formatted(date: .abbreviated, time: .omitted)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    noteEditor
                    attachmentCarousel
                    optionChips
                    if showsDatePicker {
                        datePickerRow
                    }
                    detailCards

                    if dependencies.networkMonitor.status == .offline {
                        Label("Offline — this log will sync automatically", systemImage: "wifi.slash")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(.orange)
                    }
                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                .padding(20)
                .frame(maxWidth: 640, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .background(ArcAmbientBackground())
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(titleText)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSubmitting ? "Saving…" : "Save") { Task { await submit() } }
                        .fontWeight(.semibold)
                        .disabled(!canSubmit || isSubmitting)
                }
            }
        }
        .presentationDragIndicator(.visible)
        .task {
            guard !didRestoreDraft, let organizationID else { return }
            if dependencies.dailyLogs.loadedProjectID != project.id {
                await dependencies.dailyLogs.load(projectID: project.id, organizationID: organizationID)
            }
            draft = dependencies.dailyLogs.loadDraft(projectID: project.id, organizationID: organizationID)
            didRestoreDraft = true
            if autoOpensCamera && UIImagePickerController.isSourceTypeAvailable(.camera) {
                presentation = .camera
            } else if !canSubmit {
                summaryFocused = true
            }
        }
        .onChange(of: draft) {
            guard didRestoreDraft, let organizationID else { return }
            dependencies.dailyLogs.saveDraft(draft, projectID: project.id, organizationID: organizationID)
        }
        .onChange(of: photoSelection) {
            Task { await importPhotos() }
        }
        .photosPicker(isPresented: $showsLibrary, selection: $photoSelection, maxSelectionCount: 20, matching: .images)
        .sheet(isPresented: $showsMentionSheet) {
            MentionSheet(selection: $draft.mentionedUserIds, team: dependencies.dailyLogs.context.team)
        }
        .fullScreenCover(item: $presentation) { _ in
            CameraPicker { data in
                if let attachment = try? dependencies.dailyLogs.persistAttachment(
                    data: data,
                    fileName: "site-photo-\(UUID().uuidString).jpg",
                    mimeType: "image/jpeg"
                ) {
                    draft.attachments.append(attachment)
                }
                presentation = nil
            } onCancel: {
                presentation = nil
            }
            .ignoresSafeArea()
        }
    }

    // MARK: - Note

    /// Borderless, paper-like editor — the note is the page, not a field on a form.
    private var noteEditor: some View {
        ZStack(alignment: .topLeading) {
            if draft.summary.isEmpty {
                Text("What happened on site today?")
                    .font(.body)
                    .foregroundStyle(.tertiary)
                    .padding(.top, 8)
                    .padding(.leading, 5)
                    .allowsHitTesting(false)
            }
            TextEditor(text: $draft.summary)
                .font(.body)
                .frame(minHeight: 132)
                .scrollContentBackground(.hidden)
                .focused($summaryFocused)
        }
    }

    // MARK: - Attachments

    /// Horizontal carousel: camera and library tiles lead, shots line up after
    /// them, newest appended at the end. Edge-to-edge scroll, glass tiles.
    private var attachmentCarousel: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    captureTile("Camera", systemImage: "camera.fill", prominent: true) {
                        presentation = .camera
                    }
                }
                captureTile("Library", systemImage: "photo.on.rectangle", prominent: false) {
                    showsLibrary = true
                }
                ForEach(draft.attachments) { attachment in
                    ComposerPhotoThumb(attachment: attachment) {
                        dependencies.dailyLogs.removeAttachment(attachment)
                        draft.attachments.removeAll { $0.id == attachment.id }
                    }
                    .frame(width: 92, height: 92)
                }
                if isImportingPhotos {
                    ProgressView()
                        .frame(width: 92, height: 92)
                        .liquidGlass(in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 2)
            .glassGroup(spacing: 10)
        }
        .scrollClipDisabled()
        .padding(.horizontal, -20)
        .animation(.snappy, value: draft.attachments)
    }

    private func captureTile(
        _ title: String, systemImage: String, prominent: Bool, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.title3.weight(.semibold))
                Text(title)
                    .font(.caption.weight(.medium))
            }
            .foregroundStyle(prominent ? AnyShapeStyle(.white) : AnyShapeStyle(Color.accentColor))
            .frame(width: 92, height: 92)
            .background {
                if prominent {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(BrandTheme.buttonGradient)
                }
            }
            .liquidGlassIf(!prominent, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .buttonStyle(.arcPress)
        .disabled(isImportingPhotos)
    }

    // MARK: - Option chips

    /// Everything that isn't the story itself, demoted to one quiet row.
    private var optionChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                dateChip
                weatherChip
                mentionChip
                detailChip
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 2)
        }
        .scrollClipDisabled()
        .padding(.horizontal, -20)
    }

    private var dateChip: some View {
        Menu {
            Button("Today") {
                draft.date = .now
                showsDatePicker = false
            }
            Button("Yesterday") {
                draft.date = Calendar.current.date(byAdding: .day, value: -1, to: .now) ?? .now
                showsDatePicker = false
            }
            Divider()
            Button("Choose a date…", systemImage: "calendar") { showsDatePicker = true }
        } label: {
            chipLabel(titleText, systemImage: "calendar", active: !Calendar.current.isDateInToday(draft.date))
        }
    }

    private var weatherChip: some View {
        Menu {
            ForEach(weatherOptions, id: \.self) { option in
                Button {
                    draft.weather = option
                } label: {
                    Label(option, systemImage: DailyLogWeather.symbol(option))
                }
            }
            if draft.weather != nil {
                Divider()
                Button("Clear", systemImage: "xmark", role: .destructive) { draft.weather = nil }
            }
        } label: {
            chipLabel(
                draft.weather ?? "Weather",
                systemImage: draft.weather.map(DailyLogWeather.symbol) ?? "cloud.sun",
                active: draft.weather != nil
            )
        }
    }

    private var mentionChip: some View {
        Button {
            showsMentionSheet = true
        } label: {
            chipLabel(
                draft.mentionedUserIds.isEmpty ? "Mention" : "Mentions · \(draft.mentionedUserIds.count)",
                systemImage: "at",
                active: !draft.mentionedUserIds.isEmpty
            )
        }
        .buttonStyle(.arcPress)
    }

    private var detailChip: some View {
        Menu {
            Button("Work Performed", systemImage: "hammer") { draft.workEntries.append(DailyLogWorkDraft()) }
            Button("Inspection", systemImage: "checkmark.seal") { draft.inspectionEntries.append(DailyLogInspectionDraft()) }
            Button("Task Update", systemImage: "checkmark.circle") { draft.taskUpdates.append(DailyLogTaskUpdateDraft()) }
            Button("Close Punch Item", systemImage: "wrench.and.screwdriver") { draft.punchUpdates.append(DailyLogPunchUpdateDraft()) }
        } label: {
            chipLabel(
                detailCount > 0 ? "Details · \(detailCount)" : "Add detail",
                systemImage: "plus.circle",
                active: detailCount > 0
            )
        }
    }

    private func chipLabel(_ title: String, systemImage: String, active: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.caption.weight(.semibold))
            Text(title)
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
        }
        .foregroundStyle(active ? Color.accentColor : Color.primary)
        .padding(.horizontal, 13)
        .padding(.vertical, 9)
        .liquidGlass(in: Capsule())
        .overlay {
            if active {
                Capsule().stroke(Color.accentColor.opacity(0.35), lineWidth: 1)
            }
        }
        .contentShape(Capsule())
    }

    private var datePickerRow: some View {
        DatePicker("Log date", selection: $draft.date, in: ...Date.now, displayedComponents: .date)
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .liquidGlass(in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    // MARK: - Structured details

    @ViewBuilder
    private var detailCards: some View {
        ForEach($draft.workEntries) { $entry in
            WorkEntryCard(entry: $entry, scheduleItems: dependencies.dailyLogs.context.scheduleItems) {
                draft.workEntries.removeAll { $0.id == entry.id }
            }
        }
        ForEach($draft.inspectionEntries) { $entry in
            InspectionEntryCard(entry: $entry, scheduleItems: dependencies.dailyLogs.context.scheduleItems) {
                draft.inspectionEntries.removeAll { $0.id == entry.id }
            }
        }
        ForEach($draft.taskUpdates) { $entry in
            TaskUpdateCard(entry: $entry, tasks: dependencies.dailyLogs.context.tasks) {
                draft.taskUpdates.removeAll { $0.id == entry.id }
            }
        }
        ForEach($draft.punchUpdates) { $entry in
            PunchUpdateCard(entry: $entry, punchItems: dependencies.dailyLogs.context.punchItems) {
                draft.punchUpdates.removeAll { $0.id == entry.id }
            }
        }
    }

    private func submit() async {
        guard let organizationID else { return }
        isSubmitting = true
        errorMessage = nil
        do {
            try await dependencies.dailyLogs.submit(draft, projectID: project.id, organizationID: organizationID)
            dismiss()
        } catch {
            errorMessage = "This log couldn't be saved. Please try again."
        }
        isSubmitting = false
    }

    private func importPhotos() async {
        guard !photoSelection.isEmpty else { return }
        isImportingPhotos = true
        defer {
            isImportingPhotos = false
            photoSelection = []
        }
        for item in photoSelection {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let normalizedData = UIImage(data: data)?.jpegData(compressionQuality: 0.88) ?? data
            let type = item.supportedContentTypes.first ?? .jpeg
            let isJPEG = UIImage(data: data) != nil
            let mimeType = isJPEG ? "image/jpeg" : (type.preferredMIMEType ?? "image/jpeg")
            let fileName = "site-photo-\(UUID().uuidString).\(isJPEG ? "jpg" : (type.preferredFilenameExtension ?? "jpg"))"
            if let attachment = try? dependencies.dailyLogs.persistAttachment(
                data: normalizedData,
                fileName: fileName,
                mimeType: mimeType
            ) {
                draft.attachments.append(attachment)
            }
        }
    }
}

// MARK: - Composer building blocks

/// Rounded card used to give every composer section the same clean, symmetric
/// frame. Optionally shows a header label and a trailing remove button.
private struct ComposerCard<Content: View>: View {
    var title: String?
    var systemImage: String?
    var onRemove: (() -> Void)?
    @ViewBuilder var content: Content

    init(title: String? = nil, systemImage: String? = nil, onRemove: (() -> Void)? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.systemImage = systemImage
        self.onRemove = onRemove
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if title != nil || onRemove != nil {
                HStack {
                    if let title {
                        Label {
                            Text(title)
                        } icon: {
                            if let systemImage { Image(systemName: systemImage) }
                        }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let onRemove {
                        Button(role: .destructive, action: onRemove) {
                            Image(systemName: "trash").font(.subheadline)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.red)
                    }
                }
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color(.secondarySystemGroupedBackground)))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.primary.opacity(0.05), lineWidth: 1))
    }
}

/// Label-on-the-left input row used inside the detailed-entry cards.
private struct ComposerRow<Content: View>: View {
    let label: String
    @ViewBuilder var content: Content

    var body: some View {
        HStack(spacing: 12) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: 88, alignment: .leading)
            content
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct ComposerPhotoThumb: View {
    let attachment: DailyLogAttachmentDraft
    let onRemove: () -> Void

    var body: some View {
        ZStack {
            AsyncImage(url: URL(filePath: attachment.localPath)) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Color.secondary.opacity(0.1)
            }
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(alignment: .topTrailing) {
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.6))
                    .font(.body)
            }
            .padding(5)
        }
    }
}

private struct MentionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: [String]
    let team: [DailyLogTeamMember]

    var body: some View {
        NavigationStack {
            List {
                if team.isEmpty {
                    ContentUnavailableView(
                        "No team members",
                        systemImage: "person.2",
                        description: Text("This project has no members to mention yet.")
                    )
                } else {
                    Button(selection.count == team.count ? "Clear all" : "Select everyone") {
                        selection = selection.count == team.count ? [] : team.map(\.id)
                    }
                    ForEach(team) { member in
                        Button {
                            if selection.contains(member.id) {
                                selection.removeAll { $0 == member.id }
                            } else {
                                selection.append(member.id)
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(member.name).foregroundStyle(.primary)
                                    if let role = member.role {
                                        Text(role).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if selection.contains(member.id) {
                                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .navigationTitle("Mentions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct WorkEntryCard: View {
    @Binding var entry: DailyLogWorkDraft
    let scheduleItems: [DailyLogScheduleOption]
    let onRemove: () -> Void

    var body: some View {
        ComposerCard(title: "Work performed", systemImage: "hammer", onRemove: onRemove) {
            VStack(spacing: 0) {
                ComposerRow(label: "Schedule") {
                    Picker("", selection: $entry.scheduleItemId) {
                        Text("None").tag(String?.none)
                        ForEach(scheduleItems) { Text($0.name).tag(String?.some($0.id)) }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .tint(.primary)
                }
                .onChange(of: entry.scheduleItemId) {
                    guard let id = entry.scheduleItemId,
                          let option = scheduleItems.first(where: { $0.id == id }) else { return }
                    entry.trade = option.trade ?? entry.trade
                    entry.location = option.location ?? entry.location
                }
                rowDivider
                TextField("Description", text: $entry.description, axis: .vertical)
                    .lineLimit(1...4)
                rowDivider
                ComposerRow(label: "Hours") {
                    TextField("0", value: $entry.hours, format: .number).keyboardType(.decimalPad)
                }
                rowDivider
                ComposerRow(label: "Progress") {
                    HStack(spacing: 2) {
                        TextField("0", value: $entry.progress, format: .number).keyboardType(.decimalPad)
                        Text("%").foregroundStyle(.secondary)
                    }
                }
                rowDivider
                ComposerRow(label: "Trade") { TextField("e.g. Framing", text: $entry.trade) }
                rowDivider
                ComposerRow(label: "Location") { TextField("e.g. East wing", text: $entry.location) }
            }
        }
    }

    private var rowDivider: some View { Divider().padding(.vertical, 10) }
}

private struct InspectionEntryCard: View {
    @Binding var entry: DailyLogInspectionDraft
    let scheduleItems: [DailyLogScheduleOption]
    let onRemove: () -> Void

    var body: some View {
        ComposerCard(title: "Inspection", systemImage: "checkmark.seal", onRemove: onRemove) {
            VStack(spacing: 0) {
                ComposerRow(label: "Schedule") {
                    Picker("", selection: $entry.scheduleItemId) {
                        Text("None").tag(String?.none)
                        ForEach(scheduleItems) { Text($0.name).tag(String?.some($0.id)) }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .tint(.primary)
                }
                Divider().padding(.vertical, 10)
                ComposerRow(label: "Result") {
                    Picker("", selection: $entry.result) {
                        Text("Not selected").tag(String?.none)
                        Text("Pass").tag(String?.some("pass"))
                        Text("Fail").tag(String?.some("fail"))
                        Text("Partial").tag(String?.some("partial"))
                        Text("N/A").tag(String?.some("n_a"))
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .tint(.primary)
                }
                Divider().padding(.vertical, 10)
                TextField("Notes", text: $entry.notes, axis: .vertical)
                    .lineLimit(1...4)
            }
        }
    }
}

private struct TaskUpdateCard: View {
    @Binding var entry: DailyLogTaskUpdateDraft
    let tasks: [DailyLogTaskOption]
    let onRemove: () -> Void

    var body: some View {
        ComposerCard(title: "Task update", systemImage: "checkmark.circle", onRemove: onRemove) {
            VStack(spacing: 0) {
                ComposerRow(label: "Task") {
                    Picker("", selection: $entry.taskId) {
                        Text("Select a task").tag(String?.none)
                        ForEach(tasks) { Text($0.title).tag(String?.some($0.id)) }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .tint(.primary)
                }
                Divider().padding(.vertical, 10)
                Toggle("Mark complete", isOn: $entry.markComplete)
            }
        }
    }
}

private struct PunchUpdateCard: View {
    @Binding var entry: DailyLogPunchUpdateDraft
    let punchItems: [DailyLogPunchOption]
    let onRemove: () -> Void

    var body: some View {
        ComposerCard(title: "Punch update", systemImage: "wrench.and.screwdriver", onRemove: onRemove) {
            VStack(spacing: 0) {
                ComposerRow(label: "Punch item") {
                    Picker("", selection: $entry.punchItemId) {
                        Text("Select a punch item").tag(String?.none)
                        ForEach(punchItems) { Text($0.title).tag(String?.some($0.id)) }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .tint(.primary)
                }
                Divider().padding(.vertical, 10)
                Toggle("Mark closed", isOn: $entry.markClosed)
            }
        }
    }
}

private struct MentionPicker: View {
    let title: String
    @Binding var selection: [String]
    let team: [DailyLogTeamMember]

    var body: some View {
        DisclosureGroup {
            if team.isEmpty {
                Text("No project team members available").foregroundStyle(.secondary)
            } else {
                Button(selection.count == team.count ? "Clear All" : "Mention Everyone") {
                    selection = selection.count == team.count ? [] : team.map(\.id)
                }
                ForEach(team) { member in
                    Button {
                        if selection.contains(member.id) {
                            selection.removeAll { $0 == member.id }
                        } else {
                            selection.append(member.id)
                        }
                    } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(member.name).foregroundStyle(.primary)
                                if let role = member.role { Text(role).font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            if selection.contains(member.id) {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        } label: {
            HStack {
                Label(title, systemImage: "at")
                Spacer()
                if !selection.isEmpty { Text("\(selection.count)").foregroundStyle(.secondary) }
            }
        }
    }
}

private struct CameraPicker: UIViewControllerRepresentable {
    let onCapture: (Data) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let parent: CameraPicker
        init(parent: CameraPicker) { self.parent = parent }

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

private enum DailyLogDate {
    private static let input: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func date(_ value: String) -> Date { input.date(from: value) ?? .distantPast }
    static func key(for date: Date) -> String { input.string(from: date) }
    static var todayKey: String { key(for: .now) }
    static func weekdayLetter(_ value: String) -> String {
        String(date(value).formatted(.dateTime.weekday(.narrow)))
    }

    /// Day keys for the trailing `count` days, oldest first, ending today.
    static func recentKeys(count: Int) -> [String] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: .now)
        return (0..<count).reversed().compactMap { offset in
            calendar.date(byAdding: .day, value: -offset, to: today).map(key(for:))
        }
    }

    static func month(_ value: String) -> String { date(value).formatted(.dateTime.month(.abbreviated)).uppercased() }
    static func day(_ value: String) -> String { date(value).formatted(.dateTime.day()) }
    static func full(_ value: String) -> String { date(value).formatted(date: .long, time: .omitted) }
    static func isToday(_ value: String) -> Bool { Calendar.current.isDateInToday(date(value)) }
    static func relativeTitle(_ value: String) -> String {
        let parsed = date(value)
        if Calendar.current.isDateInToday(parsed) { return "Today" }
        if Calendar.current.isDateInYesterday(parsed) { return "Yesterday" }
        return parsed.formatted(.dateTime.weekday(.wide))
    }
}

private enum DailyLogWeather {
    static func symbol(_ weather: String) -> String {
        let value = weather.lowercased()
        if value.contains("rain") { return "cloud.rain" }
        if value.contains("cloud") { return "cloud.sun" }
        if value.contains("wind") { return "wind" }
        if value.contains("hot") { return "thermometer.sun" }
        return "sun.max"
    }
}
