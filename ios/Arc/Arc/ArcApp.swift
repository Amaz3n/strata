import SwiftUI
import UIKit

final class ArcAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier == BackgroundUploadCoordinator.identifier else {
            completionHandler()
            return
        }
        BackgroundUploadCoordinator.shared.handleEvents(completionHandler: completionHandler)
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in PushTokenBroker.shared.update(token: token) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        AppLogger(.app).error("Remote notification registration failed", error: error)
    }
}

/// Keeps the interactive edge-swipe "back" gesture working on every pushed
/// screen, even ones that provide a custom navigation bar (e.g. a `.principal`
/// toolbar item). UIKit normally disables `interactivePopGestureRecognizer`
/// when the bar is customized, which made some screens feel un-iOS-like.
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        // Only allow the swipe when there's a screen to pop back to.
        viewControllers.count > 1
    }
}

@main
struct ArcApp: App {
    @UIApplicationDelegateAdaptor(ArcAppDelegate.self) private var appDelegate
    @State private var dependencies = AppDependencies()

    init() {
        Observability.bootstrap()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(dependencies)
                .task {
                    dependencies.networkMonitor.start()
                }
        }
    }
}
