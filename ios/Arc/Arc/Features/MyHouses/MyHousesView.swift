import SwiftUI

/// The superintendent's home surface: every assigned house at once, with no
/// project selected and none required.
///
/// The primary grouping is by *activity*, not by house, because that is how the
/// job is actually run — one trade sweeps six lots in a morning, so "Frame
/// inspection · 6" is the unit of work, and each lot under it completes in
/// place. The per-house roster is the secondary view and the way into the
/// existing single-project workspace.
struct MyHousesView: View {
    private enum Segment: String, CaseIterable, Identifiable {
        case work = "Work"
        case houses = "Houses"
        var id: Self { self }
    }

    @Environment(AppDependencies.self) private var dependencies
    @State private var segment: Segment = .work
    @State private var varianceHouse: MobileMyHouse?
    @State private var hapticTick = 0

    let onOpenProject: (String) -> Void

    private var store: MyHousesStore { dependencies.myHouses }
    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }

    private var isWarmingUp: Bool {
        (store.isLoadingHouses || store.isLoadingWork) && store.houses.isEmpty && store.workGroups.isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                    .arcReveal()

                vitals
                    .arcReveal(delay: 0.06)

                Picker("View", selection: $segment.animation(.easeInOut(duration: 0.2))) {
                    ForEach(Segment.allCases) { value in
                        Text(label(for: value)).tag(value)
                    }
                }
                .pickerStyle(.segmented)
                .arcReveal(delay: 0.10)

                switch segment {
                case .work: workSection.arcReveal(delay: 0.14)
                case .houses: housesSection.arcReveal(delay: 0.14)
                }
            }
            .frame(maxWidth: 640, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20)
            .padding(.top, 6)
            .padding(.bottom, 36)
        }
        .background(ArcAmbientBackground())
        .navigationTitle("My Houses")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await refresh() }
        .task { await load() }
        .sheet(item: $varianceHouse) { house in
            VarianceOrderComposerView(house: house)
        }
        .alert("Couldn't update", isPresented: Binding(
            get: { store.actionError != nil },
            set: { if !$0 { store.actionError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.actionError ?? "")
        }
        .sensoryFeedback(.impact(flexibility: .soft, intensity: 0.7), trigger: hapticTick)
    }

    private func label(for value: Segment) -> String {
        switch value {
        case .work:
            let count = store.openWorkItemCount
            return count > 0 ? "Work (\(count))" : "Work"
        case .houses:
            let count = store.houses.count
            return count > 0 ? "Houses (\(count))" : "Houses"
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(Self.todayEyebrow)
                .font(.footnote.weight(.semibold))
                .kerning(1.2)
                .foregroundStyle(.secondary)
            Text("My Houses")
                .font(.system(.largeTitle, design: .rounded, weight: .bold))
            if store.isUsingOfflineData {
                Label("Showing your last synced houses", systemImage: "wifi.slash")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Vitals

    private var vitals: some View {
        ArcGlassCard(padding: 0) {
            HStack(spacing: 0) {
                vital(value: store.houses.count, label: "Houses", tint: .primary)
                Divider().frame(height: 34)
                vital(
                    value: store.lateItemCount,
                    label: store.lateItemCount == 1 ? "Late item" : "Late items",
                    tint: store.lateItemCount > 0 ? .red : .primary
                )
                Divider().frame(height: 34)
                vital(
                    value: store.missingLogCount,
                    label: "Missing logs",
                    tint: store.missingLogCount > 0 ? .orange : .primary
                )
            }
            .padding(.vertical, 16)
        }
        .redacted(reason: isWarmingUp ? .placeholder : [])
    }

    private func vital(value: Int, label: String, tint: Color) -> some View {
        VStack(spacing: 3) {
            Text("\(value)")
                .font(.title2.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(tint)
                .contentTransition(.numericText())
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Work (grouped by activity)

    @ViewBuilder
    private var workSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker("Window", selection: Binding(
                get: { store.window },
                set: { newValue in
                    guard let organizationID else { return }
                    hapticTick += 1
                    Task { await store.selectWindow(newValue, organizationID: organizationID) }
                }
            )) {
                ForEach(MyHouseWorkWindow.allCases) { value in
                    Text(value.title).tag(value)
                }
            }
            .pickerStyle(.segmented)

            if store.isLoadingWork && store.workGroups.isEmpty {
                ForEach(0 ..< 2, id: \.self) { _ in workGroupSkeleton }
            } else if let message = store.workError, store.workGroups.isEmpty {
                ArcGlassCard {
                    ContentUnavailableView {
                        Label("Work unavailable", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try Again") { Task { await refresh() } }
                            .buttonStyle(.bordered)
                    }
                }
            } else if store.workGroups.isEmpty {
                ArcGlassCard {
                    ContentUnavailableView(
                        "Nothing scheduled",
                        systemImage: "checkmark.seal",
                        description: Text("No open activity across your houses \(store.window.title.lowercased()).")
                    )
                }
            } else {
                ForEach(store.workGroups) { group in
                    workGroupCard(group)
                }
            }
        }
    }

    private var workGroupSkeleton: some View {
        ArcGlassCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Frame inspection").font(.headline)
                ForEach(0 ..< 3, id: \.self) { _ in
                    Text("Lot 24 · Wildwood Ridge").font(.subheadline)
                }
            }
        }
        .redacted(reason: .placeholder)
    }

    private func workGroupCard(_ group: MobileMyHouseWorkGroup) -> some View {
        let remaining = group.items.filter { !store.completedItemIDs.contains($0.id) }.count
        return ArcGlassCard(padding: 0) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(group.groupLabel)
                        .font(.headline)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    Text("\(remaining)")
                        .font(.subheadline.weight(.bold))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .foregroundStyle(remaining == 0 ? Color.secondary : .primary)
                }
                .padding(.horizontal, 18)
                .padding(.top, 16)
                .padding(.bottom, 10)

                VStack(spacing: 0) {
                    ForEach(Array(group.items.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { Divider().padding(.leading, 56) }
                        workRow(item)
                    }
                }
                .padding(.bottom, 6)
            }
        }
    }

    private func workRow(_ item: MobileMyHouseWorkItem) -> some View {
        let isDone = store.completedItemIDs.contains(item.id)
        let isQueued = store.queuedItemIDs.contains(item.id)
        return HStack(alignment: .top, spacing: 12) {
            Button {
                guard let organizationID, !isDone else { return }
                hapticTick += 1
                Task { await store.complete(item, organizationID: organizationID) }
            } label: {
                Image(systemName: isDone ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isDone ? Color.accentColor : .secondary)
                    .frame(width: 30, height: 30)
                    .contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(.plain)
            .disabled(isDone)
            .accessibilityLabel(isDone ? "Completed" : "Complete \(item.name) at \(item.lotText)")

            Button {
                onOpenProject(item.projectId)
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.lotText)
                        .font(.subheadline.weight(.semibold))
                        .strikethrough(isDone, color: .secondary)
                        .foregroundStyle(isDone ? .secondary : .primary)
                        .lineLimit(1)
                    HStack(spacing: 8) {
                        if item.daysLate > 0 {
                            Text("\(item.daysLate)d late")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.red)
                        } else if let range = item.dateRangeText {
                            Text(range)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let trade = item.trade, !trade.isEmpty {
                            Text(trade)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        if isQueued {
                            Label("Queued", systemImage: "clock.arrow.circlepath")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 9)
    }

    // MARK: - Houses (roster)

    @ViewBuilder
    private var housesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            if store.isLoadingHouses && store.houses.isEmpty {
                ForEach(0 ..< 3, id: \.self) { _ in
                    houseCard(.placeholderSample).redacted(reason: .placeholder)
                }
            } else if let message = store.housesError, store.houses.isEmpty {
                ArcGlassCard {
                    ContentUnavailableView {
                        Label("Houses unavailable", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try Again") { Task { await refresh() } }
                            .buttonStyle(.bordered)
                    }
                }
            } else if store.houses.isEmpty {
                ArcGlassCard {
                    ContentUnavailableView(
                        "No houses assigned",
                        systemImage: "house",
                        description: Text("Lots you superintend will appear here once they start.")
                    )
                }
            } else {
                ForEach(store.houses) { house in
                    houseCard(house)
                }
            }
        }
    }

    private func houseCard(_ house: MobileMyHouse) -> some View {
        Button {
            onOpenProject(house.projectId)
        } label: {
            ArcGlassCard(padding: 16, cornerRadius: 20) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(house.lotLabel)
                            .font(.headline)
                        Text(house.communityName)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 6)
                        Text("\(house.percentComplete)%")
                            .font(.subheadline.weight(.bold))
                            .monospacedDigit()
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }

                    HStack(spacing: 8) {
                        if let phase = house.phaseLabel {
                            StatusBadge(text: phase, tint: BrandTheme.brightBlue)
                        }
                        if let plan = house.planText {
                            Text(plan)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }

                    HStack(spacing: 14) {
                        scheduleFact(for: house)
                        if house.lateCount > 0 {
                            fact(
                                text: "\(house.lateCount) late",
                                systemImage: "exclamationmark.triangle.fill",
                                tint: .red
                            )
                        }
                        if house.openPunch > 0 {
                            fact(text: "\(house.openPunch) punch", systemImage: "exclamationmark.bubble")
                        }
                        Spacer(minLength: 0)
                        fact(
                            text: house.lastLogText,
                            systemImage: "book.pages",
                            tint: house.hasLog(on: MobileDateParser.todayKey) ? .secondary : .orange
                        )
                    }
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .buttonStyle(.arcPress)
        .accessibilityIdentifier("my-house-\(house.projectId)")
        .contextMenu {
            Button {
                varianceHouse = house
            } label: {
                Label("New Variance PO", systemImage: "dollarsign.arrow.circlepath")
            }
            Button {
                onOpenProject(house.projectId)
            } label: {
                Label("Open House", systemImage: "house")
            }
        }
    }

    @ViewBuilder
    private func scheduleFact(for house: MobileMyHouse) -> some View {
        if let delta = house.daysVersusTarget {
            fact(
                text: delta > 0 ? "+\(delta)d vs target" : "\(delta)d vs target",
                systemImage: "calendar",
                tint: delta > 0 ? .red : .green
            )
        } else {
            fact(text: "Day \(house.daysInProgress)", systemImage: "calendar")
        }
    }

    private func fact(text: String, systemImage: String, tint: Color = .secondary) -> some View {
        Label(text, systemImage: systemImage)
            .font(.caption)
            .foregroundStyle(tint)
            .lineLimit(1)
    }

    // MARK: - Data

    private func load() async {
        guard let organizationID else { return }
        await store.load(organizationID: organizationID)
    }

    private func refresh() async {
        guard let organizationID else { return }
        await store.refresh(organizationID: organizationID)
    }

    private static let eyebrowFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("EEEEMMMMd")
        return formatter
    }()

    private static var todayEyebrow: String {
        eyebrowFormatter.string(from: .now).uppercased()
    }
}

private extension MobileMyHouse {
    /// Shape-accurate stand-in for the loading skeleton.
    static let placeholderSample = MobileMyHouse(
        projectId: "placeholder",
        lotLabel: "Lot 24",
        communityId: "placeholder",
        communityName: "Wildwood Ridge",
        planCode: "2410",
        elevationCode: "B",
        startDate: nil,
        targetDays: 120,
        daysInProgress: 96,
        percentComplete: 62,
        currentPhase: "framing",
        lateCount: 0,
        openPunch: 0,
        openTasks: 0,
        lastDailyLogDate: nil
    )
}

#Preview {
    NavigationStack {
        MyHousesView(onOpenProject: { _ in })
    }
    .environment(AppDependencies())
}
