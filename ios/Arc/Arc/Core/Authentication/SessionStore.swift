import Foundation
import Observation

@MainActor
@Observable
final class SessionStore {
    enum State: Equatable {
        case signedOut
        case restoring
        case signedIn(user: AuthUser)
    }

    private let authClient: any AuthClient
    private let keychain: KeychainStore
    private let logger = AppLogger(.authentication)
    private let sessionKey = "supabase-session"

    private(set) var state: State = .restoring
    private(set) var session: AuthSession?
    private(set) var errorMessage: String?

    init(authClient: (any AuthClient)? = nil, keychain: KeychainStore = KeychainStore()) {
        self.authClient = authClient ?? SupabaseAuthClient()
        self.keychain = keychain
    }

    var accessToken: String? { session?.accessToken }
    var user: AuthUser? { session?.user }
    var userID: String? { session?.user.id }

    func restore() async {
        state = .restoring
        errorMessage = nil
        do {
            guard let data = try await keychain.data(for: sessionKey) else {
                state = .signedOut
                return
            }
            var restored = try JSONDecoder().decode(AuthSession.self, from: data)
            if restored.needsRefresh {
                restored = try await authClient.refresh(refreshToken: restored.refreshToken)
                try await persist(restored)
            }
            session = restored
            state = .signedIn(user: restored.user)
        } catch {
            logger.error("Session restoration failed", error: error)
            try? await keychain.delete(sessionKey)
            session = nil
            state = .signedOut
        }
    }

    func signIn(email: String, password: String) async {
        errorMessage = nil
        do {
            let signedIn = try await authClient.signIn(email: email, password: password)
            try await persist(signedIn)
            session = signedIn
            state = .signedIn(user: signedIn.user)
        } catch {
            logger.error("Sign in failed", error: error)
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Unable to sign in."
            state = .signedOut
        }
    }

    func validAccessToken() async throws -> String {
        guard var current = session else { throw APIError.unauthorized }
        if current.needsRefresh {
            current = try await authClient.refresh(refreshToken: current.refreshToken)
            try await persist(current)
            session = current
            state = .signedIn(user: current.user)
        }
        return current.accessToken
    }

    func signOut() async {
        if let accessToken = session?.accessToken {
            await authClient.signOut(accessToken: accessToken)
        }
        try? await keychain.delete(sessionKey)
        session = nil
        errorMessage = nil
        state = .signedOut
    }

    private func persist(_ session: AuthSession) async throws {
        try await keychain.set(JSONEncoder().encode(session), for: sessionKey)
    }
}
