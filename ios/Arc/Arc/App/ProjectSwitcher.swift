import SwiftUI

// MARK: - Interaction model

/// Drives the pull-to-reveal project switcher.
/// - `pullProgress` (0→1) tracks the overscroll pull and traces the indicator.
/// - `progress` (0→1) is the panel's open state.
@MainActor
@Observable
final class ProjectSwitcherModel {
    /// Panel open state. 0 = closed, 1 = open.
    var progress: CGFloat = 0
    /// Live overscroll pull, normalized to the trigger threshold.
    var pullProgress: CGFloat = 0
    /// True only while a finger drives `progress` (the dismiss grabber).
    var isDragging = false
    /// Measured panel height, so the closed panel parks fully off-screen.
    var panelHeight: CGFloat = 320

    var isOpen: Bool { progress >= 0.999 }

    /// Opens with a hair of overshoot so the panel lands, not arrives.
    func open() {
        isDragging = false
        pullProgress = 0
        withAnimation(.spring(response: 0.42, dampingFraction: 0.80)) { progress = 1 }
    }

    /// Closes tighter than it opens — dismissal should feel immediate.
    func close() {
        isDragging = false
        pullProgress = 0
        withAnimation(.spring(response: 0.30, dampingFraction: 0.92)) { progress = 0 }
    }
}

// MARK: - Pull enablement (root vs pushed)

/// True on a workspace tab root, where the pull-to-refresh gesture opens the
/// switcher. False (default) on pushed detail screens, which keep data refresh.
private struct ProjectSwitcherPullEnabledKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var projectSwitcherPullEnabled: Bool {
        get { self[ProjectSwitcherPullEnabledKey.self] }
        set { self[ProjectSwitcherPullEnabledKey.self] = newValue }
    }
}

// MARK: - Easing

/// Ease-out cubic — fast start, soft landing. Used to shape the panel's open
/// amount; never applied to live finger tracking, which must stay 1:1.
private func easeOut(_ x: CGFloat) -> CGFloat {
    let clamped = max(0, min(1, x))
    return 1 - pow(1 - clamped, 3)
}

// MARK: - Pull tracker

extension View {
    /// On a tab root, replaces the system pull-to-refresh with the tracing-square
    /// switcher reveal. On pushed screens (or when disabled), performs the given
    /// data refresh instead. Apply directly to the scroll view / list.
    func projectSwitcherPullOrRefresh(_ refresh: @escaping () async -> Void) -> some View {
        modifier(PullOrRefreshModifier(refresh: refresh))
    }
}

private struct PullOrRefreshModifier: ViewModifier {
    @Environment(ProjectSwitcherModel.self) private var model: ProjectSwitcherModel?
    @Environment(\.projectSwitcherPullEnabled) private var pullEnabled
    @State private var armed = false

    let refresh: () async -> Void
    private let threshold: CGFloat = 92

    func body(content: Content) -> some View {
        if pullEnabled, let model {
            if #available(iOS 18.0, *) {
                content.onScrollGeometryChange(for: CGFloat.self) { geo in
                    max(0, -(geo.contentInsets.top + geo.contentOffset.y))
                } action: { _, pull in
                    guard !model.isOpen else { return }
                    // Dead-zone so a resting scroll offset never traces the square.
                    let pulled = max(0, pull - 8)
                    model.pullProgress = min(1, pulled / threshold)
                    if pulled >= threshold {
                        if !armed {
                            armed = true
                            model.open()
                        }
                    } else if pulled <= 0 {
                        armed = false
                    }
                }
            } else {
                // iOS 17 fallback: native pull-to-refresh opens the switcher.
                content.refreshable { model.open() }
            }
        } else {
            content.refreshable { await refresh() }
        }
    }
}

// MARK: - Tracing-square indicator

/// A sharp square whose outline traces closed from the top-center as you pull
/// — a nod to the squared arch of the Arc mark — then hands off to the panel.
private struct TracingSquare: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.minY))
        return path
    }
}

/// Owns every per-frame read of `pullProgress` (and its stepped haptics), so a
/// live pull redraws only this 26pt view — never the panel or scrim.
private struct SwitcherPullIndicator: View {
    let model: ProjectSwitcherModel

