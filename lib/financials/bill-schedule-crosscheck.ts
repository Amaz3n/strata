/**
 * Bill against schedule: does the work this invoice bills for exist on the
 * calendar yet?
 *
 * Arc holds the schedule and the bill on the same project. A drywall bill on a
 * lot where drywall is not scheduled to start for three weeks is front-loading,
 * a wrong-lot invoice, or worse. Nobody can see that by reading the invoice.
 *
 * Pure date math only — no IO.
 *
 * LINKAGE: the only modelled relationship between a schedule row and money in
 * this schema is `schedule_items.cost_code_id`. `schedule_items.trade` and
 * `.phase` are free text with no foreign key, and no fuzzy trade-name match is
 * attempted here on purpose — a wrong claim costs an approver more than a
 * missing one. Where the schedule carries no cost code, this check produces
 * nothing and says nothing.
 *
 * Doctrine: a CHECKABLE CLAIM, never a verdict and never an action. It does not
 * change a bill's status, block a payment, or create a hold.
 */

import { fnv1aHex } from "@/lib/financials/approval-signal-fingerprint"

/**
 * How far ahead of scheduled start a bill may legitimately land. Materials get
 * delivered before the crew shows up and mobilisation deposits are normal, so a
 * bill inside two weeks of the start is unremarkable.
 */
export const SCHEDULE_LEAD_TOLERANCE_DAYS = 14

/** The earliest dated schedule occurrence of one cost code on the project. */
export interface ScheduleWindowForCostCode {
  costCodeId: string
  costCodeLabel: string
  scheduleItemId: string
  scheduleItemName: string
  /** ISO yyyy-mm-dd. */
  startDate: string
}

export interface BillScheduleFinding {
  costCodeId: string
  costCodeLabel: string
  scheduleItemId: string
  scheduleItemName: string
  scheduleStartDate: string
  daysEarly: number
  claim: string
}

export interface BillScheduleAssessment {
  version: 1
  fingerprint: string
  assessedAt: string
  billDate: string
  /** Cost codes on the bill that had a dated schedule item to check against. */
  checkedCostCodeCount: number
  findings: BillScheduleFinding[]
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const MILLIS_PER_DAY = 86_400_000

/** Parse a yyyy-mm-dd date at UTC midnight, so no timezone shifts the day. */
export function parseIsoDateToUtcMillis(value: string | null | undefined): number | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const millis = Date.UTC(year, month - 1, day)
  return Number.isNaN(millis) ? null : millis
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetweenIsoDates(from: string, to: string): number | null {
  const start = parseIsoDateToUtcMillis(from)
  const end = parseIsoDateToUtcMillis(to)
  if (start === null || end === null) return null
  return Math.round((end - start) / MILLIS_PER_DAY)
}

/** "Mar 24", or "Mar 24, 2027" when the year differs from the reference date. */
export function formatScheduleDate(isoDate: string, referenceIsoDate: string): string {
  const millis = parseIsoDateToUtcMillis(isoDate)
  if (millis === null) return isoDate
  const date = new Date(millis)
  const label = `${MONTH_LABELS[date.getUTCMonth()]} ${date.getUTCDate()}`
  return isoDate.slice(0, 4) === referenceIsoDate.slice(0, 4) ? label : `${label}, ${date.getUTCFullYear()}`
}

/**
 * Collapse many schedule rows to the earliest dated start per cost code. The
 * earliest occurrence is the generous reading: if the trade was on the calendar
 * at any point before the bill, there is nothing to report.
 */
export function earliestScheduleWindowPerCostCode(
  windows: ScheduleWindowForCostCode[],
): ScheduleWindowForCostCode[] {
  const byCostCode = new Map<string, ScheduleWindowForCostCode>()
  for (const window of windows) {
    if (parseIsoDateToUtcMillis(window.startDate) === null) continue
    const existing = byCostCode.get(window.costCodeId)
    if (!existing || window.startDate < existing.startDate) byCostCode.set(window.costCodeId, window)
  }
  return Array.from(byCostCode.values())
}

/**
 * Bills that land well before their trade is scheduled to begin. Early only —
 * a bill arriving after the work is unremarkable (retainage releases and late
 * invoicing are routine), so claiming anything about it would be noise.
 */
export function crosscheckBillAgainstSchedule(input: {
  billDate: string
  windows: ScheduleWindowForCostCode[]
}): BillScheduleFinding[] {
  if (parseIsoDateToUtcMillis(input.billDate) === null) return []

  const findings: BillScheduleFinding[] = []
  for (const window of earliestScheduleWindowPerCostCode(input.windows)) {
    const daysEarly = daysBetweenIsoDates(input.billDate, window.startDate)
    if (daysEarly === null || daysEarly <= SCHEDULE_LEAD_TOLERANCE_DAYS) continue
    findings.push({
      costCodeId: window.costCodeId,
      costCodeLabel: window.costCodeLabel,
      scheduleItemId: window.scheduleItemId,
      scheduleItemName: window.scheduleItemName,
      scheduleStartDate: window.startDate,
      daysEarly,
      claim:
        `Schedule shows ${window.scheduleItemName} starting ` +
        `${formatScheduleDate(window.startDate, input.billDate)} — ` +
        `this bill predates it by ${daysEarly} days.`,
    })
  }
  return findings.sort((left, right) => right.daysEarly - left.daysEarly)
}

/** Order-independent hash of the bill date and every schedule window checked. */
export function billScheduleFingerprint(input: {
  billDate: string
  windows: ScheduleWindowForCostCode[]
}): string {
  const windows = input.windows
    .map((window) => `${window.costCodeId}:${window.scheduleItemId}:${window.startDate}`)
    .sort()
  return fnv1aHex(JSON.stringify({ v: 1, d: input.billDate, w: windows }))
}

/** Read a persisted assessment out of vendor_bills.metadata, defensively. */
export function readBillScheduleAssessment(
  metadata: Record<string, unknown> | null | undefined,
): BillScheduleAssessment | null {
  const raw = metadata?.bill_schedule
  if (!raw || typeof raw !== "object") return null
  const candidate = raw as Partial<BillScheduleAssessment>
  if (candidate.version !== 1 || typeof candidate.fingerprint !== "string") return null
  if (typeof candidate.billDate !== "string" || !Array.isArray(candidate.findings)) return null
  return candidate as BillScheduleAssessment
}
