// Shared helpers for the subcontractor bid portal (/b/[token]).

/** Format cents as USD, tabular-friendly. Returns an em dash for nullish. */
export function formatCurrency(cents?: number | null): string {
  if (cents == null) return "—"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

/** Live-format a raw currency text input: strips non-numeric, adds thousands
 * separators, caps decimals at two places. */
export function formatCurrencyInput(value: string): string {
  const cleaned = value.replace(/[^\d.]/g, "")
  if (!cleaned) return ""

  const parts = cleaned.split(".")
  let whole = parts[0] ?? ""
  const decimal = parts[1]

  whole = whole.replace(/^0+/, "") || "0"
  whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")

  if (decimal !== undefined) {
    return `${whole}.${decimal.slice(0, 2)}`
  }
  return whole
}

/** Parse a currency text input into integer cents, or null when empty/invalid. */
export function parseCurrencyToCents(value: string): number | null {
  const sanitized = value.replace(/[^\d.]/g, "")
  if (!sanitized) return null
  const [whole, decimals] = sanitized.split(".")
  const dollars = Number(whole ?? "0")
  const cents = Number((decimals ?? "0").padEnd(2, "0").slice(0, 2))
  if (Number.isNaN(dollars) || Number.isNaN(cents)) return null
  return dollars * 100 + cents
}

/** Convert integer cents into a currency text input value (no symbol). */
export function centsToInput(cents?: number | null): string {
  if (cents == null) return ""
  return formatCurrencyInput((cents / 100).toFixed(2))
}

export function formatFileSize(bytes?: number | null): string {
  if (!bytes) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Tokenized badge styling per bid-package status. Color communicates state. */
export const packageStatusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-border",
  sent: "bg-primary/10 text-primary border-primary/20",
  open: "bg-success/10 text-success border-success/30",
  closed: "bg-muted text-muted-foreground border-border",
  awarded: "bg-warning/10 text-warning border-warning/30",
  cancelled: "bg-destructive/10 text-destructive border-destructive/30",
}

export const disallowedBidStatuses = ["closed", "awarded", "cancelled"]

/** Absolute deadline rendered in the package's declared timezone, with an
 * explicit short zone abbreviation so subs never misread a due time. Falls back
 * to the viewer's browser zone when the package has none. */
export function formatDeadline(dueAt?: string | null, dueTz?: string | null): string | null {
  if (!dueAt) return null
  const date = new Date(dueAt)
  if (Number.isNaN(date.getTime())) return null

  // dateStyle/timeStyle cannot be combined with timeZoneName (RangeError).
  // Explicit fields give the same medium-date + short-time shape plus zone.
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }

  try {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: dueTz ?? undefined,
    }).format(date)
  } catch {
    // Invalid IANA zone — fall back to browser zone.
    return new Intl.DateTimeFormat("en-US", options).format(date)
  }
}

export interface Countdown {
  pastDue: boolean
  label: string
}

/** Coarse "closes in 2d 4h" / "past due" countdown from now to the deadline. */
export function getCountdown(dueAt?: string | null, now: number = Date.now()): Countdown | null {
  if (!dueAt) return null
  const target = new Date(dueAt).getTime()
  if (Number.isNaN(target)) return null

  let diff = target - now
  if (diff <= 0) return { pastDue: true, label: "Past due" }

  const day = 24 * 60 * 60 * 1000
  const hour = 60 * 60 * 1000
  const minute = 60 * 1000

  const days = Math.floor(diff / day)
  diff -= days * day
  const hours = Math.floor(diff / hour)
  diff -= hours * hour
  const minutes = Math.floor(diff / minute)

  let label: string
  if (days > 0) label = `Closes in ${days}d ${hours}h`
  else if (hours > 0) label = `Closes in ${hours}h ${minutes}m`
  else label = `Closes in ${minutes}m`

  return { pastDue: false, label }
}
