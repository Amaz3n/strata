const DAY_MS = 86_400_000

export function mondayOfIsoWeek(value: string | Date) {
  const date = typeof value === "string" ? new Date(`${value}T00:00:00.000Z`) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date")
  const day = date.getUTCDay()
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1))
  return date.toISOString().slice(0, 10)
}
export function addWeeks(weekStart: string, weeks: number) {
  const date = new Date(`${mondayOfIsoWeek(weekStart)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + weeks * 7)
  return date.toISOString().slice(0, 10)
}

export function releaseSlotVariance(input: {
  weekStart: string
  today: string
  target: number
  released: number
  targeted: number
}) {
  const actual = input.weekStart < mondayOfIsoWeek(input.today) ? input.released : input.targeted
  return actual - input.target
}

export function normalizeWorkGroupKey(name: string) {
  return name.trim().toLocaleLowerCase().replace(/\s+/g, " ")
}

export function percentile(values: number[], target: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(sorted.length * target) - 1)
  return sorted[index]
}

export function median(values: number[]) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle]
}

export function calendarDaysBetween(start: string, end: string) {
  return Math.max(0, Math.round((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / DAY_MS))
}

export function scheduleDigestKey(companyId: string, projectId: string) {
  return `${companyId}:${projectId}`
}
