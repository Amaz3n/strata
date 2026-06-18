import * as Sentry from "@sentry/nextjs"

type LogLevel = "debug" | "info" | "warn" | "error"

export type LogContext = Record<string, unknown>

const REDACTED = "[redacted]"
const SENSITIVE_KEY_PARTS = [
  "authorization",
  "cookie",
  "password",
  "secret",
  "session",
  "token",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
]

function shouldRedactKey(key: string) {
  const normalized = key.toLowerCase().replace(/[-\s]/g, "_")
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))
}

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  return {
    name: "NonError",
    message: typeof error === "string" ? error : "Unknown error",
    value: error,
  }
}

function sanitizeValue(value: unknown, key = "", depth = 0): unknown {
  if (shouldRedactKey(key)) {
    return REDACTED
  }

  if (value instanceof Error) {
    return normalizeError(value)
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (Array.isArray(value)) {
    if (depth > 5) return "[max_depth]"
    return value.slice(0, 50).map((item) => sanitizeValue(item, key, depth + 1))
  }

  if (value && typeof value === "object") {
    if (depth > 5) return "[max_depth]"

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeValue(entryValue, entryKey, depth + 1),
      ]),
    )
  }

  return value
}

export function sanitizeLogContext(context: LogContext = {}) {
  return sanitizeValue(context) as LogContext
}

function toError(error: unknown) {
  if (error instanceof Error) return error
  if (typeof error === "string") return new Error(error)
  return new Error("Unknown error")
}

function getTags(context: LogContext) {
  const tags: Record<string, string> = {}

  for (const key of ["domain", "event", "orgId", "userId", "projectId", "jobId", "integration", "route"]) {
    const value = context[key]
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      tags[key] = String(value).slice(0, 200)
    }
  }

  return tags
}

function write(level: LogLevel, event: string, context: LogContext = {}) {
  const sanitizedContext = sanitizeLogContext(context)
  const payload = {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...sanitizedContext,
  }

  const line = JSON.stringify(payload)

  if (level === "error") {
    console.error(line)
    return
  }

  if (level === "warn") {
    console.warn(line)
    return
  }

  console.log(line)
}

export const logger = {
  debug(event: string, context?: LogContext) {
    if (process.env.NODE_ENV !== "production") {
      write("debug", event, context)
    }
  },

  info(event: string, context?: LogContext) {
    write("info", event, context)
  },

  warn(event: string, context?: LogContext) {
    write("warn", event, context)
  },

  error(event: string, context: LogContext & { error?: unknown } = {}) {
    write("error", event, context)

    if (context.error) {
      const sanitizedContext = sanitizeLogContext(context)
      Sentry.withScope((scope) => {
        scope.setTags(getTags({ ...sanitizedContext, event }))
        scope.setContext("log", sanitizedContext)
        Sentry.captureException(toError(context.error))
      })
    } else {
      Sentry.captureMessage(event, {
        level: "error",
        tags: getTags({ ...context, event }),
        extra: sanitizeLogContext(context),
      })
    }
  },
}
