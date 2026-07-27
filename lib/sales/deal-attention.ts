import {
  CLOSING_SOON_DAYS,
  HOLD_URGENT_DAYS,
  NEW_INQUIRY_SLA_HOURS,
  daysUntil,
} from "@/lib/sales/next-action"
import type { SalesDeal, SalesDealReservation } from "@/lib/services/sales-deals"

/**
 * Everything holding this deal up, derived from state rather than stored.
 *
 * The board's next-action column answers "what is the one thing to do"; this
 * answers the other half — "what else is wrong with this file". Kept a pure
 * function beside `nextActionFor` so both read off the same deal row and cannot
 * disagree about whether a hold has expired.
 */

/** Untouched this long and the deal is going cold; twice this and it is stale. */
export const COLD_DAYS = 14
export const STALE_DAYS = 30
/** Grace period before a brand-new lead with no logged touch counts against you. */
const UNTOUCHED_GRACE_DAYS = 3

export type DealAttentionKind =
  | "call_back"
  | "follow_up"
  | "follow_up_missing"
  | "hold_expiry"
  | "no_home"
  | "no_contact"
  | "no_touches"
  | "unassigned"
  | "deposit"
  | "agreement"
  | "closing_date"
  | "closing_gates"
  | "closing_late"

export type DealAttentionGroup = "overdue" | "at_risk" | "pending"

export interface DealAttentionItem {
  kind: DealAttentionKind
  title: string
  /** Right-hand meta — the number that makes it urgent, or why it is open. */
  meta: string
  group: DealAttentionGroup
  /** Where the work happens when another desk owns it, null when it happens here. */
  href: string | null
}

/** Worst first. The list is unified, so this is the only ordering there is. */
export const DEAL_ATTENTION_ORDER: DealAttentionGroup[] = ["overdue", "at_risk", "pending"]

function relativeLabel(days: number): string {
  if (days === 0) return "Today"
  if (days === 1) return "Tomorrow"
  if (days === -1) return "1d late"
  if (days < 0) return `${Math.abs(days)}d late`
  return `in ${days}d`
}

export interface DealAttentionInput {
  deal: SalesDeal
  reservation: SalesDealReservation | null
  /** False when there is no phone and no email anywhere on the deal. */
  hasContactDetails: boolean
  ownerAssigned: boolean
  /** When the consultant last logged a call, visit or note. */
  lastTouchAt: string | null
}

/**
 * A settled or lost deal returns nothing: there is no work left to chase, and a
 * list of grievances against a closed file is noise the consultant learns to
 * skip past on the files that still matter.
 */
