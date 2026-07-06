import Foundation
import OSLog

struct AppLogger: Sendable {
    enum Category: String, Sendable {
        case app
        case authentication
        case networking
        case persistence
        case sync
    }

    private let logger: Logger

    init(_ category: Category) {
        logger = Logger(
            subsystem: Bundle.main.bundleIdentifier ?? "com.arc.mobile",
            category: category.rawValue
        )
    }

    func debug(_ message: String) {
        logger.debug("\(message, privacy: .public)")
    }

    func info(_ message: String) {
        logger.info("\(message, privacy: .public)")
    }

    func error(_ message: String, error: Error? = nil) {
        if let error {
            logger.error("\(message, privacy: .public): \(String(describing: error), privacy: .private(mask: .hash))")
        } else {
            logger.error("\(message, privacy: .public)")
        }
    }
}
