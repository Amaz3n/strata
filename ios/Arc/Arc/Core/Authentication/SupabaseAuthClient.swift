import Foundation

struct AuthUser: Codable, Equatable, Sendable {
    let id: String
    let email: String
}

struct AuthSession: Codable, Equatable, Sendable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Date
    let user: AuthUser

    var needsRefresh: Bool {
        expiresAt.timeIntervalSinceNow < 60
    }
}

protocol AuthClient: Sendable {
    func signIn(email: String, password: String) async throws -> AuthSession
    func refresh(refreshToken: String) async throws -> AuthSession
    func signOut(accessToken: String) async
}

struct SupabaseAuthClient: AuthClient, Sendable {
    enum AuthError: LocalizedError {
        case missingConfiguration
        case invalidResponse
        case rejected(message: String)

        var errorDescription: String? {
            switch self {
            case .missingConfiguration:
                "Supabase is not configured for this build."
            case .invalidResponse:
                "Arc received an invalid authentication response."
            case .rejected(let message):
                message
            }
        }
    }

    private struct TokenResponse: Decodable {
        struct User: Decodable {
            let id: String
            let email: String?
        }

        let accessToken: String
        let refreshToken: String
        let expiresIn: TimeInterval
        let user: User
    }

    private struct ErrorResponse: Decodable {
        let message: String?
        let errorDescription: String?
        let msg: String?
    }

    private let environment: AppEnvironment
    private let session: URLSession

    init(environment: AppEnvironment = .current, session: URLSession = .shared) {
        self.environment = environment
        self.session = session
    }

    func signIn(email: String, password: String) async throws -> AuthSession {
        try await tokenRequest(
            grantType: "password",
            payload: ["email": email, "password": password]
        )
    }

    func refresh(refreshToken: String) async throws -> AuthSession {
        try await tokenRequest(
            grantType: "refresh_token",
            payload: ["refresh_token": refreshToken]
        )
    }

    func signOut(accessToken: String) async {
        guard let configuration = configuration else { return }
        var request = URLRequest(url: configuration.url.appending(path: "auth/v1/logout"))
        request.httpMethod = "POST"
        request.setValue(configuration.key, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: request)
    }

    private var configuration: (url: URL, key: String)? {
        guard let url = environment.supabaseURL,
              let key = environment.supabasePublishableKey else { return nil }
        return (url, key)
    }

    private func tokenRequest(grantType: String, payload: [String: String]) async throws -> AuthSession {
        guard let configuration else { throw AuthError.missingConfiguration }
        var components = URLComponents(
            url: configuration.url.appending(path: "auth/v1/token"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "grant_type", value: grantType)]
        guard let url = components?.url else { throw AuthError.invalidResponse }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(configuration.key, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(payload)

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else { throw AuthError.invalidResponse }
        guard 200 ..< 300 ~= httpResponse.statusCode else {
            let error = try? JSONDecoder.arc.decode(ErrorResponse.self, from: data)
            throw AuthError.rejected(
                message: error?.message ?? error?.errorDescription ?? error?.msg ?? "Email or password is incorrect."
            )
        }

        let token = try JSONDecoder.arc.decode(TokenResponse.self, from: data)
        return AuthSession(
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expiresAt: Date().addingTimeInterval(token.expiresIn),
            user: AuthUser(id: token.user.id, email: token.user.email ?? emailFromPayload(payload))
        )
    }

    private func emailFromPayload(_ payload: [String: String]) -> String {
        payload["email"] ?? ""
    }
}
