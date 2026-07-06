import Foundation

struct APIClient: Sendable {
    let baseURL: URL
    private let session: URLSession

    init(
        baseURL: URL = AppEnvironment.current.apiBaseURL,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.session = session
    }

    func request(
        path: String,
        method: String = "GET",
        accessToken: String,
        organizationID: String? = nil,
        queryItems: [URLQueryItem] = []
    ) throws -> URLRequest {
        var components = URLComponents(
            url: baseURL.appending(path: path),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components?.url else { throw APIError.invalidRequest }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        if let organizationID {
            request.setValue(organizationID, forHTTPHeaderField: "X-Arc-Organization-ID")
        }
        return request
    }

    func send<Response: Decodable & Sendable>(
        _ request: URLRequest,
        as responseType: Response.Type = Response.self
    ) async throws -> Response {
        var request = request
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(UUID().uuidString, forHTTPHeaderField: "X-Request-ID")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(description: String(describing: error))
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        guard 200 ..< 300 ~= httpResponse.statusCode else {
            throw makeAPIError(from: data, response: httpResponse)
        }

        do {
            return try JSONDecoder.arc.decode(responseType, from: data)
        } catch {
            throw APIError.decoding(description: String(describing: error))
        }
    }

    func send(_ request: URLRequest) async throws {
        var request = request
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(UUID().uuidString, forHTTPHeaderField: "X-Request-ID")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(description: String(describing: error))
        }
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard 200 ..< 300 ~= httpResponse.statusCode else {
            throw makeAPIError(from: data, response: httpResponse)
        }
    }

    private func makeAPIError(from data: Data, response: HTTPURLResponse) -> APIError {
        let envelope = try? JSONDecoder.arc.decode(APIErrorEnvelope.self, from: data)
        let code = envelope?.error.code
        let message = envelope?.error.message
        let requestID = envelope?.requestId ?? response.value(forHTTPHeaderField: "X-Request-ID")

        switch response.statusCode {
        case 401: return .unauthorized
        case 403: return .forbidden
        case 404: return .notFound
        case 409: return .conflict(code: code ?? "conflict", message: message ?? "The resource changed.")
        case 422:
            return .validation(
                code: code ?? "validation_failed",
                message: message ?? "Some information is invalid.",
                details: envelope?.error.details ?? [:]
            )
        case 429: return .rateLimited
        default:
            return .server(
                statusCode: response.statusCode,
                code: code,
                message: message,
                requestID: requestID
            )
        }
    }
}

extension JSONDecoder {
    static var arc: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .arcISO8601
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }
}

extension JSONEncoder {
    static var arc: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return encoder
    }
}

extension JSONDecoder.DateDecodingStrategy {
    /// Postgres `timestamptz` values arrive with fractional seconds (e.g.
    /// `2024-06-01T12:34:56.789123+00:00`), which Foundation's built-in
    /// `.iso8601` strategy rejects. This parses both fractional and
    /// non-fractional ISO8601 timestamps so a single bad field doesn't fail
    /// the whole response.
    static let arcISO8601 = JSONDecoder.DateDecodingStrategy.custom { decoder in
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        if let date = ISO8601DateParser.date(from: value) {
            return date
        }
        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "Unsupported date format: \(value)"
        )
    }
}

private enum ISO8601DateParser {
    private static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let withoutFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func date(from value: String) -> Date? {
        withFractionalSeconds.date(from: value) ?? withoutFractionalSeconds.date(from: value)
    }
}
