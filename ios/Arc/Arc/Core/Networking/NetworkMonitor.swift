@preconcurrency import Network
import Observation

@MainActor
@Observable
final class NetworkMonitor {
    enum Status: Equatable, Sendable {
        case unknown
        case online(isExpensive: Bool, isConstrained: Bool)
        case offline
    }

    private let monitor: NWPathMonitor
    private let queue = DispatchQueue(label: "com.arc.mobile.network-monitor")
    private(set) var status: Status = .unknown

    init(monitor: NWPathMonitor = NWPathMonitor()) {
        self.monitor = monitor
    }

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if path.status == .satisfied {
                    status = .online(
                        isExpensive: path.isExpensive,
                        isConstrained: path.isConstrained
                    )
                } else {
                    status = .offline
                }
            }
        }
        monitor.start(queue: queue)
    }

    func stop() {
        monitor.cancel()
    }
}
