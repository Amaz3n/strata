import SwiftUI

/// "Library" is the project's reference material — drawings and documents —
/// the two things people pull up on site. One segmented surface instead of two
/// separate tabs.
struct ProjectLibraryView: View {
    private enum Segment: String, CaseIterable, Identifiable {
        case drawings = "Drawings"
        case documents = "Documents"
        var id: Self { self }
    }

    @State private var segment: Segment = .drawings
    let project: MobileProject

    var body: some View {
        VStack(spacing: 0) {
            Picker("Library", selection: $segment.animation(.easeInOut(duration: 0.2))) {
                ForEach(Segment.allCases) { segment in
                    Text(segment.rawValue).tag(segment)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(.bar)

            Divider()

            switch segment {
            case .drawings: ProjectDrawingsView(project: project)
            case .documents: ProjectDocumentsView(project: project)
            }
        }
        .navigationTitle("Library")
        .navigationBarTitleDisplayMode(.inline)
    }
}
