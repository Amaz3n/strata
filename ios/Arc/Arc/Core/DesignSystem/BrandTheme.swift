import SwiftUI

/// Arc brand palette, derived from the marketing site's logo gradient
/// (`public/arc-logo2.svg`) and the auth "space gradient" panel.
enum BrandTheme {
    /// Deepest blue — the core of the logo's radial gradient. `rgb(0, 52, 160)`
    static let deepBlue = Color(red: 0.0, green: 0.204, blue: 0.627)
    /// Mid blue. `rgb(14, 88, 182)`
    static let midBlue = Color(red: 0.055, green: 0.345, blue: 0.714)
    /// Bright blue — the outer edge of the logo gradient. `rgb(45, 167, 231)`
    static let brightBlue = Color(red: 0.176, green: 0.655, blue: 0.906)

    /// Radial gradient matching the logo fill.
    static let logoGradient = RadialGradient(
        colors: [deepBlue, midBlue, brightBlue],
        center: .center,
        startRadius: 0,
        endRadius: 130
    )

    /// Linear gradient used on the primary call-to-action button.
    static let buttonGradient = LinearGradient(
        colors: [midBlue, deepBlue],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    /// Full-bleed gradient that sits behind the auth screen so Liquid Glass
    /// has vivid, refractable content to float over.
    static let authBackground = LinearGradient(
        colors: [
            Color(red: 0.04, green: 0.13, blue: 0.42),
            deepBlue,
            midBlue,
        ],
        startPoint: .top,
        endPoint: .bottom
    )
}

extension View {
    /// Applies native Liquid Glass (iOS 26+) clipped to `shape`, falling back to
    /// a translucent material on earlier systems so the same layout compiles
    /// against the iOS 17 deployment target.
    @ViewBuilder
    func liquidGlass(in shape: some Shape, interactive: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            self.background(.ultraThinMaterial, in: shape)
                .overlay(shape.stroke(.white.opacity(0.18), lineWidth: 1))
        }
    }

    /// Prominent Liquid Glass button style (iOS 26+) with a bordered-prominent
    /// fallback for earlier systems.
    @ViewBuilder
    func glassProminentButton() -> some View {
        if #available(iOS 26.0, *) {
            self.buttonStyle(.glassProminent)
        } else {
            self.buttonStyle(.borderedProminent)
        }
    }

    /// Groups child Liquid Glass elements so they blend and morph together
    /// (iOS 26+). A plain passthrough on earlier systems.
    @ViewBuilder
    func glassGroup(spacing: CGFloat = 20) -> some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { self }
        } else {
            self
        }
    }
}

/// Faithful reproduction of the Arc logo (the squared arch + dome) from
/// `arc-logo2.svg`, filled with the brand radial gradient.
struct ArcLogoMark: View {
    var body: some View {
        ArcLogoShape()
            .fill(BrandTheme.logoGradient)
            .aspectRatio(581.0 / 521.0, contentMode: .fit)
    }
}

/// The two filled subpaths of the Arc logo, transcribed from the SVG and
/// normalized into a 0–581 × 0–521 design space, then scaled to the layout rect.
private struct ArcLogoShape: Shape {
    func path(in rect: CGRect) -> Path {
        let designWidth: CGFloat = 578.5
        let designHeight: CGFloat = 518.3
        let scale = min(rect.width / designWidth, rect.height / designHeight)
        let offsetX = (rect.width - designWidth * scale) / 2
        let offsetY = (rect.height - designHeight * scale) / 2

        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: (x - 1.042) * scale + offsetX, y: (y - 1.042) * scale + offsetY)
        }

        var path = Path()

        // Upper arch (the squared frame opening into a dome).
        path.move(to: p(1.042, 295.602))
        path.addLine(to: p(1.042, 1.042))
        path.addLine(to: p(579.554, 1.042))
        path.addLine(to: p(579.554, 295.602))
        path.addCurve(to: p(290.298, 127.876), control1: p(522.051, 195.417), control2: p(414.000, 127.876))
        path.addCurve(to: p(1.042, 295.602), control1: p(166.596, 127.876), control2: p(58.545, 195.417))
        path.closeSubpath()

        // Lower dome.
        path.move(to: p(62.660, 519.324))
        path.addCurve(to: p(49.048, 439.387), control1: p(53.844, 494.308), control2: p(49.048, 467.403))
        path.addCurve(to: p(289.782, 198.653), control1: p(49.048, 306.522), control2: p(156.917, 198.653))
        path.addCurve(to: p(530.516, 439.387), control1: p(422.646, 198.653), control2: p(530.516, 306.522))
        path.addCurve(to: p(516.904, 519.324), control1: p(530.516, 467.403), control2: p(525.719, 494.308))
        path.addLine(to: p(62.660, 519.324))
        path.closeSubpath()

        return path
    }
}
