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
    private var refreshTask: Task<AuthSession, Error>?

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

        var restored: AuthSession
        do {
            guard let data = try await keychain.data(for: sessionKey) else {
                state = .signedOut
                return
            }
            restored = try JSONDecoder().decode(AuthSession.self, from: data)
        } catch {
            // Unreadable or corrupt storage is the only reason to discard it.
            logger.error("Stored session unreadable", error: error)
            try? await keychain.delete(sessionKey)
            session = nil
            state = .signedOut
            return
        }

        if restored.needsRefresh {
            do {
                restored = try await refreshSession(using: restored)
            } catch let error as SupabaseAuthClient.AuthError where error.isDefinitiveRejection {
                logger.error("Stored session rejected by server", error: error)
                try? await keychain.delete(sessionKey)
                session = nil
                state = .signedOut
                return
            } catch {
                // Offline or the auth service hiccuped. The stored session is still
                // the best truth we have — signing the user out here is what used to
                // strand a new orphaned session on every flaky launch.
                logger.error("Session refresh deferred", error: error)
            }
        }

        session = restored
        state = .signedIn(user: restored.user)
    }

    func signIn(email: String, password: String) async {
        errorMessage = nil
        do {
            let signedIn = try await authClient.signIn(email: email, password: password)
            session = signedIn
            state = .signedIn(user: signedIn.user)
            await persistBestEffort(signedIn)
        } catch {
            logger.error("Sign in failed", error: error)
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Unable to sign in."
            state = .signedOut
        }
    }

    func validAccessToken() async throws -> String {
        guard let current = session else { throw APIError.unauthorized }
        guard current.needsRefresh else { return current.accessToken }
        do {
            return try await refreshSession(using: current).accessToken
        } catch let error as SupabaseAuthClient.AuthError where error.isDefinitiveRejection {
            // The server retired this session; only a fresh sign-in can recover.
            logger.error("Session rejected by server", error: error)
            try? await keychain.delete(sessionKey)
            session = nil
            state = .signedOut
            throw APIError.unauthorized
        }
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

    /// Refresh tokens rotate on every use: two concurrent refreshes with the same
    /// token trip GoTrue's reuse detection and revoke the entire session family.
    /// All refreshes therefore funnel through one in-flight task.
    private func refreshSession(using current: AuthSession) async throws -> AuthSession {
        if let inFlight = refreshTask {
            return try await inFlight.value
        }
        let task = Task { [authClient] in
            try await authClient.refresh(refreshToken: current.refreshToken)
        }
        refreshTask = task
        defer { refreshTask = nil }
        let refreshed = try await task.value
        session = refreshed
        state = .signedIn(user: refreshed.user)
        await persistBestEffort(refreshed)
        return refreshed
    }

    /// The in-memory session is the source of truth once the server has spoken; a
    /// keychain write failure must not fail the sign-in or refresh that produced it.
    private func persistBestEffort(_ session: AuthSession) async {
        do {
            try await keychain.set(JSONEncoder().encode(session), for: sessionKey)
        } catch {
            logger.error("Failed to persist session", error: error)
        }
    }
}
