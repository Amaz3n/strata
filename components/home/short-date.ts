const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/**
 * Formats a date-only ISO string ("2026-07-28") without going through Date —
 * parsing one of those yields UTC midnight, which renders a day early in every
 * western timezone. Schedule dates, cutoffs, and closings are all date-only.
 */
export function shortDate(iso: string | null) {
  if (!iso) return "—"
  const [, month, day] = iso.split("-")
  const label = MONTHS[Number(month) - 1]
  return label ? `${label} ${Number(day)}` : iso
}
