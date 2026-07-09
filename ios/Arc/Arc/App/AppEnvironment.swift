import Foundation

enum AppEnvironment: String, CaseIterable, Sendable {
    case development
    case staging
    case production

    static var current: AppEnvironment {
        if let override = ProcessInfo.processInfo.environment["ARC_ENVIRONMENT"],
           let environment = AppEnvironment(rawValue: override.lowercased()) {
            return environment
        }

        #if DEBUG
        return .development
        #else
        return .production
        #endif
    }

    var apiBaseURL: URL {
        // Allow overriding the base URL (e.g. an HTTPS tunnel to localhost when
        // testing on a physical device) via the Xcode scheme env var.
        if let override = configuredEnvironmentURL("ARC_API_BASE_URL") {
            return override
        }

        switch self {
        case .development:
            return configuredPlistURL("ArcAPIBaseURL")
                ?? URL(string: "http://127.0.0.1:3000/api/mobile/v1")!
        case .staging:
            return URL(string: "https://staging.arcnaples.com/api/mobile/v1")!
        case .production:
            return configuredPlistURL("ArcAPIBaseURL")
                ?? URL(string: "https://app.arcnaples.com/api/mobile/v1")!
        }
    }

    var sentryTracesSampleRate: Double {
        switch self {
        case .development: 0
        case .staging: 1
        case .production: 0.1
        }
    }

    var sentryDSN: String? {
        let value = ProcessInfo.processInfo.environment["ARC_SENTRY_DSN"]
            ?? Bundle.main.object(forInfoDictionaryKey: "ArcSentryDSN") as? String
        guard let value, !value.isEmpty, value != "$(ARC_SENTRY_DSN)" else {
            return nil
        }
        return value
    }

    var supabaseURL: URL? {
        configuredURL(environmentKey: "ARC_SUPABASE_URL", plistKey: "ArcSupabaseURL")
    }

    var supabasePublishableKey: String? {
        configuredValue(environmentKey: "ARC_SUPABASE_PUBLISHABLE_KEY", plistKey: "ArcSupabasePublishableKey")
    }

    var isPushEnabled: Bool {
        let value = configuredValue(environmentKey: "ARC_PUSH_ENABLED", plistKey: "ArcPushEnabled")
        return value?.uppercased() == "YES" || value == "1" || value?.lowercased() == "true"
    }

    private func configuredURL(environmentKey: String, plistKey: String) -> URL? {
        guard let value = configuredValue(environmentKey: environmentKey, plistKey: plistKey) else { return nil }
        return URL(string: value)
    }

    private func configuredEnvironmentURL(_ key: String) -> URL? {
        guard let value = ProcessInfo.processInfo.environment[key],
              !value.isEmpty,
              !value.hasPrefix("$(") else { return nil }
        return URL(string: value)
    }

    private func configuredPlistURL(_ key: String) -> URL? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !value.isEmpty,
              !value.hasPrefix("$(") else { return nil }
        return URL(string: value)
    }

    private func configuredValue(environmentKey: String, plistKey: String) -> String? {
        let value = ProcessInfo.processInfo.environment[environmentKey]
            ?? Bundle.main.object(forInfoDictionaryKey: plistKey) as? String
        guard let value, !value.isEmpty, !value.hasPrefix("$(") else { return nil }
        return value
    }
}
