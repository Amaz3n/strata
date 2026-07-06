import SwiftUI

// The Liquid Glass design foundation for the app-wide redesign. The Overview
// tab is the reference implementation; other tabs adopt these pieces as they
// are redesigned. Everything here compiles against the iOS 17 deployment
// target and upgrades itself on iOS 26 via the `liquidGlass` helpers.

// MARK: - Ambient scene backdrop

/// The full-bleed backdrop every redesigned screen sits on: the grouped system
/// background with a whisper of the Arc brand blues glowing in from the top,
/// so Liquid Glass surfaces have real light to refract instead of flat gray.
struct ArcAmbientBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            Color(.systemGroupedBackground)
            RadialGradient(
                colors: [BrandTheme.brightBlue.opacity(colorScheme == .dark ? 0.16 : 0.12), .clear],
                center: UnitPoint(x: 0.15, y: -0.15),
                startRadius: 0,
                endRadius: 460
            )
            RadialGradient(
                colors: [BrandTheme.midBlue.opacity(colorScheme == .dark ? 0.18 : 0.07), .clear],
                center: UnitPoint(x: 1.0, y: 0.0),
                startRadius: 0,
                endRadius: 380
            )
        }
        .ignoresSafeArea()
    }
}

// MARK: - Glass card surface

/// The standard content surface of the redesign: Liquid Glass clipped to a
/// generous continuous corner, with a soft ambient shadow that seats it on the
/// backdrop. Zero-padding variant lets callers compose full-bleed rows.
struct ArcGlassCard<Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    var padding: CGFloat = 18
    var cornerRadius: CGFloat = 26
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .liquidGlass(in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .shadow(
                color: .black.opacity(colorScheme == .dark ? 0.28 : 0.07),
                radius: 16, y: 8
            )
    }
}

// MARK: - Section label

/// Uppercase kerned eyebrow that titles each section, with an optional
/// trailing navigation affordance. Quiet on purpose — the content is the star.
struct ArcSectionLabel: View {
    let title: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title.uppercased())
                .font(.footnote.weight(.semibold))
                .kerning(1.1)
                .foregroundStyle(.secondary)
            Spacer()
            if let actionTitle, let action {
                Button(action: action) {
                    HStack(spacing: 3) {
                        Text(actionTitle)
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                    }
                    .font(.subheadline.weight(.medium))
                }
            }
        }
        .padding(.horizontal, 4)
    }
}

// MARK: - Press interaction

/// Springy scale-down while a finger is on the control — the shared touch
/// response for every glass surface, in place of the default opacity flash.
struct ArcPressButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.965 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == ArcPressButtonStyle {
    static var arcPress: ArcPressButtonStyle { ArcPressButtonStyle() }
}

// MARK: - Progress ring

/// Round-capped ring in the brand gradient over a faint track. Drive
/// `progress` with an animation for the draw-in effect.
struct ArcProgressRing: View {
    var progress: Double
    var lineWidth: CGFloat = 7

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.primary.opacity(0.08), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: max(0, min(1, progress)))
                .stroke(
                    AngularGradient(
                        colors: [BrandTheme.midBlue, BrandTheme.brightBlue],
                        center: .center,
                        startAngle: .degrees(0),
                        endAngle: .degrees(360)
                    ),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
        }
    }
}

// MARK: - Entrance choreography

/// Staggered rise-and-fade entrance for page sections. Each section owns its
/// reveal state so pushes/pops don't replay it; Reduce Motion snaps instantly.
private struct ArcRevealModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false
    let delay: Double

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 14)
            .onAppear {
                guard !shown else { return }
                if reduceMotion {
                    shown = true
                } else {
                    withAnimation(.spring(response: 0.55, dampingFraction: 0.85).delay(delay)) {
                        shown = true
                    }
                }
            }
    }
}

extension View {
    /// Applies the shared entrance stagger; pass increasing delays down the page.
    func arcReveal(delay: Double = 0) -> some View {
        modifier(ArcRevealModifier(delay: delay))
    }

    /// Gentle scroll-driven depth: content eases in scale/opacity at the
    /// viewport edges. A no-op under Reduce Motion via the transition config.
    func arcScrollDepth() -> some View {
        scrollTransition(.interactive) { content, phase in
            content
                .opacity(phase.isIdentity ? 1 : 0.75)
                .scaleEffect(phase.isIdentity ? 1 : 0.97)
        }
    }
}
