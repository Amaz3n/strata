import Foundation

struct APIErrorEnvelope: Decodable, Sendable {
    let error: APIErrorPayload
    let requestId: String?
}

struct APIErrorPayload: Decodable, Sendable {
    let code: String
    let message: String
    let details: [String: String]?
}

enum APIError: Error, Equatable, Sendable {
    case invalidRequest
    case invalidResponse
    case transport(description: String)
    case unauthorized
    case forbidden
    case notFound
    case conflict(code: String, message: String)
    case validation(code: String, message: String, details: [String: String])
    case rateLimited
    case server(statusCode: Int, code: String?, message: String?, requestID: String?)
    case decoding(description: String)

    /// A human-friendly message suitable for surfacing in the UI.
    var userMessage: String {
        switch self {
        case .invalidRequest, .invalidResponse, .decoding:
            "Something went wrong. Please try again."
        case .transport:
            "You appear to be offline. Check your connection and try again."
        case .unauthorized:
            "Your Arc session has expired. Sign in again to continue."
        case .forbidden:
            "You don't have access to this."
        case .notFound:
            "This is no longer available."
        case .conflict(_, let message):
            message
        case .validation(_, let message, _):
            message
        case .rateLimited:
            "Too many requests. Please wait a moment and try again."
        case .server(_, _, let message, _):
            message ?? "Arc couldn't complete this request."
        }
    }

    var isRetryable: Bool {
        switch self {
        case .transport, .rateLimited:
            true
        case .server(let statusCode, _, _, _):
            statusCode >= 500
        default:
            false
        }
    }
}
