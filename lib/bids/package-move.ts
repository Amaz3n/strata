import { formatDistanceStrict } from "date-fns"
import { bidEligibilityReason } from "@/lib/bids/pricing"
import { getBidPackageStage, type BidPackageStage } from "@/lib/bids/stage"
import { formatMoneyCents } from "@/lib/utils"

/**
 * A bid package answers one question at a time: where does it stand, and what
 * is the one thing to do next. Everything here is derived from records, never
 * stored, so the page can never claim a stage its invites, bids and award
 * contradict. Client-safe and pure — the workbench renders it, the tests pin it.
 */

// ---------------------------------------------------------------- trades

/** Where one invited trade stands, as the board's column header reports it. */
export type TradeState =
  | "lined_up"
  | "sent"
  | "opened"
  | "declined"
  | "withdrawn"
  | "priced"
  | "stale"
  | "no_response"
  | "awarded"
  | "not_selected"

export const TRADE_STATE_LABELS: Record<TradeState, string> = {
  lined_up: "Ready to send",
  sent: "Sent",
  opened: "Opened",
  declined: "Declined",
  withdrawn: "Withdrew",
  priced: "Priced",
  stale: "Needs a refreshed price",
  no_response: "No response",
  awarded: "Awarded",
  not_selected: "Not selected",
}

/** States whose column carries prices on the board. */
export function tradeHasPrices(state: TradeState) {
  return state === "priced" || state === "awarded" || state === "not_selected"
}

export interface TradeStateInput {
  inviteStatus: string
  /** The trade's current submission, when it has one. */
  submission: {
    status: string
    is_current?: boolean
    total_cents?: number | null
    valid_until?: string | null
    scope_revision?: number
    is_awarded?: boolean
  } | null
  packageStage: BidPackageStage
  scopeRevision: number
  today: string
}

export function tradeState({ inviteStatus, submission, packageStage, scopeRevision, today }: TradeStateInput): TradeState {
  if (inviteStatus === "draft") return "lined_up"
  if (inviteStatus === "withdrawn") return "withdrawn"
  if (inviteStatus === "declined") return "declined"
  if (submission) {
    if (packageStage === "awarded") return submission.is_awarded ? "awarded" : "not_selected"
    return bidEligibilityReason(submission, scopeRevision, today) ? "stale" : "priced"
  }
  if (packageStage === "leveling" || packageStage === "awarded") return "no_response"
  return inviteStatus === "viewed" ? "opened" : "sent"
}

// ---------------------------------------------------------------- subcontract

/** Where the awarded subcontract stands. Derived from the commitment and its latest envelope. */
export type SubcontractStage = "draft" | "approved" | "out_for_signature" | "partially_signed" | "executed" | "canceled"

export const SUBCONTRACT_STAGE_LABELS: Record<SubcontractStage, string> = {
  draft: "Draft",
  approved: "Approved",
  out_for_signature: "Out for signature",
  partially_signed: "Partly signed",
  executed: "Signed",
  canceled: "Canceled",
}

export function subcontractStage(
  commitment: { status: string; executed_at: string | null },
  envelope: { status: string } | null,
): SubcontractStage {
  if (commitment.executed_at || envelope?.status === "executed") return "executed"
  if (commitment.status === "canceled") return "canceled"
  if (envelope?.status === "partially_signed") return "partially_signed"
  if (envelope?.status === "sent") return "out_for_signature"
  if (commitment.status === "approved") return "approved"
  return "draft"
}

// ---------------------------------------------------------------- the move

export type MoveKind =
  | "add_scope"
  | "add_trades"
  | "set_due_date"
  | "send"
  | "nudge"
  | "close_bidding"
  | "reopen"
  | "award"
  | "use_quote"
  | "review_subcontract"
  | "send_subcontract"
  | "view_subcontract"
  | "restore"

export interface Move {
  kind: MoveKind
  label: string
  /** The bid the move acts on (award, use_quote). */
  submissionId?: string
}

export interface RankedBid {
  submissionId: string
  companyName: string
  asBidCents: number
  leveledCents: number
  /** Excluded or unpriced base lines with no plug: the leveled total understates the cost. */
  unpluggedLines: number
}

