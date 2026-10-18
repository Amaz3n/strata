/**
 * What a sold home still owes before it can start or close: the contingencies
 * the buyer signed and the lender and title milestones the closing coordinator
 * chases. Pure — the workbench, the Sales desk, the closing gate and the
 * reminder sweep all read their judgment from here, so thresholds move without
 * touching a query.
 */

export const MILESTONE_KINDS = [
  "financing",
  "appraisal",
  "home_sale",
  "inspection",
  "loan_application",
  "loan_approval",
  "title_commitment",
  "survey",
  "hoa_estoppel",
  "clear_to_close",
  "other",
] as const
export type MilestoneKind = (typeof MILESTONE_KINDS)[number]

export const MILESTONE_KIND_LABELS: Record<MilestoneKind, string> = {
  financing: "Financing",
  appraisal: "Appraisal",
  home_sale: "Sale of buyer's home",
  inspection: "Inspection",
  loan_application: "Loan application",
  loan_approval: "Loan approval",
  title_commitment: "Title commitment",
  survey: "Survey",
  hoa_estoppel: "HOA estoppel",
  clear_to_close: "Clear to close",
  other: "Other",
}

/** What a buyer can sign a contingency on; the lender and title kinds are tracked, never signed. */
export const CONTINGENCY_KINDS = ["financing", "appraisal", "home_sale", "inspection", "survey", "hoa_estoppel", "other"] as const
export type ContingencyKind = (typeof CONTINGENCY_KINDS)[number]

export const MILESTONE_STATUSES = ["open", "satisfied", "waived", "failed"] as const
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number]
export type MilestoneGate = "start" | "closing"
export type ReportedStatus = "in_progress" | "satisfied" | "failed"

/** Days before a due date the sweep announces, tightest first; `0` is due today or late. */
export const MILESTONE_REMINDER_DAYS = [7, 3, 1, 0] as const
/** A milestone due within this many days reads as "soon" on the desk. */
export const MILESTONE_SOON_DAYS = 3

export interface MilestoneFacts {
  id: string
  title: string
  kind: MilestoneKind
  status: MilestoneStatus
  requiredBefore: MilestoneGate | null
  dueOn: string | null
  evidenceRequired: boolean
  evidenceFileId: string | null
  reportedStatus: ReportedStatus | null
  createdAt: string
  dependsOn: string[]
}

const DAY_MS = 86_400_000

function utcDay(value: string): number {
  return Date.parse(`${value.slice(0, 10)}T00:00:00Z`)
}