    var body: some View {
        let pull = min(1, model.pullProgress)
        let open = min(1, model.progress)
        // Discrete steps as the square traces, for ratchet-like haptics.
        let pullStep = model.isOpen ? -1 : Int(pull / 0.2)

        ZStack {
            TracingSquare()
                .stroke(.secondary.opacity(0.22), style: StrokeStyle(lineWidth: 2, lineJoin: .miter))
            TracingSquare()
                .trim(from: 0, to: pull)
                .stroke(
                    .primary.opacity(0.55 + 0.45 * pull),
                    style: StrokeStyle(lineWidth: 2.5, lineCap: .butt, lineJoin: .miter)
                )
        }
        .frame(width: 26, height: 26)
        // Grows toward you as the pull commits, so completion reads as arrival.
        .scaleEffect((0.55 + 0.45 * pull) * (1 + 0.5 * open))
        // Parked behind the dynamic island; tracks the finger 1:1 down into the
        // pull slot. Once the panel takes over it scales up and dissolves.
        .offset(y: -46 + pull * 104)
        .opacity(open > 0.02 ? Double(max(0, 1 - open * 4)) : Double(min(1, pull * 1.4)))
        .allowsHitTesting(false)
        .sensoryFeedback(trigger: pullStep) { old, new in
            new > old && !model.isOpen ? .selection : nil
        }
    }
}

// MARK: - Floating glass panel

