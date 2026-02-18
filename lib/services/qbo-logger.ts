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
    event,
    timestamp: new Date().toISOString(),
    ...sanitizeContext(context),
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
