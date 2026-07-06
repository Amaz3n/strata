import SwiftUI
import UIKit

struct ProjectDrawingsView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(AppRouter.self) private var router
    @State private var query = ""
    @State private var disciplineFilter: String?
    @State private var setFilter: String?
    let project: MobileProject

    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }
    private var store: DrawingsStore { dependencies.drawings }

    private var visibleSheets: [MobileDrawingSheet] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return store.sheets.filter { sheet in
            let matchesDiscipline = disciplineFilter == nil || sheet.disciplineKey == disciplineFilter
            let matchesSet = setFilter == nil || sheet.drawingSetId == setFilter
            let matchesSearch = term.isEmpty
                || sheet.sheetNumber.lowercased().contains(term)
                || (sheet.sheetTitle?.lowercased().contains(term) ?? false)
            return matchesDiscipline && matchesSet && matchesSearch
        }
    }

    private let columns = [GridItem(.adaptive(minimum: 158), spacing: 14)]

    var body: some View {
        Group {
            if store.isLoading && store.sheets.isEmpty && store.sets.isEmpty {
                ProgressView("Loading drawings…")
            } else if let error = store.errorMessage, store.sheets.isEmpty, store.sets.isEmpty {
                ContentUnavailableView {
                    Label("Couldn't load drawings", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try Again") { Task { await refresh() } }
                        .buttonStyle(.borderedProminent)
                }
            } else if store.sheets.isEmpty && store.sets.isEmpty {
                ContentUnavailableView {
                    Label("No drawings yet", systemImage: "map")
                } description: {
                    Text("Published drawing sets and sheets for this project will appear here.")
                }
            } else {
                content
            }
        }
        .navigationTitle("Drawings")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search sheet number or title")
        .toolbar {
            if !store.sets.isEmpty {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Picker("Set", selection: $setFilter) {
                            Text("All sets").tag(String?.none)
                            ForEach(store.sets) { set in
                                Text(set.title).tag(String?.some(set.id))
                            }
                        }
                    } label: {
                        Label("Filter", systemImage: setFilter == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                    }
                }
            }
        }
        .task(id: project.id) {
            guard let organizationID else { return }
            await store.load(projectID: project.id, organizationID: organizationID)
        }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if !store.disciplineCounts.isEmpty {
                    DisciplineFilterBar(
                        counts: store.disciplineCounts,
                        totalCount: store.sheets.count,
                        selection: $disciplineFilter
                    )
                }

                if visibleSheets.isEmpty {
                    ContentUnavailableView(
                        "No matching sheets",
                        systemImage: "magnifyingglass",
                        description: Text("Try a different search or filter.")
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                } else {
                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(visibleSheets) { sheet in
                            Button {
                                router.navigate(to: .drawingSheet(id: sheet.id))
                            } label: {
                                SheetCard(sheet: sheet)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal)
                }
            }
            .padding(.vertical, 12)
        }
        .projectSwitcherPullOrRefresh { await refresh() }
    }

    private func refresh() async {
        guard let organizationID else { return }
        await store.refresh(projectID: project.id, organizationID: organizationID)
    }
}

// MARK: - Discipline filter

private struct DisciplineFilterBar: View {
    let counts: [(key: String, count: Int)]
    let totalCount: Int
    @Binding var selection: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                DisciplineChip(
                    title: "All",
                    systemImage: "square.grid.2x2",
                    count: totalCount,
                    isSelected: selection == nil
                ) { selection = nil }

                ForEach(counts, id: \.key) { item in
                    DisciplineChip(
                        title: DrawingDisciplinePalette.label(for: item.key),
                        systemImage: DrawingDisciplinePalette.symbol(for: item.key),
                        count: item.count,
                        isSelected: selection == item.key
                    ) {
                        selection = selection == item.key ? nil : item.key
                    }
                }
            }
            .padding(.horizontal)
        }
    }
}

private struct DisciplineChip: View {
    let title: String
    let systemImage: String
    let count: Int
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: systemImage).font(.caption2)
                Text(title).font(.subheadline.weight(.medium))
                Text("\(count)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(isSelected ? Color.white.opacity(0.85) : .secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(
                isSelected ? Color.accentColor : Color(.secondarySystemBackground),
                in: Capsule()
            )
            .foregroundStyle(isSelected ? Color.white : Color.primary)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Sheet card

private struct SheetCard: View {
    let sheet: MobileDrawingSheet

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topTrailing) {
                DrawingThumbnail(url: sheet.thumbnailUrl ?? sheet.imageUrl, discipline: sheet.disciplineKey)
                    .frame(height: 132)
                    .frame(maxWidth: .infinity)
                    .clipped()

                if sheet.openPinsCount > 0 {
                    Label("\(sheet.openPinsCount)", systemImage: "mappin")
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 4)
                        .background(.orange, in: Capsule())
                        .foregroundStyle(.white)
                        .padding(8)
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(sheet.sheetNumber)
                        .font(.subheadline.weight(.bold))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let revision = sheet.currentRevisionLabel {
                        Text(revision)
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color(.tertiarySystemBackground), in: Capsule())
                            .foregroundStyle(.secondary)
                    }
                }
                Text(sheet.sheetTitle ?? DrawingDisciplinePalette.label(for: sheet.disciplineKey))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(10)
        }
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14).strokeBorder(Color(.separator).opacity(0.4), lineWidth: 0.5)
        )
    }
}

struct DrawingThumbnail: View {
    let url: URL?
    let discipline: String

    var body: some View {
        if let url {
            AsyncImage(url: url, transaction: Transaction(animation: .easeIn(duration: 0.2))) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                case .failure:
                    placeholder(failed: true)
                case .empty:
                    ZStack {
                        placeholder(failed: false)
                        ProgressView()
                    }
                @unknown default:
                    placeholder(failed: false)
                }
            }
        } else {
            placeholder(failed: false)
        }
    }

    private func placeholder(failed: Bool) -> some View {
        ZStack {
            Color(.tertiarySystemBackground)
            Image(systemName: failed ? "exclamationmark.triangle" : DrawingDisciplinePalette.symbol(for: discipline))
                .font(.title2)
                .foregroundStyle(.quaternary)
        }
    }
}
