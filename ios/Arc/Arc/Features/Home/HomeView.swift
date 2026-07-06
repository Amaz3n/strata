import SwiftUI

/// The Overview tab — a builder's morning briefing for the selected project.
/// Reference implementation of the Liquid Glass redesign (see GlassKit.swift):
/// ambient brand light, one signature "site pulse" card, and sections that
/// only appear when they have something to say.
struct ProjectDashboardView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(AppRouter.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let project: MobileProject

    @State private var ringProgress: Double = 0
    @State private var hapticTick = 0

    private var organizationID: String? { dependencies.workspace.selectedOrganizationID }
    private var schedule: ScheduleStore { dependencies.schedule }
    private var field: FieldStore { dependencies.field }
    private var dailyLogs: DailyLogStore { dependencies.dailyLogs }

    // MARK: Derived vitals

    private var activeItems: [MobileScheduleItem] {
        schedule.items.filter { $0.status != "cancelled" }
    }

    private var completedCount: Int { activeItems.filter(\.isComplete).count }

    private var scheduleFraction: Double {
        activeItems.isEmpty ? 0 : Double(completedCount) / Double(activeItems.count)
    }

    private var overdueCount: Int {
        schedule.items.filter { $0.statusGroup == .overdue }.count
    }

    private var blockedTaskCount: Int {
        field.tasks.filter { $0.status == "blocked" }.count
    }

    private var upcomingItems: [MobileScheduleItem] { schedule.upcoming() }

    private var isWarmingUp: Bool {
        schedule.isLoading && schedule.items.isEmpty
    }

    private var hasLogToday: Bool {
        dailyLogs.logs.contains { $0.date.hasPrefix(Self.todayKey) }
    }

    // MARK: Body

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                header
                    .arcReveal()

                pulseCard
                    .arcReveal(delay: 0.06)

                if overdueCount > 0 || blockedTaskCount > 0 {
                    attention
                        .arcReveal(delay: 0.12)
                }

                capture
                    .arcReveal(delay: 0.16)

                upNext
                    .arcReveal(delay: 0.22)
                    .arcScrollDepth()

                recentLogs
                    .arcReveal(delay: 0.28)
                    .arcScrollDepth()
            }
            .frame(maxWidth: 640, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20)
            .padding(.top, 6)
            .padding(.bottom, 36)
        }
        .background(ArcAmbientBackground())
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .projectSwitcherPullOrRefresh { await load(force: true) }
        .task { await load(force: false) }
        .onChange(of: scheduleFraction, initial: true) { _, newValue in
            if reduceMotion {
                ringProgress = newValue
            } else {
                withAnimation(.spring(response: 1.1, dampingFraction: 0.85).delay(0.25)) {
                    ringProgress = newValue
                }
            }
        }
        .sensoryFeedback(.impact(flexibility: .soft, intensity: 0.7), trigger: hapticTick)
    }

    /// Navigation with the shared soft haptic tick.
    private func go(_ route: AppRoute) {
        hapticTick += 1
        router.navigate(to: route)
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(Self.todayEyebrow)
                .font(.footnote.weight(.semibold))
                .kerning(1.2)
                .foregroundStyle(.secondary)
            Text(project.name)
                .font(.system(.largeTitle, design: .rounded, weight: .bold))
                .lineLimit(2)
                .minimumScaleFactor(0.75)
            HStack(spacing: 8) {
                StatusBadge(status: project.status)
                if let address = project.address {
                    Text(address)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Site pulse

    private var healthHeadline: String {
        if activeItems.isEmpty { return "No schedule yet" }
        if overdueCount > 0 { return "\(overdueCount) overdue" }
        return "On track"
    }

    private var healthTint: Color {
        if activeItems.isEmpty { return .secondary }
        return overdueCount > 0 ? .red : .primary
    }

    private var healthDetail: String {
        if activeItems.isEmpty { return "Plan the job on the web to see progress here." }
        return "\(completedCount) of \(activeItems.count) items complete"
    }

    private var pulseCard: some View {
        ArcGlassCard(padding: 0) {
            VStack(spacing: 0) {
                Button {
                    go(.schedule)
                } label: {
                    HStack(spacing: 16) {
                        ZStack {
                            ArcProgressRing(progress: ringProgress)
                                .frame(width: 62, height: 62)
                            Text("\(Int((ringProgress * 100).rounded()))%")
                                .font(.subheadline.weight(.bold))
                                .monospacedDigit()
                                .contentTransition(.numericText())
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Schedule")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(healthHeadline)
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(healthTint)
                                .contentTransition(.numericText())
                            Text(healthDetail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(18)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.arcPress)

                Divider()
                    .padding(.horizontal, 18)

                HStack(spacing: 0) {
                    pulseStat(value: field.openTaskCount, label: "Open tasks") { go(.tasks) }
                    statDivider
                    pulseStat(value: field.openPunchCount, label: "Punch items") { go(.punch) }
                    statDivider
                    pulseStat(value: upcomingItems.count, label: "This week") { go(.schedule) }
                }
                .padding(.vertical, 12)
            }
        }
        .redacted(reason: isWarmingUp ? .placeholder : [])
    }

    private var statDivider: some View {
        Divider().frame(height: 30)
    }

    private func pulseStat(value: Int, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Text("\(value)")
                    .font(.title3.weight(.bold))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.arcPress)
    }

    // MARK: Needs attention (adaptive — hidden when the site is calm)

    private var attention: some View {
        VStack(alignment: .leading, spacing: 10) {
            ArcSectionLabel(title: "Needs attention")
            HStack(spacing: 10) {
                if overdueCount > 0 {
                    attentionChip(
                        count: overdueCount,
                        label: overdueCount == 1 ? "Overdue item" : "Overdue items",
                        systemImage: "exclamationmark.circle.fill",
                        tint: .red
                    ) { go(.schedule) }
                }
                if blockedTaskCount > 0 {
                    attentionChip(
                        count: blockedTaskCount,
                        label: blockedTaskCount == 1 ? "Blocked task" : "Blocked tasks",
                        systemImage: "hand.raised.fill",
                        tint: .orange
                    ) { go(.tasks) }
                }
            }
        }
    }

    private func attentionChip(
        count: Int, label: String, systemImage: String, tint: Color, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.body)
                    .foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 0) {
                    Text("\(count)")
                        .font(.callout.weight(.bold))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                    Text(label)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity)
            .liquidGlass(in: RoundedRectangle(cornerRadius: 18, style: .continuous), interactive: true)
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(tint.opacity(0.25), lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.arcPress)
    }

    // MARK: Capture

    private var capture: some View {
        VStack(alignment: .leading, spacing: 10) {
            ArcSectionLabel(title: "Capture")
            HStack(spacing: 12) {
                captureButton(
                    title: "New Daily Log",
                    subtitle: hasLogToday ? "One logged today" : "Nothing logged today",
                    systemImage: "square.and.pencil",
                    tint: BrandTheme.midBlue
                ) {
                    hapticTick += 1
                    router.presentedSheet = .newDailyLog(camera: false)
                }
                captureButton(
                    title: "Scan Receipt",
                    subtitle: "Capture an expense",
                    systemImage: "doc.viewfinder",
                    tint: .green
                ) { go(.scanReceipt) }
            }
            .glassGroup(spacing: 12)
        }
    }

    private func captureButton(
        title: String, subtitle: String, systemImage: String, tint: Color, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 12) {
                Image(systemName: systemImage)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(tint.gradient, in: Circle())
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .liquidGlass(in: RoundedRectangle(cornerRadius: 22, style: .continuous), interactive: true)
            .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
        .buttonStyle(.arcPress)
    }

    // MARK: Up next

    private var upNext: some View {
        VStack(alignment: .leading, spacing: 10) {
            ArcSectionLabel(title: "Up next", actionTitle: "Schedule") { go(.schedule) }
            ArcGlassCard {
                let upcoming = Array(upcomingItems.prefix(4))
                if upcoming.isEmpty {
                    Text(isWarmingUp ? "Loading schedule…" : "Nothing scheduled in the next week.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 4)
                } else {
                    timeline(upcoming)
                }
            }
            .redacted(reason: isWarmingUp ? .placeholder : [])
        }
    }

    /// Vertical spine threading through the status dots — the schedule reads
    /// as a path through the week, not a table.
    private func timeline(_ items: [MobileScheduleItem]) -> some View {
        VStack(spacing: 0) {
            ForEach(items) { item in
                HStack(spacing: 14) {
                    Circle()
                        .fill(ArcStatusColor.color(for: item.status))
                        .frame(width: 9, height: 9)
                        .background(Circle().stroke(.background, lineWidth: 3))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.name)
                            .font(.subheadline.weight(.medium))
                            .lineLimit(1)
                        if let range = item.dateRangeText {
                            Text(range)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 8)
                    if item.isCriticalPath {
                        Image(systemName: "bolt.fill")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .accessibilityLabel("Critical path")
                    }
                }
                .padding(.vertical, 9)
            }
        }
        .background(alignment: .leading) {
            RoundedRectangle(cornerRadius: 1)
                .fill(.quaternary)
                .frame(width: 2)
                .padding(.leading, 3.5)
                .padding(.vertical, 16)
        }
    }

    // MARK: Recent logs

    @ViewBuilder
    private var recentLogs: some View {
        let recent = Array(dailyLogs.logs.prefix(3))
        if !recent.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                ArcSectionLabel(title: "Recent logs")
                VStack(spacing: 10) {
                    ForEach(recent) { log in
                        logRow(log)
                    }
                }
            }
        }
    }

    private func logRow(_ log: MobileDailyLog) -> some View {
        Button {
            go(.dailyLog(id: log.id))
        } label: {
            ArcGlassCard(padding: 14, cornerRadius: 20) {
                HStack(spacing: 14) {
                    dateBlock(for: log.date)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(Self.relativeDayTitle(for: log.date))
                            .font(.subheadline.weight(.semibold))
                        Text(log.summary?.isEmpty == false ? log.summary! : "No summary")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    if log.photoCount > 0 {
                        Label("\(log.photoCount)", systemImage: "photo")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .buttonStyle(.arcPress)
    }

    /// Compact calendar block — weekday over day number — so a stack of logs
    /// scans like a week at a glance.
    private func dateBlock(for rawDate: String) -> some View {
        let date = MobileDateParser.dateOnly(rawDate)
        return VStack(spacing: 0) {
            Text(date.map { Self.weekdayFormatter.string(from: $0).uppercased() } ?? "—")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(BrandTheme.midBlue)
            Text(date.map { Self.dayNumberFormatter.string(from: $0) } ?? "—")
                .font(.title3.weight(.bold))
                .monospacedDigit()
        }
        .frame(width: 42, height: 44)
        .background(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(BrandTheme.midBlue.opacity(0.08))
        )
    }

    // MARK: Data

    private func load(force: Bool) async {
        guard let organizationID else { return }
        await schedule.load(projectID: project.id, organizationID: organizationID, force: force)
        await field.load(projectID: project.id, organizationID: organizationID, force: force)
        await dailyLogs.load(projectID: project.id, organizationID: organizationID, force: force)
    }

    // MARK: Formatting

    private static let eyebrowFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("EEEEMMMMd")
        return formatter
    }()

    private static let weekdayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("EEE")
        return formatter
    }()

    private static let dayNumberFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("d")
        return formatter
    }()

    private static let dateKeyFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static var todayEyebrow: String {
        eyebrowFormatter.string(from: .now).uppercased()
    }

    private static var todayKey: String {
        dateKeyFormatter.string(from: .now)
    }

    private static func relativeDayTitle(for rawDate: String) -> String {
        guard let date = MobileDateParser.dateOnly(rawDate) else { return rawDate }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return MobileDateParser.shortFormatter.string(from: date)
    }
}

#Preview {
    NavigationStack {
        ProjectDashboardView(
            project: MobileProject(
                id: "preview-project",
                organizationId: "preview-org",
                name: "Hillcrest Residence",
                status: "active",
                address: "214 Hillcrest Ave, Austin",
                startDate: nil,
                endDate: nil,
                updatedAt: .now
            )
        )
    }
    .environment(AppDependencies())
    .environment(AppRouter())
}
