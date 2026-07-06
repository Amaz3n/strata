import Testing
@testable import Arc

@MainActor
struct AppRouterTests {
    @Test
    func resetClearsNavigationAndPresentation() {
        let router = AppRouter()
        router.navigate(to: .schedule)
        router.presentedSheet = .account

        router.reset()

        #expect(router.path.isEmpty)
        #expect(router.presentedSheet == nil)
    }

    @Test
    func tabsKeepIndependentNavigationPaths() {
        let tabs = TabRouter()
        tabs.router(for: .overview).navigate(to: .schedule)

        #expect(tabs.router(for: .overview).path.count == 1)
        #expect(tabs.router(for: .library).path.isEmpty)
    }
}
