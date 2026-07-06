import SwiftUI

struct RootView: View {
    @Environment(AppDependencies.self) private var dependencies

    var body: some View {
        Group {
            switch dependencies.session.state {
            case .restoring:
                ProgressView("Restoring Arc…")
            case .signedOut:
                SignInView()
            case .signedIn:
                AppView()
            }
        }
        .task(id: dependencies.session.userID) {
            if dependencies.session.userID == nil {
                await dependencies.session.restore()
            } else {
                await dependencies.workspace.bootstrap()
                await dependencies.push.start()
            }
        }
        .task(id: dependencies.networkMonitor.status) {
            await dependencies.syncEngine.handleConnectivity(dependencies.networkMonitor.status)
            await dependencies.dailyLogs.synchronizeUploads()
        }
    }
}
