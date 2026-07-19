import { logger } from "@/lib/logging/logger"

type AccountingLogLevel = "info" | "warn" | "error"

function sanitizeContext(context: Record<string, unknown>) {
  const redacted = { ...context }
  for (const key of Object.keys(redacted)) {
    const lowered = key.toLowerCase()
    if (lowered.includes("token") || lowered.includes("secret") || lowered.includes("authorization")) {
      redacted[key] = "[redacted]"
    }
  }
  return redacted
}

export function logAccounting(level: AccountingLogLevel, event: string, context: Record<string, unknown> & { provider?: string } = {}) {
  const payload = {
    domain: "accounting",
    ...sanitizeContext(context),
  }

  if (level === "error") {
    logger.error(event, payload)
    return
  }
  if (level === "warn") {
    logger.warn(event, payload)
    return
  }
  logger.info(event, payload)
}

/** Transitional provider-specific alias used by the QBO adapter and routes. */
export function logQBO(level: AccountingLogLevel, event: string, context: Record<string, unknown> = {}) {
  return logAccounting(level, event, { provider: "qbo", ...context })
}
