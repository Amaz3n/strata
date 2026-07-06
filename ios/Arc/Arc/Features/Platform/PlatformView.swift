import SwiftUI

struct PlatformView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss
    @State private var selectedTab: PlatformTab = .audit
    @State private var isShowingNewIssue = false

    private enum PlatformTab: String, CaseIterable, Identifiable {
        case audit = "Audit"
        case issues = "Issues"

        var id: Self { self }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Platform", selection: $selectedTab) {
                    ForEach(PlatformTab.allCases) { tab in
                        Text(tab.rawValue).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .padding()

                switch selectedTab {
                case .audit:
                    PlatformAuditList(store: dependencies.platform)
                case .issues:
                    PlatformIssueList(store: dependencies.platform)
                }
            }
            .navigationTitle("Platform")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                if selectedTab == .issues {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            isShowingNewIssue = true
                        } label: {
                            Label("New Issue", systemImage: "plus")
                        }
                    }
                }
            }
            .sheet(isPresented: $isShowingNewIssue) {
                NewPlatformIssueView(store: dependencies.platform)
            }
        }
    }
}

private struct PlatformAuditList: View {
    let store: PlatformStore

    var body: some View {
        Group {
            if store.isLoadingAudit && store.auditEntries.isEmpty {
                ProgressView()
            } else if let message = store.auditErrorMessage, store.auditEntries.isEmpty {
                ContentUnavailableView {
                    Label("Audit unavailable", systemImage: "lock.shield")
                } description: { Text(message) }
            } else if store.auditEntries.isEmpty {
                ContentUnavailableView("No audit events", systemImage: "doc.text.magnifyingglass")
            } else {
                List(store.auditEntries) { entry in
                    AuditEntryRow(entry: entry)
                }
                .listStyle(.plain)
            }
        }
        .refreshable { await store.refreshAudit() }
        .task { await store.loadAudit() }
    }
}

private struct PlatformIssueList: View {
    let store: PlatformStore

    var body: some View {
        Group {
            if store.isLoadingIssues && store.issues.isEmpty {
                ProgressView()
            } else if let message = store.issuesErrorMessage, store.issues.isEmpty {
                ContentUnavailableView {
                    Label("Issues unavailable", systemImage: "exclamationmark.bubble")
                } description: { Text(message) }
            } else if store.issues.isEmpty {
                ContentUnavailableView("No open issues", systemImage: "checkmark.seal")
            } else {
                List(store.issues) { issue in
                    IssueRow(issue: issue)
                }
                .listStyle(.plain)
            }
        }
        .refreshable { await store.refreshIssues() }
        .task { await store.loadIssues() }
    }
}

private struct AuditEntryRow: View {
    let entry: MobilePlatformAuditEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(entry.actionKey)
                    .font(.headline)
                    .lineLimit(2)
                Spacer()
                StatusPill(text: entry.decision.capitalized, color: entry.decision == "allow" ? .green : .red)
            }
            Text([entry.orgName, entry.projectName, entry.actorName].compactMap { $0 }.joined(separator: " · "))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack {
                Text(entry.occurredAt.formatted(date: .abbreviated, time: .shortened))
                if let reasonCode = entry.reasonCode {
                    Text(reasonCode)
                }
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
    }
}

private struct IssueRow: View {
    let issue: MobilePlatformIssue

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(issue.issueKey)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                StatusPill(text: issue.priority.capitalized, color: priorityColor)
                Spacer()
                Text(issue.status.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(issue.title)
                .font(.headline)
                .lineLimit(2)
            if let description = issue.description, !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
            HStack {
                if let orgName = issue.orgName {
                    Text(orgName)
                }
                Text(issue.updatedAt.formatted(date: .abbreviated, time: .shortened))
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
    }

    private var priorityColor: Color {
        switch issue.priority {
        case "urgent": .red
        case "high": .orange
        case "low": .secondary
        default: .blue
        }
    }
}

private struct NewPlatformIssueView: View {
    @Environment(\.dismiss) private var dismiss
    let store: PlatformStore

    @State private var title = ""
    @State private var description = ""
    @State private var priority = "medium"
    @State private var environment = AppEnvironment.current.rawValue
    @State private var errorMessage: String?
    @State private var isSubmitting = false

    private let priorities = ["urgent", "high", "medium", "low"]

    var body: some View {
        NavigationStack {
            Form {
                Section("Issue") {
                    TextField("Title", text: $title)
                    TextField("Description", text: $description, axis: .vertical)
                        .lineLimit(4...8)
                    Picker("Priority", selection: $priority) {
                        ForEach(priorities, id: \.self) { value in
                            Text(value.capitalized).tag(value)
                        }
                    }
                    TextField("Environment", text: $environment)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("New Issue")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSubmitting ? "Submitting" : "Submit") {
                        submit()
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).count < 3 || isSubmitting)
                }
            }
        }
    }

    private func submit() {
        isSubmitting = true
        errorMessage = nil
        Task {
            do {
                try await store.createIssue(
                    CreatePlatformIssueRequest(
                        title: title,
                        description: description.isEmpty ? nil : description,
                        priority: priority,
                        environment: environment.isEmpty ? nil : environment
                    )
                )
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSubmitting = false
        }
    }
}

private struct StatusPill: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.14), in: Capsule())
            .foregroundStyle(color)
    }
}