private struct PanelHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 320
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct ProjectSwitcherPanel: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(ProjectSwitcherModel.self) private var model

    let currentProjectID: String
    let onSelectProject: (String) -> Void

    @State private var query = ""
    @FocusState private var searchFocused: Bool

    private var allProjects: [MobileProject] { dependencies.workspace.projects }

    /// Search earns its place only when the list is long enough to need it —
    /// with a handful of projects the fastest path is a straight tap.
    private var showsSearch: Bool { allProjects.count > 6 }

    private var projects: [MobileProject] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard showsSearch, !term.isEmpty else { return allProjects }
        return allProjects.filter { $0.name.localizedCaseInsensitiveContains(term) }
    }

    var body: some View {
        VStack(spacing: 8) {
            grabber
            if showsSearch {
                searchField
            }
            projectList
        }
        .padding(.top, 6)
        .padding(.bottom, 12)
        .frame(maxWidth: 340)
        .liquidGlass(in: RoundedRectangle(cornerRadius: 36, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 36, style: .continuous)
                .stroke(.white.opacity(0.10), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.28), radius: 32, y: 18)
        .background(
            GeometryReader { geo in
                Color.clear.preference(key: PanelHeightKey.self, value: geo.size.height)
            }
        )
        .onPreferenceChange(PanelHeightKey.self) { height in
            if height > 0 { model.panelHeight = height }
        }
        .onChange(of: model.isOpen) { _, open in
            // The keyboard never raises itself — a quick switch is a tap, not a
            // search. Focus arrives only when the field is touched.
            if !open {
                searchFocused = false
                query = ""
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextField("Find a project", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($searchFocused)
                .submitLabel(.search)
            if !query.isEmpty {
                Button {
                    withAnimation(.snappy(duration: 0.2)) { query = "" }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .font(.subheadline)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .liquidGlass(in: Capsule())
        .padding(.horizontal, 14)
    }

    private var projectList: some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                if projects.isEmpty {
                    Text(query.isEmpty ? "No projects yet." : "No projects match \u{201C}\(query)\u{201D}.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 20)
                } else {
                    ForEach(projects) { project in
                        projectRow(project)
                    }
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
        .frame(maxHeight: 320)
        .scrollBounceBehavior(.basedOnSize)
        // Rows dissolve at the edges instead of clipping mid-letter.
        .mask(
            VStack(spacing: 0) {
                LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                    .frame(height: 10)
                Color.black
                LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                    .frame(height: 10)
            }
        )
    }

    private func projectRow(_ project: MobileProject) -> some View {
        let isCurrent = project.id == currentProjectID
        return Button {
            onSelectProject(project.id)
        } label: {
            HStack(spacing: 12) {
                ProjectAvatar(projectId: project.id, size: 28, cornerRadius: 7)
                Text(project.name)
                    .font(.subheadline.weight(isCurrent ? .semibold : .medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if isCurrent {
                    Image(systemName: "checkmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tint)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(isCurrent ? Color.primary.opacity(0.06) : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.arcPress)
        .accessibilityIdentifier("switcher-project-\(project.id)")
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
    }

    /// A pull tab at the top: drag it up (or tap the scrim) to dismiss. The
    /// hit target is the full panel width, far beyond the visible capsule.
    private var grabber: some View {
        Capsule()
            .fill(.secondary.opacity(model.isDragging ? 0.65 : 0.4))
            .frame(width: 36, height: 5)
            .frame(maxWidth: .infinity, minHeight: 26)
            .contentShape(Rectangle())
            .animation(.easeOut(duration: 0.15), value: model.isDragging)
            .gesture(
                DragGesture(minimumDistance: 2)
                    .onChanged { value in
                        model.isDragging = true
                        let distance = max(model.panelHeight, 240)
                        // Downward drag past open rubber-bands instead of tracking 1:1.
                        let raw = 1 + value.translation.height / distance
                        model.progress = raw > 1 ? 1 + (raw - 1) * 0.12 : max(0, raw)
                    }
                    .onEnded { value in
                        let flickUp = value.predictedEndTranslation.height < -60
                        if flickUp || model.progress < 0.7 { model.close() } else { model.open() }
                    }
            )
            .accessibilityLabel("Dismiss project switcher")
            .accessibilityAddTraits(.isButton)
    }
}

// MARK: - Overlay wiring

extension View {
    /// Overlays the floating glass switcher panel, the tracing-square pull
    /// indicator, and a dimming scrim above the workspace, sharing one
    /// `ProjectSwitcherModel` with the tab roots' pull tracker.
    func projectSwitcher(
        model: ProjectSwitcherModel,
        currentProjectID: String,
        onSelectProject: @escaping (String) -> Void
    ) -> some View {
        modifier(
            ProjectSwitcherContainer(
                model: model,
                currentProjectID: currentProjectID,
                onSelectProject: onSelectProject
            )
        )
    }
}

/// Thin composition layer. Each overlay child observes only the model state it
/// needs, so a live pull never re-renders the panel and the workspace never
/// transforms — which kept flashing the window background at the top edge.
private struct ProjectSwitcherContainer: ViewModifier {
    @Bindable var model: ProjectSwitcherModel
    let currentProjectID: String
    let onSelectProject: (String) -> Void

    func body(content: Content) -> some View {
        ZStack(alignment: .top) {
            content
            SwitcherScrim(model: model)
            SwitcherPullIndicator(model: model)
            SwitcherPanelHost(
                model: model,
                currentProjectID: currentProjectID,
                onSelectProject: onSelectProject
            )
        }
        .environment(model)
    }
}

/// Scrim — lighter than a modal's; the switcher is a quick visit.
private struct SwitcherScrim: View {
    let model: ProjectSwitcherModel

    var body: some View {
        Color.black
            .opacity(0.32 * Double(min(1, model.progress)))
            .ignoresSafeArea()
            .allowsHitTesting(model.progress > 0.02)
            .onTapGesture { model.close() }
    }
}

/// Positions the panel just below the dynamic island and drives its open
/// transform: it grows out of the square's landing spot with a soft-landing
/// curve instead of zooming from nothing.
private struct SwitcherPanelHost: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let model: ProjectSwitcherModel
    let currentProjectID: String
    let onSelectProject: (String) -> Void

    /// Bumped when a project is chosen, for the selection haptic.
    @State private var selectionTick = 0

    var body: some View {
        let progress = min(1, model.progress)
        let appear = easeOut(progress)

        ProjectSwitcherPanel(
            currentProjectID: currentProjectID,
            onSelectProject: { id in
                selectionTick += 1
                model.close()
                onSelectProject(id)
            }
        )
        .padding(.top, 8)
        .scaleEffect(
            reduceMotion ? 1 : 0.40 + 0.60 * appear,
            anchor: UnitPoint(x: 0.5, y: 0.1)
        )
        .opacity(progress <= 0.001 ? 0 : Double(min(1, progress * 2.6)))
        // Opacity 0 still hit-tests — gate touches until the panel is present.
        .allowsHitTesting(model.progress > 0.1)
        .sensoryFeedback(.selection, trigger: selectionTick)
        .sensoryFeedback(trigger: model.isOpen) { _, open in
            open ? .impact(weight: .medium) : .impact(flexibility: .soft, intensity: 0.6)
        }
    }
}
