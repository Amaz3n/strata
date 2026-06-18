import * as Sentry from "@sentry/nextjs"

import { sanitizeLogContext } from "@/lib/logging/logger"

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? (process.env.NODE_ENV === "production" ? 0.1 : 1)),
  sendDefaultPii: false,
  beforeSend(event) {
    if (event.extra) {
      event.extra = sanitizeLogContext(event.extra)
    }
    if (event.contexts) {
      event.contexts = sanitizeLogContext(event.contexts) as typeof event.contexts
    }
    return event
  },
})
