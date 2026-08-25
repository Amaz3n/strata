/**
 * Normalize a user-entered folder path to a canonical `/a/b` form.
 * Returns null for anything that resolves to the root.
 */
export function normalizeFolderPath(path: string): string | null {
  const trimmed = path.trim()
  if (!trimmed) return null
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  const normalized = withLeadingSlash.replace(/\/+/g, "/")
  if (normalized === "/") return null
  return normalized.replace(/\/$/, "")
}
