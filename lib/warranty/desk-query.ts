import { warrantyLocalDate, zonedStartOfDay } from "@/lib/services/warranty/visit-time"

/** Keep PostgREST offsets finite, integral and within JavaScript's exact range. */
export function warrantyDeskPage(page?: number, pageSize?: number) {
  const size = Number.isSafeInteger(pageSize) && pageSize! > 0 ? Math.min(200, pageSize!) : 100
  const current = Number.isSafeInteger(page) && page! > 0 && Number.isSafeInteger(page! * size) ? page! : 1
  return { page: current, pageSize: size, from: (current - 1) * size, to: current * size - 1 }
}

export function warrantyDeskUrlPage(value?: string) {
  if (!value || !/^[1-9]\d*$/.test(value)) return 1
  return warrantyDeskPage(Number(value)).page
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10)
const addDays = (day: string, days: number) => isoDay(new Date(new Date(`${day}T00:00:00.000Z`).getTime() + days * 86_400_000))

function validDispatchDay(value?: string) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const candidate = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(candidate.getTime()) || isoDay(candidate) !== value) return null
  return candidate.getUTCFullYear() >= 2000 && candidate.getUTCFullYear() <= 9998 ? value : null
}

/**
 * The dispatch week, Sunday to Saturday. Calendar dates are explicit so server
 * and browser agree on the boundary. With a `timeZone` the week is that zone's
 * calendar week — midnight Sunday to midnight Sunday at the houses, DST-correct
 * (a week that crosses a clock change is 167 or 169 hours) — otherwise UTC's.
 */
export function warrantyDispatchWeek(value?: string, now = new Date(), timeZone?: string) {
  const today = timeZone ? warrantyLocalDate(now.toISOString(), timeZone) : isoDay(now)
  const anchor = validDispatchDay(value) ?? today
  const sunday = addDays(anchor, -new Date(`${anchor}T00:00:00.000Z`).getUTCDay())
  const boundary = (day: string) => timeZone ? zonedStartOfDay(day, timeZone) : `${day}T00:00:00.000Z`
  return {
    from: boundary(sunday), to: boundary(addDays(sunday, 7)), week: sunday,
    previous: addDays(sunday, -7), next: addDays(sunday, 7),
    days: Array.from({ length: 7 }, (_, day) => addDays(sunday, day)),
  }
}

export const WARRANTY_QUEUE_SLA_FILTERS = ["all", "awaiting_first_response", "first_response_breached", "breached", "due_soon", "first_response_due_soon", "sent_back"] as const
export function warrantyQueueSlaFilter(value?: string) {
  return WARRANTY_QUEUE_SLA_FILTERS.find((filter) => filter === value) ?? "all"
}

export function normalizeWarrantyDeskSearch(value?: string) {
  const term = (value ?? "").replace(/\s+/g, " ").trim()
  if (term.length > 200 || /[\u0000-\u001f\u007f]/.test(term)) throw new Error("Search must be at most 200 characters without control characters")
  return term
}

/** Literal substring regex; user punctuation never becomes regex or query syntax. */
export function warrantyDeskSearchPattern(value?: string) {
  return normalizeWarrantyDeskSearch(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function quoteWarrantySearchPattern(pattern: string) {
  return `"${pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

export function warrantyQueueFilterHref(currentQuery: string, search: string, sla: string) {
  const params = new URLSearchParams(currentQuery)
  params.set("tab", "queue")
  params.delete("page")
  const term = normalizeWarrantyDeskSearch(search), filter = warrantyQueueSlaFilter(sla)
  if (term) params.set("search", term); else params.delete("search")
  if (filter !== "all") params.set("sla", filter); else params.delete("sla")
  return `/warranty?${params}`
}

/** Next.js represents repeated URL keys as arrays; use the first explicit value. */
export function warrantyDeskUrlValue(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value
}
