export function selectionTaskKey(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "task"
}

export function normalizeScheduleTemplateItems(items: unknown[]) {
  const counts = new Map<string, number>()
  return items.map((value) => {
    const record: Record<string, unknown> = typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
    const base = typeof record.key === "string" && record.key.trim()
      ? selectionTaskKey(record.key)
      : selectionTaskKey(typeof record.name === "string" ? record.name : "task")
    const count = (counts.get(base) ?? 0) + 1
    counts.set(base, count)
    return { ...record, key: count === 1 ? base : `${base}-${count}` }
  })
}

export function addCalendarDays(dateValue: string, days: number) {
  const date = new Date(`${dateValue}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function deriveSelectionCutoff(input: {
  scheduleTaskKey: string
  cutoffAnchor: "start" | "end"
  cutoffOffsetDays: number
  items: Array<{ id: string; name: string; start_date: string | null; end_date: string | null; template_item_key?: string | null }>
}) {
  const matches = input.items
    .filter((item) => item.template_item_key === input.scheduleTaskKey || selectionTaskKey(item.name) === input.scheduleTaskKey)
    .sort((left, right) => String(left.start_date ?? "9999-12-31").localeCompare(String(right.start_date ?? "9999-12-31")))
  const matched = matches[0]
  if (!matched) return { cutoffDate: null, matchedScheduleItemId: null }
  const anchorDate = input.cutoffAnchor === "end" ? matched.end_date : matched.start_date
  if (!anchorDate) return { cutoffDate: null, matchedScheduleItemId: null }
  return { cutoffDate: addCalendarDays(anchorDate, input.cutoffOffsetDays), matchedScheduleItemId: matched.id }
}

export function shouldReopenSelectionGroup(input: { status: string; nextCutoffDate: string | null; today: string }) {
  return input.status === "locked" && Boolean(input.nextCutoffDate && input.nextCutoffDate >= input.today)
}

export function selectionReminderKey(daysRemaining: number) {
  if (daysRemaining === 14) return "t14"
  if (daysRemaining === 7) return "t7"
  return null
}
