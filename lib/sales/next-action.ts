import type { SalesDeal } from "@/lib/services/sales-deals"

/**
 * Every deal gets exactly one next action with a date. This is the difference
 * between a report a rep has to interpret and a list that tells them what to do
 * today — and it is a pure function of deal state, so it is cheap to tune.
 */

/** A new inquiry that has not been called back within this window is late. */
export const NEW_INQUIRY_SLA_HOURS = 24
/** A hold inside this window is treated as urgent, not merely scheduled. */
export const HOLD_URGENT_DAYS = 3
/** How far ahead "closing this week" reaches. */
export const CLOSING_SOON_DAYS = 7

export type NextActionTone = "overdue" | "soon" | "scheduled" | "none"

export interface NextAction {
  /** Imperative, in the words a sales consultant would use. */
  label: string
  /** Supporting line — the date, or why this is the action. */
  detail: string | null
  /** ISO date or timestamp the action is anchored to, when there is one. */
  dueAt: string | null
  tone: NextActionTone
}

const TONE_ORDER: Record<NextActionTone, number> = { overdue: 0, soon: 1, scheduled: 2, none: 3 }

const DAY_MS = 86_400_000

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

/**
 * Whole days from today to the target, in local time. Positive is future.
 * Date-only strings (a closing date) are parsed as local, not UTC, so a closing
 * "today" never reads as yesterday west of Greenwich.
 */
