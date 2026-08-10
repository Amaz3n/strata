/**
 * Keep post-auth navigation on this application. Besides blocking obvious
 * absolute URLs, parsing catches browser-normalized forms such as `/\\host`.
 */
export function normalizeInternalReturnPath(value: unknown, fallback = "/") {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return fallback
  }

  try {
    const base = new URL("https://arc.local")
    const parsed = new URL(value, base)
    if (parsed.origin !== base.origin) return fallback
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return fallback
  }
}