/** Today's date (UTC) as YYYY-MM-DD. Dates in this module are calendar days. */
export function isoToday(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** Whole days from `today` to `date`. Negative is late. */
export function daysUntilDue(date: string, today: string): number {
  return Math.round((utcDay(date) - utcDay(today)) / DAY_MS)
}

export function isMilestoneResolved(status: MilestoneStatus) {
  return status === "satisfied" || status === "waived"
}

/** A gate holds while its milestone is open, and a failed one holds until someone waives it. */
export function isMilestoneBlocking(status: MilestoneStatus) {
  return status === "open" || status === "failed"
}

export interface MilestoneAging {
  /** Days since the milestone was opened, while it is open. */
  openDays: number | null
  /** Days past its due date, while open; null when not late. */
  overdueDays: number | null
  /** Days until it is due, while open and not late. */
  dueInDays: number | null
  tone: "late" | "soon" | "scheduled" | "none"
}

export function milestoneAging(milestone: Pick<MilestoneFacts, "status" | "dueOn" | "createdAt">, today: string): MilestoneAging {
  if (milestone.status !== "open") return { openDays: null, overdueDays: null, dueInDays: null, tone: "none" }
  const openDays = Math.max(0, daysUntilDue(today, milestone.createdAt))
  if (!milestone.dueOn) return { openDays, overdueDays: null, dueInDays: null, tone: "scheduled" }
  const days = daysUntilDue(milestone.dueOn, today)
  if (days < 0) return { openDays, overdueDays: -days, dueInDays: null, tone: "late" }
  return { openDays, overdueDays: null, dueInDays: days, tone: days <= MILESTONE_SOON_DAYS ? "soon" : "scheduled" }
}

/** The prerequisites still standing in a milestone's way. */
export function blockedBy(milestone: Pick<MilestoneFacts, "dependsOn">, all: ReadonlyArray<Pick<MilestoneFacts, "id" | "title" | "status">>) {
  const byId = new Map(all.map((row) => [row.id, row]))
  return milestone.dependsOn.flatMap((id) => {
    const row = byId.get(id)
    return row && !isMilestoneResolved(row.status) ? [row] : []
  })
}

/** What may be recorded on an open milestone now, and why not. */
export function satisfyRefusal(
  milestone: Pick<MilestoneFacts, "status" | "evidenceRequired" | "dependsOn">,
  all: ReadonlyArray<Pick<MilestoneFacts, "id" | "title" | "status">>,
  evidenceFileId: string | null,
): string | null {
  if (milestone.status !== "open") return "Only an open milestone can be satisfied"
  const blocking = blockedBy(milestone, all)
  if (blocking.length) return `Resolve ${blocking[0].title} first; this milestone depends on it`
  if (milestone.evidenceRequired && !evidenceFileId) return "Attach the evidence file from this home to satisfy it"
  return null
}

/** The milestones holding a gate, most urgent first. */
export function gateBlockers<T extends Pick<MilestoneFacts, "status" | "requiredBefore" | "dueOn" | "title">>(rows: ReadonlyArray<T>, gate: MilestoneGate): T[] {
  return rows
    .filter((row) => row.requiredBefore === gate && isMilestoneBlocking(row.status))
    .sort(compareMilestones)
}

/** The sentence the closing gate refuses with. */
export function gateRefusal(blocker: Pick<MilestoneFacts, "title" | "status">, gate: MilestoneGate): string {
  const target = gate === "start" ? "the house can start" : "closing"
  return blocker.status === "failed"
    ? `${blocker.title} failed. Waive it with a reason or end the agreement before ${target}.`
    : `Resolve the ${blocker.title} milestone before ${target}.`
}

/** Failed first, then late, then soonest due; undated last; then title. */
export function compareMilestones(
  a: Pick<MilestoneFacts, "status" | "dueOn" | "title">,
  b: Pick<MilestoneFacts, "status" | "dueOn" | "title">,
): number {
  const failed = Number(b.status === "failed") - Number(a.status === "failed")
  if (failed !== 0) return failed
  if (a.dueOn && b.dueOn && a.dueOn !== b.dueOn) return a.dueOn.localeCompare(b.dueOn)
  if (a.dueOn && !b.dueOn) return -1
  if (!a.dueOn && b.dueOn) return 1
  return a.title.localeCompare(b.title)
}

/** The one milestone a coordinator should chase next on this home, if any. */
export function nextMilestone<T extends Pick<MilestoneFacts, "status" | "dueOn" | "title">>(rows: ReadonlyArray<T>): T | null {
  return [...rows].filter((row) => isMilestoneBlocking(row.status)).sort(compareMilestones)[0] ?? null
}

/**
 * A home's milestone position as the Sales desk reads it: one row per home,
 * aggregated in SQL or in the loader, judged here.
 */
export interface MilestoneDeskSignal {
  openCount: number
  overdueCount: number
  failedCount: number
  nextTitle: string | null
  nextDueOn: string | null
  nextStatus: MilestoneStatus | null
}

export function milestoneDeskSignal(
  rows: ReadonlyArray<Pick<MilestoneFacts, "status" | "dueOn" | "title">>,
  today: string,
): MilestoneDeskSignal {
  const open = rows.filter((row) => isMilestoneBlocking(row.status))
  const next = nextMilestone(open)
  return {
    openCount: open.length,
    overdueCount: open.filter((row) => row.status === "open" && row.dueOn !== null && daysUntilDue(row.dueOn, today) < 0).length,
    failedCount: open.filter((row) => row.status === "failed").length,
    nextTitle: next?.title ?? null,
    nextDueOn: next?.dueOn ?? null,
    nextStatus: next?.status ?? null,
  }
}

/**
 * Whether the milestone outranks everything else the desk would say about the
 * deal: a failed contingency always, a late one always, one due within
 * MILESTONE_SOON_DAYS when nothing else is late.
 */
export function milestoneDeskAction(signal: MilestoneDeskSignal | null, today: string) {
  if (!signal || !signal.nextTitle) return null
  if (signal.nextStatus === "failed") {
    return { label: `${signal.nextTitle} failed`, detail: "Waive it with a reason or end the agreement", dueAt: null, tone: "overdue" as const }
  }
  if (!signal.nextDueOn) return null
  const days = daysUntilDue(signal.nextDueOn, today)
  if (days < 0) {
    return { label: `Chase ${signal.nextTitle}`, detail: `${-days} ${days === -1 ? "day" : "days"} late`, dueAt: signal.nextDueOn, tone: "overdue" as const }
  }
  if (days <= MILESTONE_SOON_DAYS) {
    return { label: `Chase ${signal.nextTitle}`, detail: days === 0 ? "Due today" : `Due in ${days} ${days === 1 ? "day" : "days"}`, dueAt: signal.nextDueOn, tone: "soon" as const }
  }
  return null
}

/**
 * The threshold the reminder sweep should announce now, once each: the
 * tightest crossed one not yet recorded in the row's metadata.
 */
export function milestoneReminderThreshold(dueOn: string, today: string, metadata: Record<string, unknown>): number | null {
  const daysOut = daysUntilDue(dueOn, today)
  const crossed = [...MILESTONE_REMINDER_DAYS].sort((a, b) => a - b).filter((days) => daysOut <= days)
  if (!crossed.length) return null
  return metadata[milestoneReminderKey(crossed[0])] ? null : crossed[0]
}

export function milestoneReminderKey(days: number) {
  return `reminded_${days}d_at`
}

/** How an external report reads on the workbench. */
export function reportedLabel(milestone: Pick<MilestoneFacts, "status" | "reportedStatus" | "evidenceRequired">): string | null {
  if (!milestone.reportedStatus || milestone.status !== "open") return null
  if (milestone.reportedStatus === "satisfied") {
    return milestone.evidenceRequired ? "Reported satisfied — attach evidence to confirm" : "Reported satisfied"
  }
  return milestone.reportedStatus === "failed" ? "Reported failed" : "Reported in progress"
}

/** The words a refused delivery's code stands for. */
export const DELIVERY_REASON_LABELS: Record<string, string> = {
  invalid_payload: "Payload did not match the format",
  agreement_unknown: "No agreement with that number",
  agreement_not_active: "Agreement is not active",
  buyer_mismatch: "Buyer email does not match the agreement",
  home_mismatch: "Lot or community does not match the agreement's home",
  milestone_unknown: "The agreement has no milestone of that kind",
  milestone_resolved: "The milestone was already resolved",
  stale: "Older than the last report",
  delivery_conflict: "Delivery id reused with a different body",
}
