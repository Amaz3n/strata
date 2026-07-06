import SwiftUI

// MARK: - Semantic status colors

enum ArcStatusColor {
    /// Maps a free-form backend status string to a consistent semantic color so
    /// schedule items, tasks, punch items, and expenses read the same way.
    static func color(for status: String) -> Color {
        switch status.lowercased() {
        case "done", "completed", "closed", "approved", "paid", "resolved":
            return .green
        case "in_progress", "active", "ready_for_review", "submitted":
            return BrandTheme.brightBlue
        case "blocked", "at_risk", "rejected", "overdue", "failed":
            return .red
        case "todo", "planned", "open", "pending", "draft":
            return .orange
        default:
            return .secondary
        }
    }

    static func severity(_ value: String) -> Color {
        switch value.lowercased() {
        case "critical", "high", "major": return .red
        case "medium", "moderate": return .orange
        case "low", "minor": return .yellow
        default: return .secondary
        }
    }
}

// MARK: - Status badge

struct StatusBadge: View {
    let text: String
    var tint: Color = .secondary

    init(text: String, tint: Color = .secondary) {
        self.text = text
        self.tint = tint
    }

    /// Convenience initializer that derives the tint from a backend status value.
    init(status: String) {
        self.text = status.replacingOccurrences(of: "_", with: " ").capitalized
        self.tint = ArcStatusColor.color(for: status)
    }

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.16), in: Capsule())
            .foregroundStyle(tint == .secondary ? Color.secondary : tint)
    }
}

// MARK: - Project avatar

/// A colored, rounded square keyed to the project id — a faithful port of the
/// web `ProjectAvatar` (`components/ui/project-avatar.tsx`) so the same project
/// reads with the same color on web and native. The gradient index is derived
/// from the identical 32-bit string hash.
struct ProjectAvatar: View {
    let projectId: String
    var size: CGFloat = 28
    var cornerRadius: CGFloat = 8

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(
                LinearGradient(
                    colors: ProjectPalette.gradient(for: projectId),
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .frame(width: size, height: size)
    }
}

enum ProjectPalette {
    private static func rgb(_ hex: UInt) -> Color {
        Color(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }

    /// Curated Tailwind 500/600 pairs, in the same order as the web component.
    private static let gradients: [[Color]] = [
        [rgb(0x8B5CF6), rgb(0x9333EA)], // violet → purple
        [rgb(0x3B82F6), rgb(0x06B6D4)], // blue → cyan
        [rgb(0x10B981), rgb(0x0D9488)], // emerald → teal
        [rgb(0xF97316), rgb(0xF59E0B)], // orange → amber
        [rgb(0xEC4899), rgb(0xF43F5E)], // pink → rose
        [rgb(0x6366F1), rgb(0x2563EB)], // indigo → blue
        [rgb(0x14B8A6), rgb(0x22C55E)], // teal → green
        [rgb(0xEF4444), rgb(0xF97316)], // red → orange
        [rgb(0xD946EF), rgb(0xEC4899)], // fuchsia → pink
        [rgb(0x06B6D4), rgb(0x3B82F6)], // cyan → blue
        [rgb(0xF59E0B), rgb(0xEAB308)], // amber → yellow
        [rgb(0x84CC16), rgb(0x10B981)], // lime → emerald
        [rgb(0xF43F5E), rgb(0xEF4444)], // rose → red
        [rgb(0x0EA5E9), rgb(0x6366F1)], // sky → indigo
        [rgb(0xA855F7), rgb(0x7C3AED)], // purple → violet
        [rgb(0x22C55E), rgb(0x84CC16)], // green → lime
    ]

    /// Matches the web `hashString`: 32-bit rolling hash over UTF-16 units.
    static func gradient(for projectId: String) -> [Color] {
        var hash: Int32 = 0
        for unit in projectId.utf16 {
            hash = (hash &<< 5) &- hash &+ Int32(unit)
        }
        let index = abs(Int(hash)) % gradients.count
        return gradients[index]
    }
}

// MARK: - Card container

struct ArcCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color(.secondarySystemGroupedBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Color.primary.opacity(0.05), lineWidth: 1)
            )
    }
}

// MARK: - Section header

struct ArcSectionHeader: View {
    let title: String
    var systemImage: String?
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            if let systemImage {
                Label(title, systemImage: systemImage)
                    .font(.headline)
            } else {
                Text(title).font(.headline)
            }
            Spacer()
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.subheadline)
            }
        }
    }
}

// MARK: - Metric tile

struct MetricTile: View {
    let value: String
    let label: String
    let systemImage: String
    var tint: Color = BrandTheme.brightBlue
    var action: (() -> Void)?

    var body: some View {
        Button(action: { action?() }) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Image(systemName: systemImage)
                        .font(.title3)
                        .foregroundStyle(tint)
                    Spacer()
                    if action != nil {
                        Image(systemName: "chevron.right")
                            .font(.caption2.bold())
                            .foregroundStyle(.tertiary)
                    }
                }
                Text(value)
                    .font(.title2.bold())
                    .contentTransition(.numericText())
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color(.secondarySystemGroupedBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(tint.opacity(0.12), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
    }
}

// MARK: - Quick action tile

struct QuickActionTile: View {
    let title: String
    let systemImage: String
    var tint: Color = BrandTheme.midBlue
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 14) {
                Image(systemName: systemImage)
                    .font(.title2)
                    .foregroundStyle(tint)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(tint.opacity(0.10))
            )
        }
        .buttonStyle(.plain)
    }
}
