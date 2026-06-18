import * as Sentry from "@sentry/nextjs"

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? (process.env.NODE_ENV === "production" ? 0.05 : 1)),
  replaysSessionSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE ?? 0),
  replaysOnErrorSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE ?? 1),
  sendDefaultPii: false,
  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
    }),
  ],
})

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
