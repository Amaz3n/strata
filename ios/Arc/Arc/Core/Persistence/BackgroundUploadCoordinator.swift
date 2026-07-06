import Foundation

final class BackgroundUploadCoordinator: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    static let identifier = "com.arc.mobile.background-uploads"
    static let shared = BackgroundUploadCoordinator()

    private let lock = NSLock()
    private var eventsCompletionHandler: (() -> Void)?

    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.waitsForConnectivity = true
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    func enqueue(fileURL: URL, request: URLRequest, idempotencyKey: String) {
        var request = request
        request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        let task = session.uploadTask(with: request, fromFile: fileURL)
        task.taskDescription = idempotencyKey
        task.resume()
    }

    func handleEvents(completionHandler: @escaping () -> Void) {
        lock.withLock {
            eventsCompletionHandler = completionHandler
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let completion = lock.withLock {
            let completion = eventsCompletionHandler
            eventsCompletionHandler = nil
            return completion
        }
        DispatchQueue.main.async { completion?() }
    }
}
