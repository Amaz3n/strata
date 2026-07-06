#if canImport(Sentry)
import Sentry
#endif

enum Observability {
    static func bootstrap(environment: AppEnvironment = .current) {
        guard let dsn = environment.sentryDSN else {
            AppLogger(.app).info("Sentry is disabled because ARC_SENTRY_DSN is not configured")
            return
        }

        #if canImport(Sentry)
        SentrySDK.start { options in
            options.dsn = dsn
            options.environment = environment.rawValue
            options.tracesSampleRate = NSNumber(value: environment.sentryTracesSampleRate)
            options.sendDefaultPii = false
            options.enableAutoSessionTracking = true
        }
        #else
        AppLogger(.app).error("Sentry DSN is configured, but the Sentry SDK is not linked")
        #endif
    }

    static func capture(_ error: Error) {
        #if canImport(Sentry)
        SentrySDK.capture(error: error)
        #else
        AppLogger(.app).error("Captured application error", error: error)
        #endif
    }
}
