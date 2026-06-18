import { logger } from "@/lib/logging/logger"

type QBOLogLevel = "info" | "warn" | "error"

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

export function logQBO(level: QBOLogLevel, event: string, context: Record<string, unknown> = {}) {
  const payload = {
    domain: "qbo",
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
