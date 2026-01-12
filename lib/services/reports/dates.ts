export function parseDateOnly(date: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  return { year, month, day }
}

export function dateOnlyToUtcMs(date: string): number | null {
  const parsed = parseDateOnly(date)
  if (!parsed) return null
  const ms = Date.UTC(parsed.year, parsed.month - 1, parsed.day)
  return Number.isFinite(ms) ? ms : null
}

export function isoDateOnlyFromUtcMs(ms: number): string {
  const d = new Date(ms)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function todayIsoDateOnly(): string {
  return isoDateOnlyFromUtcMs(Date.now())
}

export function daysBetweenDateOnly(fromDate: string, toDate: string): number | null {
  const fromMs = dateOnlyToUtcMs(fromDate)
  const toMs = dateOnlyToUtcMs(toDate)
  if (fromMs == null || toMs == null) return null
  const diffMs = toMs - fromMs
  return Math.floor(diffMs / (1000 * 60 * 60 * 24))
}

