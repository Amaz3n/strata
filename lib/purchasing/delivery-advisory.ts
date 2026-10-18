/**
 * Which scheduled tasks a late or short delivery puts at risk. Derived on read
 * and never written: a coordinator decides whether a task moves.
 *
 * A line is matched to a task on the cost code they share. A task is at risk
 * while it has not finished when a line that is still owed (a) is expected after
 * the day the task starts, or (b) is late or short and the task starts
 * within `ADVISORY_WINDOW_DAYS` of today (or has started).
 */

export const ADVISORY_WINDOW_DAYS = 10

export interface AdvisoryLine {
  lineId: string
  commitmentId: string
  description: string
  costCodeId: string | null
  outstanding: number
  unit: string | null
  /** The date the line is now expected: its need-by, or the back-order date. */
  expectedDate: string
  state: "expected" | "late" | "partial" | "short"
}

interface AdvisoryTask {
  id: string
  name: string
  costCodeId: string | null
  status: string
  startDate: string | null
  endDate: string | null
}

export interface DeliveryAdvisory {
  scheduleItemId: string
  scheduleItemName: string
  startDate: string
  lineId: string
  commitmentId: string
  description: string
  outstanding: number
  unit: string | null
  expectedDate: string
  daysLate: number
  state: AdvisoryLine["state"]
}

const DONE_STATUSES = new Set(["completed", "cancelled"])
const DAY_MS = 86_400_000

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS)

export function deliveryAdvisories(input: { lines: AdvisoryLine[]; tasks: AdvisoryTask[]; today: string }): DeliveryAdvisory[] {
  const today = dayNumber(input.today)
  const tasksByCode = new Map<string, AdvisoryTask[]>()
  for (const task of input.tasks) {
    if (!task.costCodeId || !task.startDate || DONE_STATUSES.has(task.status)) continue
    if (dayNumber(task.endDate ?? task.startDate) < today) continue
    tasksByCode.set(task.costCodeId, [...(tasksByCode.get(task.costCodeId) ?? []), task])
  }
  const advisories: DeliveryAdvisory[] = []
  for (const line of input.lines) {
    if (!line.costCodeId || line.outstanding <= 0) continue
    const expected = dayNumber(line.expectedDate)
    const behind = line.state === "late" || line.state === "short"
    for (const task of tasksByCode.get(line.costCodeId) ?? []) {
      const start = dayNumber(task.startDate ?? input.today)
      const arrivesAfterStart = expected > start
      const startsSoon = start <= today + ADVISORY_WINDOW_DAYS
      if (!arrivesAfterStart && !(behind && startsSoon)) continue
      advisories.push({
        scheduleItemId: task.id, scheduleItemName: task.name, startDate: task.startDate ?? input.today,
        lineId: line.lineId, commitmentId: line.commitmentId, description: line.description,
        outstanding: line.outstanding, unit: line.unit, expectedDate: line.expectedDate,
        daysLate: Math.max(today - expected, 0), state: line.state,
      })
    }
  }
  return advisories.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.description.localeCompare(b.description) || a.lineId.localeCompare(b.lineId))
}