export interface PackageMoveInput {
  status: string
  dueAt: string | null
  mode: "quote" | "tender"
  awardTarget: "commitment" | "price_agreement"
  canAward: boolean
  scopeLineCount: number
  budgetCents: number | null
  trades: Array<{ state: TradeState }>
  /** Eligible, current bids. Any order. */
  bids: RankedBid[]
  award: {
    companyName: string
    totalCents: number
    subcontract: { stage: SubcontractStage; number: string | null; sentAt: string | null; executedAt: string | null } | null
  } | null
  now: Date
}

export interface PackageMove {
  stage: BidPackageStage
  /** The bolded half of the sentence. */
  lead: string
  detail: string
  primary: Move | null
  secondary: Move | null
}

const money = formatMoneyCents
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

export function rankBids(bids: RankedBid[]): RankedBid[] {
  return [...bids].sort((a, b) => a.leveledCents - b.leveledCents || a.asBidCents - b.asBidCents)
}

function budgetPhrase(cents: number, budget: number | null) {
  if (!budget || budget <= 0) return ""
  const pct = ((cents - budget) / budget) * 100
  if (Math.abs(pct) < 0.05) return ", right on budget"
  return `, ${Math.abs(pct).toFixed(1)}% ${pct < 0 ? "under" : "over"} budget`
}

export function bidPackageMove(input: PackageMoveInput): PackageMove {
  const stage = getBidPackageStage({ status: input.status, due_at: input.dueAt }, input.now)
  const count = (state: TradeState) => input.trades.filter((trade) => trade.state === state).length

  if (stage === "cancelled") {
    return {
      stage,
      lead: "This package is cancelled.",
      detail: "Trades can't open it or submit.",
      primary: { kind: "restore", label: "Restore to draft" },
      secondary: null,
    }
  }

  if (stage === "awarded") return awardedMove(stage, input)

  if (stage === "setup") {
    const linedUp = count("lined_up")
    if (input.mode === "tender" && input.scopeLineCount === 0) {
      return {
        stage,
        lead: "Start with the scope.",
        detail: "Trades price each line, so their bids compare line for line.",
        primary: { kind: "add_scope", label: "Add scope line" },
        secondary: null,
      }
    }
    const scopeLead = input.scopeLineCount
      ? `${plural(input.scopeLineCount, "scope line")}${input.budgetCents ? `, ${money(input.budgetCents)} budget` : ""}.`
      : "Ready for trades."
    if (linedUp === 0) {
      return {
        stage,
        lead: scopeLead,
        detail: "Add the trades you want pricing from.",
        primary: { kind: "add_trades", label: "Add trades" },
        secondary: null,
      }
    }
    if (!input.dueAt || new Date(input.dueAt) <= input.now) {
      return {
        stage,
        lead: `${plural(linedUp, "trade")} lined up.`,
        detail: "Set when bids are due, then send.",
        primary: { kind: "set_due_date", label: "Set due date" },
        secondary: { kind: "add_trades", label: "Add trades" },
      }
    }
    return {
      stage,
      lead: `${plural(linedUp, "trade")} lined up.`,
      detail: `Bids due in ${formatDistanceStrict(new Date(input.dueAt), input.now)}. Each trade gets a private link when you send.`,
      primary: { kind: "send", label: `Send to ${plural(linedUp, "trade")}` },
      secondary: { kind: "add_trades", label: "Add trades" },
    }
  }

  if (stage === "bidding") {
    const priced = count("priced")
    const quiet = count("sent") + count("opened")
    const invited = input.trades.filter((trade) => trade.state !== "lined_up").length
    const due = input.dueAt ? `Due in ${formatDistanceStrict(new Date(input.dueAt), input.now)}.` : "No due date set."
    const waiting = quiet ? ` ${quiet === 1 ? "1 hasn't" : `${quiet} haven't`} priced yet.` : ""
    const lead = invited === 0 ? "Bidding is open." : `${priced} of ${plural(invited, "trade")} ${priced === 1 ? "has" : "have"} priced.`
    if (quiet > 0) {
      return {
        stage,
        lead,
        detail: `${due}${waiting}`,
        primary: { kind: "nudge", label: `Nudge ${quiet}` },
        secondary: priced >= 2 ? { kind: "close_bidding", label: "Close early" } : null,
      }
    }
    if (priced > 0) {
      return {
        stage,
        lead,
        detail: `${due} Everyone invited has answered.`,
        primary: { kind: "close_bidding", label: "Close bidding" },
        secondary: { kind: "add_trades", label: "Add trades" },
      }
    }
    return {
      stage,
      lead,
      detail: `${due} Nobody is left to hear from.`,
      primary: { kind: "add_trades", label: "Add trades" },
      secondary: null,
    }
  }

  // Leveling: bidding closed or past due.
  const ranked = rankBids(input.bids)
  const stale = count("stale")
  if (ranked.length === 0) {
    return {
      stage,
      lead: "No usable bids yet.",
      detail: stale
        ? `${plural(stale, "bid")} ${stale === 1 ? "needs" : "need"} a refreshed price against the current scope.`
        : "Extend the due date or bring in more trades.",
      primary: input.status === "closed"
        ? { kind: "reopen", label: "Reopen bidding" }
        : { kind: "set_due_date", label: "Extend due date" },
      secondary: { kind: "add_trades", label: "Add trades" },
    }
  }

  const low = ranked[0]
  const lead = `${low.companyName} is low at ${money(low.leveledCents)}${budgetPhrase(low.leveledCents, input.budgetCents)}.`
  const notes: string[] = []
  const paperLow = [...ranked].sort((a, b) => a.asBidCents - b.asBidCents)[0]
  if (paperLow.submissionId !== low.submissionId) {
    notes.push(`${paperLow.companyName} is lower on paper until its excluded scope is counted.`)
  }
  const understated = ranked.filter((bid) => bid.unpluggedLines > 0)
  if (understated.length) {
    notes.push(
      `${understated.map((bid) => bid.companyName).join(" and ")} ${understated.length === 1 ? "has" : "have"} excluded lines with no plug, so ${understated.length === 1 ? "that total is" : "those totals are"} understated.`,
    )
  }
  if (ranked.length === 1) notes.push("Only one usable bid came in.")
  if (stale) notes.push(`${plural(stale, "other bid")} ${stale === 1 ? "needs" : "need"} a refreshed price.`)

  const primary: Move | null = input.canAward
    ? { kind: "award", label: `Award ${low.companyName}`, submissionId: low.submissionId }
    : input.awardTarget === "commitment"
      ? { kind: "use_quote", label: `Use ${low.companyName}'s price`, submissionId: low.submissionId }
      : null

  return { stage, lead, detail: notes.join(" "), primary, secondary: null }
}

