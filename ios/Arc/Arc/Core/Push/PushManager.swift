import Foundation
import Observation
import UIKit
import UserNotifications

/// Bridges the UIApplicationDelegate APNs callbacks (which run outside the
/// SwiftUI dependency graph) to the app's `PushManager`. The delegate writes the
/// device token here; `PushManager` observes it and uploads it to Arc.
@MainActor
final class PushTokenBroker {
    static let shared = PushTokenBroker()

    private(set) var deviceToken: String?
    var onToken: ((String) -> Void)?

    func update(token: String) {
        deviceToken = token
        onToken?(token)
    }
}

@MainActor
@Observable
final class PushManager {
    private let api: MobileAPIService
    private let workspace: WorkspaceStore

    private(set) var registeredToken: String?

    init(api: MobileAPIService, workspace: WorkspaceStore) {
        self.api = api
        self.workspace = workspace
    }

    private var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    private var appVersion: String? {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }

    /// Requests authorization, registers for remote notifications, and uploads
    /// any token to Arc. Safe to call repeatedly (e.g. after each sign-in).
    func start() async {
        guard AppEnvironment.current.isPushEnabled else { return }

        PushTokenBroker.shared.onToken = { [weak self] token in
            guard let self else { return }
            Task { await self.upload(token: token) }
        }

        let center = UNUserNotificationCenter.current()
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            guard granted else { return }
        } catch {
            return
        }
        UIApplication.shared.registerForRemoteNotifications()

        if let token = PushTokenBroker.shared.deviceToken {
            await upload(token: token)
        }
    }

    private func upload(token: String) async {
        guard let organizationID = workspace.selectedOrganizationID, token != registeredToken else { return }
        do {
            try await api.registerDevice(
                token: token,
                platform: "ios",
                appVersion: appVersion,
                environment: environment,
                organizationID: organizationID
            )
            registeredToken = token
        } catch {
            // Registration is best-effort; it retries on the next start().
        }
    }

    /// Removes the current device token on sign-out so the user stops receiving
    /// pushes for an account they've left.
    func unregister() async {
        guard let token = registeredToken ?? PushTokenBroker.shared.deviceToken,
              let organizationID = workspace.selectedOrganizationID else { return }
        try? await api.unregisterDevice(token: token, organizationID: organizationID)
        registeredToken = nil
    }
}
