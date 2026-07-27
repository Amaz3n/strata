/**
 * Deal dates arrive two ways and must not be parsed the same.
 *
 * A date-only column ("2026-03-14" — a closing date) is a calendar day and is
 * pinned to local midnight, or a UTC parse would print the day before for
 * anyone west of Greenwich. A timestamp (a follow-up, a hold expiry) is a real
 * instant and goes through the normal parse so it lands on the day the
 * consultant actually sees it. The anchored test is what keeps the two apart.
 */
function parseDealDate(value: string | null): Date | null {
  if (!value) return null
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDealDate(value: string | null): string {
  const date = parseDealDate(value)
  if (!date) return value ?? "—"
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}
