import Foundation
import Observation

@MainActor
@Observable
final class AppDependencies {
    let apiClient: APIClient
    let keychain: KeychainStore
    let mobileAPI: MobileAPIService
    let networkMonitor: NetworkMonitor
    let session: SessionStore
    let offlineStore: OfflineStore
    let syncEngine: SyncEngine
    let dailyLogs: DailyLogStore
    let drawings: DrawingsStore
    let schedule: ScheduleStore
    let field: FieldStore
    let expenses: ExpenseStore
    let documents: DocumentsStore
    let notifications: NotificationsStore
    let platform: PlatformStore
    let projectInfo: ProjectInfoStore
    let workspace: WorkspaceStore
    let push: PushManager

    init(
        apiClient: APIClient = APIClient(),
        keychain: KeychainStore = KeychainStore(),
        networkMonitor: NetworkMonitor? = nil,
        session: SessionStore? = nil,
        offlineStore: OfflineStore? = nil,
        syncEngine: SyncEngine? = nil
    ) {
        let resolvedSession = session ?? SessionStore(keychain: keychain)
        let resolvedOfflineStore = offlineStore ?? (try! OfflineStore())
        let mobileAPI = MobileAPIService(client: apiClient, session: resolvedSession)
        self.apiClient = apiClient
        self.keychain = keychain
        self.mobileAPI = mobileAPI
        self.networkMonitor = networkMonitor ?? NetworkMonitor()
        self.session = resolvedSession
        self.offlineStore = resolvedOfflineStore
        let resolvedSyncEngine = syncEngine ?? SyncEngine(
            store: resolvedOfflineStore,
            client: apiClient,
            session: resolvedSession
        )
        self.syncEngine = resolvedSyncEngine
        self.dailyLogs = DailyLogStore(
            api: mobileAPI,
            offlineStore: resolvedOfflineStore,
            syncEngine: resolvedSyncEngine,
            networkMonitor: self.networkMonitor
        )
        self.drawings = DrawingsStore(api: mobileAPI)
        self.schedule = ScheduleStore(api: mobileAPI)
        self.field = FieldStore(
            api: mobileAPI,
            offlineStore: resolvedOfflineStore,
            syncEngine: resolvedSyncEngine,
            networkMonitor: self.networkMonitor
        )
        self.expenses = ExpenseStore(api: mobileAPI)
        self.documents = DocumentsStore(api: mobileAPI)
        self.notifications = NotificationsStore(api: mobileAPI)
        self.platform = PlatformStore(api: mobileAPI)
        self.projectInfo = ProjectInfoStore(api: mobileAPI)
        let resolvedWorkspace = WorkspaceStore(api: mobileAPI, offlineStore: resolvedOfflineStore)
        self.workspace = resolvedWorkspace
        self.push = PushManager(api: mobileAPI, workspace: resolvedWorkspace)
    }
}