function awardedMove(stage: BidPackageStage, input: PackageMoveInput): PackageMove {
  const award = input.award
  if (!award) {
    return { stage, lead: "This package is awarded.", detail: "", primary: null, secondary: null }
  }
  const lead = `Awarded to ${award.companyName} for ${money(award.totalCents)}.`
  if (input.awardTarget === "price_agreement") {
    return { stage, lead, detail: "The prices are in the price book for every house that uses them.", primary: null, secondary: null }
  }
  const subcontract = award.subcontract
  if (!subcontract) return { stage, lead, detail: "", primary: null, secondary: null }
  const name = subcontract.number ? `Subcontract ${subcontract.number}` : "The subcontract"
  switch (subcontract.stage) {
    case "draft":
      return {
        stage,
        lead,
        detail: `${name} is drafted from the bid. Review it before it goes out.`,
        primary: { kind: "review_subcontract", label: "Review subcontract" },
        secondary: null,
      }
    case "approved":
      return {
        stage,
        lead,
        detail: `${name} is approved and ready to sign.`,
        primary: { kind: "send_subcontract", label: "Send for signature" },
        secondary: { kind: "view_subcontract", label: "Open subcontract" },
      }
    case "out_for_signature":
    case "partially_signed":
      return {
        stage,
        lead,
        detail: `${name} is out for signature${subcontract.sentAt ? ` since ${formatDistanceStrict(new Date(subcontract.sentAt), input.now)} ago` : ""}.`,
        primary: null,
        secondary: { kind: "view_subcontract", label: "Open subcontract" },
      }
    case "executed":
      return {
        stage,
        lead: `${award.companyName} is under contract for ${money(award.totalCents)}.`,
        detail: `${name} is signed and committed on the budget.`,
        primary: null,
        secondary: { kind: "view_subcontract", label: "Open subcontract" },
      }
    case "canceled":
      return { stage, lead, detail: `${name} was canceled.`, primary: null, secondary: null }
  }
}
