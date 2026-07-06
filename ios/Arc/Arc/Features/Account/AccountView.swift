import SwiftUI

struct AccountView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss
    @State private var showPlatform = false

    private var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "Version \(version) (\(build))"
    }

    private var displayName: String {
        dependencies.session.user?.email ?? "Arc user"
    }

    private var initials: String {
        let source = dependencies.session.user?.email ?? "A"
        return String(source.prefix(1)).uppercased()
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        ZStack {
                            Circle().fill(BrandTheme.logoGradient).frame(width: 56, height: 56)
                            Text(initials).font(.title2.weight(.bold)).foregroundStyle(.white)
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            Text(displayName).font(.headline)
                            Text("Signed in").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }

                if !dependencies.workspace.organizations.isEmpty {
                    Section("Organization") {
                        Picker(
                            "Organization",
                            selection: Binding(
                                get: { dependencies.workspace.selectedOrganizationID ?? "" },
                                set: { organizationID in
                                    Task { await dependencies.workspace.selectOrganization(organizationID) }
                                }
                            )
                        ) {
                            ForEach(dependencies.workspace.organizations) { organization in
                                Text(organization.name).tag(organization.id)
                            }
                        }
                    }
                }

                if dependencies.workspace.hasPlatformAccess {
                    Section {
                        Button {
                            showPlatform = true
                        } label: {
                            Label("Platform Tools", systemImage: "shield.lefthalf.filled")
                        }
                    }
                }

                Section {
                    Button("Sign Out", role: .destructive) {
                        Task {
                            await dependencies.push.unregister()
                            dependencies.workspace.reset()
                            await dependencies.session.signOut()
                            dismiss()
                        }
                    }
                } footer: {
                    HStack {
                        Spacer()
                        Text("Arc · \(appVersion)").font(.footnote).foregroundStyle(.secondary)
                        Spacer()
                    }
                    .padding(.top, 8)
                }
            }
            .navigationTitle("Account")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
            .sheet(isPresented: $showPlatform) {
                PlatformView()
            }
        }
    }
}
