import Foundation

struct MobileDrawingSet: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let projectId: String
    let title: String
    let description: String?
    let status: String
    let totalPages: Int?
    let processedPages: Int
    let sheetCount: Int
    let updatedAt: Date

    var isProcessing: Bool { status == "processing" }
}

struct MobileDrawingSheet: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let drawingSetId: String
    let setTitle: String?
    let sheetNumber: String
    let sheetTitle: String?
    let discipline: String?
    let disciplineLabel: String?
    let currentRevisionLabel: String?
    let versionCount: Int
    let thumbnailUrl: URL?
    let imageUrl: URL?
    let imageWidth: Int?
    let imageHeight: Int?
    let openPinsCount: Int
    let totalPinsCount: Int
    let updatedAt: Date

    var disciplineKey: String { discipline ?? "X" }
    var aspectRatio: CGFloat? {
        guard let width = imageWidth, let height = imageHeight, width > 0, height > 0 else { return nil }
        return CGFloat(width) / CGFloat(height)
    }
}

struct MobileDrawingSheetVersion: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let revisionLabel: String?
    let creatorName: String?
    let changeDescription: String?
    let createdAt: Date
    let thumbnailUrl: URL?
    let imageUrl: URL?
    let imageWidth: Int?
    let imageHeight: Int?
}

struct MobileDrawingPin: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let xPosition: Double
    let yPosition: Double
    let entityType: String
    let entityId: String
    let label: String?
    let status: String?
    let entityTitle: String?
    let entityStatus: String?
}

struct MobileDrawingSheetDetail: Codable, Equatable, Sendable {
    let sheet: MobileDrawingSheet
    let versions: [MobileDrawingSheetVersion]
    let pins: [MobileDrawingPin]
}

enum DrawingDisciplinePalette {
    /// Mirrors the desktop discipline taxonomy (lib/validation/drawings.ts).
    static let order: [String] = ["A", "S", "M", "E", "P", "C", "L", "I", "FP", "G", "T", "SP", "D", "X"]

    static func label(for key: String) -> String {
        switch key {
        case "A": "Architectural"
        case "S": "Structural"
        case "M": "Mechanical"
        case "E": "Electrical"
        case "P": "Plumbing"
        case "C": "Civil"
        case "L": "Landscape"
        case "I": "Interior"
        case "FP": "Fire Protection"
        case "G": "General"
        case "T": "Title/Cover"
        case "SP": "Specifications"
        case "D": "Details"
        default: "Other"
        }
    }

    static func symbol(for key: String) -> String {
        switch key {
        case "A": "building.columns"
        case "S": "square.stack.3d.up"
        case "M": "gearshape.2"
        case "E": "bolt"
        case "P": "drop"
        case "C": "globe.americas"
        case "L": "leaf"
        case "I": "sofa"
        case "FP": "flame"
        case "T": "doc.richtext"
        case "SP": "list.bullet.rectangle"
        case "D": "ruler"
        default: "map"
        }
    }
}

enum DrawingPinAppearance {
    static func color(for entityType: String) -> String { entityType }

    static func symbol(for entityType: String) -> String {
        switch entityType {
        case "task": "checkmark.circle.fill"
        case "rfi": "questionmark.bubble.fill"
        case "punch_list": "wrench.and.screwdriver.fill"
        case "submittal": "tray.full.fill"
        case "observation": "eye.fill"
        case "issue": "exclamationmark.triangle.fill"
        case "daily_log": "doc.text.fill"
        default: "mappin.circle.fill"
        }
    }

    static func typeLabel(for entityType: String) -> String {
        switch entityType {
        case "task": "Task"
        case "rfi": "RFI"
        case "punch_list": "Punch Item"
        case "submittal": "Submittal"
        case "observation": "Observation"
        case "issue": "Issue"
        case "daily_log": "Daily Log"
        default: entityType.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}