export function daysUntil(value: string, now: Date): number {
  const target = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`)
    : new Date(value)
  if (Number.isNaN(target.getTime())) return Number.POSITIVE_INFINITY
  return Math.round((startOfDay(target).getTime() - startOfDay(now).getTime()) / DAY_MS)
}

function toneForDays(days: number, urgentWithin = HOLD_URGENT_DAYS): NextActionTone {
  if (days < 0) return "overdue"
  if (days <= urgentWithin) return "soon"
  return "scheduled"
}

function relativeDay(days: number): string {
  if (days === 0) return "today"
  if (days === 1) return "tomorrow"
  if (days === -1) return "1 day late"
  if (days < 0) return `${Math.abs(days)} days late`
  return `in ${days} days`
}

function formatDate(value: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function dated(label: string, value: string, now: Date, urgentWithin?: number): NextAction {
  const days = daysUntil(value, now)
  return {
    label,
    detail: `${formatDate(value)} — ${relativeDay(days)}`,
    dueAt: value,
    tone: toneForDays(days, urgentWithin),
  }
}

/** A follow-up the consultant set for today or earlier, at any open stage. */
function dueFollowUp(deal: SalesDeal, now: Date): string | null {
  if (!deal.nextFollowUpAt) return null
  if (deal.stage === "closed" || deal.stage === "lost") return null
  return daysUntil(deal.nextFollowUpAt, now) <= 0 ? deal.nextFollowUpAt : null
}

/**
 * The one thing to do next on this deal.
 *
 * A follow-up the consultant scheduled for today outranks everything else,
 * whatever the stage — most of the book is already sold, and shepherding a
 * backlog buyer is a call you promised to make, not a stage transition.
 *
 * Deliberately never invents work that belongs to another desk: a selections
 * appointment is Design Studio's to schedule, so the deal only ever surfaces
 * and links to it.
 */
export function nextActionFor(deal: SalesDeal, now: Date = new Date()): NextAction {
  const followUp = dueFollowUp(deal, now)
  if (followUp) return dated("Follow up", followUp, now)

  switch (deal.stage) {
    case "inquiry": {
      const due = new Date(new Date(deal.createdAt).getTime() + NEW_INQUIRY_SLA_HOURS * 3_600_000)
      const days = daysUntil(due.toISOString(), now)
      return {
        label: "Call back",
        detail: days < 0 ? relativeDay(days) : `Due ${relativeDay(days)}`,
        dueAt: due.toISOString(),
        tone: days < 0 ? "overdue" : "soon",
      }
    }

    case "working": {
      if (deal.nextFollowUpAt) return dated("Follow up", deal.nextFollowUpAt, now)
      return { label: "Set a follow-up", detail: "No follow-up scheduled", dueAt: null, tone: "soon" }
    }

    case "hold": {
      if (!deal.holdExpiresAt) {
        return { label: "Write the contract", detail: "Lot is on hold", dueAt: null, tone: "soon" }
      }
      return dated("Hold expires", deal.holdExpiresAt, now)
    }

    case "contract": {
      if (deal.contractStatus === "draft") {
        return { label: "Out for signature", detail: "Purchase agreement sent to buyer", dueAt: null, tone: "soon" }
      }
      if (!deal.contractId) {
        return { label: "Send purchase agreement", detail: "Lot is reserved", dueAt: null, tone: "soon" }
      }
      if (deal.closingScheduledDate) return dated("Closing", deal.closingScheduledDate, now, CLOSING_SOON_DAYS)
      return { label: "Confirm closing date", detail: "Agreement executed", dueAt: null, tone: "soon" }
    }

    case "building": {
      if (!deal.closingScheduledDate) {
        return { label: "Confirm closing date", detail: "Home is under construction", dueAt: null, tone: "soon" }
      }
      return dated("Closing", deal.closingScheduledDate, now, CLOSING_SOON_DAYS)
    }

    case "closing": {
      if (deal.openGateCount > 0) {
        const label = `${deal.openGateCount} closing ${deal.openGateCount === 1 ? "gate" : "gates"} open`
        if (!deal.closingScheduledDate) return { label, detail: "Blocking settlement", dueAt: null, tone: "soon" }
        const days = daysUntil(deal.closingScheduledDate, now)
        return {
          label,
          detail: `Closes ${formatDate(deal.closingScheduledDate)} — ${relativeDay(days)}`,
          dueAt: deal.closingScheduledDate,
          tone: days <= CLOSING_SOON_DAYS ? (days < 0 ? "overdue" : "soon") : "scheduled",
        }
      }
      if (!deal.closingScheduledDate) {
        return { label: "Schedule the closing", detail: "Cleared to close", dueAt: null, tone: "soon" }
      }
      return dated("Closing", deal.closingScheduledDate, now, CLOSING_SOON_DAYS)
    }

    case "closed":
      return {
        label: "Nothing due",
        detail: deal.closingActualDate ? `Closed ${formatDate(deal.closingActualDate)}` : "Closed",
        dueAt: null,
        tone: "none",
      }

    case "lost":
      return { label: "Nothing due", detail: "Lost", dueAt: null, tone: "none" }
  }
}

/** Urgency first, then soonest date. What is late outranks what is merely big. */
export function compareByNextAction(a: NextAction, b: NextAction): number {
  const tone = TONE_ORDER[a.tone] - TONE_ORDER[b.tone]
  if (tone !== 0) return tone
  if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt)
  if (a.dueAt) return -1
  if (b.dueAt) return 1
  return 0
}

/** The attention chips across the top of the board. Each one filters the list. */
export const DEAL_FILTERS = [
  "all",
  "followup_due",
  "hold_expiring",
  "out_for_signature",
  "closing_soon",
  "new_inquiries",
] as const

export type DealFilter = (typeof DEAL_FILTERS)[number]

export function isDealFilter(value: string | undefined): value is DealFilter {
  return DEAL_FILTERS.some((filter) => filter === value)
}

export const DEAL_FILTER_LABELS: Record<DealFilter, string> = {
  all: "All my deals",
  followup_due: "Follow-ups due",
  hold_expiring: "Holds expiring",
  out_for_signature: "Out for signature",
  closing_soon: "Closing this week",
  new_inquiries: "New inquiries",
}

export function matchesDealFilter(deal: SalesDeal, filter: DealFilter, now: Date = new Date()): boolean {
  switch (filter) {
    case "all":
      return true
    case "followup_due": {
      if (dueFollowUp(deal, now)) return true
      // A new inquiry nobody has called back is a follow-up whether or not
      // anyone got as far as scheduling one.
      return deal.stage === "inquiry" && nextActionFor(deal, now).tone === "overdue"
    }
    case "hold_expiring": {
      const expiry = deal.holdExpiresAt
      return deal.stage === "hold" && expiry !== null && daysUntil(expiry, now) <= HOLD_URGENT_DAYS
    }
    case "out_for_signature":
      return deal.contractStatus === "draft"
    case "closing_soon": {
      if (!deal.closingScheduledDate) return false
      if (deal.stage === "closed" || deal.stage === "lost") return false
      const days = daysUntil(deal.closingScheduledDate, now)
      return days >= 0 && days <= CLOSING_SOON_DAYS
    }
    case "new_inquiries":
      return deal.stage === "inquiry"
  }
}