export function dealAttentionItems(
  { deal, reservation, hasContactDetails, ownerAssigned, lastTouchAt }: DealAttentionInput,
  now: Date = new Date(),
): DealAttentionItem[] {
  const items: DealAttentionItem[] = []
  if (deal.stage === "lost" || deal.stage === "closed") return items

  const closingHref = deal.projectId ? `/projects/${deal.projectId}/closing` : null

  // The call you promised to make outranks everything else on the file.
  if (deal.nextFollowUpAt) {
    const days = daysUntil(deal.nextFollowUpAt, now)
    if (days <= 0) {
      items.push({
        kind: "follow_up",
        title: "Follow-up due",
        meta: relativeLabel(days),
        group: "overdue",
        href: null,
      })
    }
  } else if (deal.stage === "inquiry" || deal.stage === "working") {
    items.push({
      kind: "follow_up_missing",
      title: "No follow-up scheduled",
      meta: "Missing",
      group: "pending",
      href: null,
    })
  }

  // Silence is the failure mode nobody notices, so it is stated outright rather
  // than left for the reader to work out from the last row of the log.
  const daysSinceTouch = lastTouchAt ? -daysUntil(lastTouchAt, now) : null
  const daysOpen = -daysUntil(deal.createdAt, now)
  if (deal.stage === "inquiry" && daysSinceTouch === null) {
    // A registration nobody has called back is the one clock the whole desk is
    // judged on, so it is stated as the call it is rather than as silence.
    const due = new Date(new Date(deal.createdAt).getTime() + NEW_INQUIRY_SLA_HOURS * 3_600_000)
    const days = daysUntil(due.toISOString(), now)
    items.push({
      kind: "call_back",
      title: days <= 0 ? "Call back overdue" : "Call back due",
      meta: relativeLabel(days),
      group: days <= 0 ? "overdue" : "at_risk",
      href: null,
    })
  } else if (daysSinceTouch !== null && daysSinceTouch >= COLD_DAYS) {
    items.push({
      kind: "no_touches",
      title: `No contact in ${daysSinceTouch} days`,
      meta: daysSinceTouch >= STALE_DAYS ? "Stale" : "Going cold",
      group: daysSinceTouch >= STALE_DAYS ? "overdue" : "at_risk",
      href: null,
    })
  } else if (daysSinceTouch === null && daysOpen >= UNTOUCHED_GRACE_DAYS) {
    items.push({
      kind: "no_touches",
      title: "No contact logged yet",
      meta: `${daysOpen}d open`,
      group: "at_risk",
      href: null,
    })
  }

  // A buyer with no phone and no email cannot be worked at all.
  if (!hasContactDetails) {
    items.push({
      kind: "no_contact",
      title: "No phone or email on file",
      meta: "Missing",
      group: "at_risk",
      href: null,
    })
  }

  if (deal.stage === "hold" && deal.holdExpiresAt) {
    const days = daysUntil(deal.holdExpiresAt, now)
    items.push({
      kind: "hold_expiry",
      title: days < 0 ? "Hold has expired" : "Hold expires",
      meta: relativeLabel(days),
      group: days < 0 ? "overdue" : days <= HOLD_URGENT_DAYS ? "at_risk" : "pending",
      href: null,
    })
  }

  // A reservation nobody invoiced is a deposit nobody asked the buyer for.
  if (reservation && !reservation.depositInvoiceId) {
    items.push({
      kind: "deposit",
      title: "Deposit not invoiced",
      meta: "Not invoiced",
      group: "at_risk",
      href: null,
    })
  }

  if (deal.contractStatus === "draft") {
    items.push({
      kind: "agreement",
      title: "Agreement out for signature",
      meta: "Awaiting buyer",
      group: "at_risk",
      href: deal.projectId ? `/projects/${deal.projectId}/documents` : null,
    })
  } else if (deal.stage === "contract" && !deal.contractId) {
    items.push({
      kind: "agreement",
      title: "Purchase agreement not written",
      meta: "Not sent",
      group: "at_risk",
      href: null,
    })
  }

  const awaitsSettlement =
    deal.stage === "building" ||
    deal.stage === "closing" ||
    (deal.stage === "contract" && Boolean(deal.contractId))
  if (awaitsSettlement && !deal.closingScheduledDate) {
    items.push({
      kind: "closing_date",
      title: "Closing date not set",
      meta: "Not set",
      group: "at_risk",
      href: closingHref,
    })
  }

  if (deal.openGateCount > 0) {
    const days = deal.closingScheduledDate ? daysUntil(deal.closingScheduledDate, now) : null
    items.push({
      kind: "closing_gates",
      title: `${deal.openGateCount} closing ${deal.openGateCount === 1 ? "gate" : "gates"} open`,
      meta: days === null ? "Blocking" : relativeLabel(days),
      group: days !== null && days <= CLOSING_SOON_DAYS ? "overdue" : "at_risk",
      href: closingHref,
    })
  }

  if (deal.closingScheduledDate && !deal.closingActualDate) {
    const days = daysUntil(deal.closingScheduledDate, now)
    if (days < 0) {
      items.push({
        kind: "closing_late",
        title: "Closing date has passed",
        meta: relativeLabel(days),
        group: "overdue",
        href: closingHref,
      })
    }
  }

  // Housekeeping: real gaps, never urgent, so they sort to the bottom.
  if (deal.stage === "working" && !deal.lotId) {
    items.push({
      kind: "no_home",
      title: "No lot or plan selected",
      meta: "Pending",
      group: "pending",
      href: null,
    })
  }
  if (!ownerAssigned) {
    items.push({
      kind: "unassigned",
      title: "No sales consultant assigned",
      meta: "Unassigned",
      group: "pending",
      href: null,
    })
  }

  return items
}
