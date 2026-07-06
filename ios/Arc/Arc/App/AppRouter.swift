import Observation
import SwiftUI

enum AppRoute: Hashable {
    case schedule
    case tasks
    case punch
    case rfis
    case team
    case expenses
    case projectDetails
    case dailyLog(id: String)
    case scanReceipt
    case drawingSheet(id: String)
}

enum SheetDestination: Identifiable, Hashable {
    case account
    case newDailyLog(camera: Bool)

    var id: String {
        switch self {
        case .account: "account"
        case .newDailyLog(let camera): camera ? "new-daily-log-camera" : "new-daily-log"
        }
    }
}

@MainActor
@Observable
final class AppRouter {
    var path: [AppRoute] = []
    var presentedSheet: SheetDestination?

    func navigate(to route: AppRoute) {
        path.append(route)
    }

    func reset() {
        path.removeAll()
        presentedSheet = nil
    }
}

@MainActor
@Observable
final class TabRouter {
    private var routers: [AppTab: AppRouter] = [:]

    func router(for tab: AppTab) -> AppRouter {
        if let router = routers[tab] {
            return router
        }

        let router = AppRouter()
        routers[tab] = router
        return router
    }

    func binding(for tab: AppTab) -> Binding<[AppRoute]> {
        let router = router(for: tab)
        return Binding(
            get: { router.path },
            set: { router.path = $0 }
        )
    }

    func resetAll() {
        routers.values.forEach { $0.reset() }
    }
}
