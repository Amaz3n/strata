import SwiftUI

/// Destinations of the global workspace — the context that exists *before* any
/// project is chosen, and the only place a cross-house surface can live.
///
/// My Houses comes first because a production superintendent's day is a
/// cross-house day: the question is "what is due across my twelve lots", not
/// "what is due on lot 24". Projects stays the directory everyone else opens.
enum GlobalTab: String, CaseIterable, Hashable, Identifiable {
    case myHouses
    case projects

    var id: Self { self }

    var title: String {
        switch self {
        case .myHouses: "My Houses"
        case .projects: "Projects"
        }
    }

    var systemImage: String {
        switch self {
        case .myHouses: "house"
        case .projects: "building.2"
        }
    }
}
