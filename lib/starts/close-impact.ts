import { calendarDaysBetween } from "@/lib/starts/even-flow-math"

const DAY_MS = 86_400_000

export interface CloseImpactInput {
  id: string
  lotLabel: string
  /** The sold home's scheduled closing; null for a spec or an unscheduled close. */
  closingDate: string | null
  /** Days from start to close for this home's community. */
  cycleDays: number
}

export interface CloseImpact {
  id: string
  lotLabel: string
  closingDate: string
  /** Start plus the community's cycle: when the house is projected to close if it starts on that day. */
  projectedClose: string
  /** Days the projected close lands after the scheduled one. Zero when it holds. */
  daysLate: number
  /** Days of slack when it holds. Zero when it is late. */
  slackDays: number
}

function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

/**
 * What starting these houses on `startDate` does to their promised closings.
 * Only sold homes with a scheduled closing have one to miss, so the rest are
 * not in the result. Worst first, so the dialog leads with the damage.
 */
export function closeImpacts(homes: CloseImpactInput[], startDate: string): CloseImpact[] {
  const impacts: CloseImpact[] = []
  for (const home of homes) {
    if (!home.closingDate) continue
    const projectedClose = addDays(startDate, home.cycleDays)
    const late = projectedClose > home.closingDate
    impacts.push({
      id: home.id, lotLabel: home.lotLabel, closingDate: home.closingDate, projectedClose,
      daysLate: late ? calendarDaysBetween(home.closingDate, projectedClose) : 0,
      slackDays: late ? 0 : calendarDaysBetween(projectedClose, home.closingDate),
    })
  }
  return impacts.sort((a, b) => b.daysLate - a.daysLate || a.slackDays - b.slackDays || a.lotLabel.localeCompare(b.lotLabel))
}

/** The homes a start date pushes past their promised closing. */
export function lateCloses(impacts: CloseImpact[]) {
  return impacts.filter((impact) => impact.daysLate > 0)
}

/** The day a house is assumed to start for a target week: the week's Monday, or today when the week has begun. */
export function startDateForWeek(weekStart: string, today: string) {
  return weekStart > today ? weekStart : today
}
