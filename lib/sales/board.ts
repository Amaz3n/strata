import {
  compareByNextAction,
  daysUntil,
  matchesDealFilter,
  nextActionFor,
  DEAL_FILTERS,
  type DealFilter,
  type NextAction,
} from "@/lib/sales/next-action"
import { FUNNEL_STAGES } from "@/lib/sales/stages"
import type { SalesDeal, SalesDealStage } from "@/lib/services/sales-deals"

/**
 * How the board is shaped before it is rendered. All pure functions of the deal
 * rows, so the page stays a thin async shell and the ordering rules are one
 * place to read and tune.
 */

/**
 * Three books, not three tabs of the same one. Open is the work queue and gets
 * the attention rail and time buckets; Closed and Lost are records — nothing on
 * them is due, so they render flat and quiet.
 */
export const DEAL_VIEWS = ["open", "closed", "lost"] as const
export type DealView = (typeof DEAL_VIEWS)[number]

export const DEAL_VIEW_LABELS: Record<DealView, string> = {
  open: "Open",
  closed: "Closed",
  lost: "Lost",
}

export function isDealView(value: string | undefined): value is DealView {
  return DEAL_VIEWS.some((view) => view === value)
}

/**
 * When, not what. A consultant working Monday morning wants what is late kept
 * apart from what is due in three weeks — a single date-sorted list buries the
 * former under the latter as the backlog grows.
 */
export const DEAL_BUCKETS = ["overdue", "today", "week", "ahead"] as const
export type DealBucket = (typeof DEAL_BUCKETS)[number]

export const DEAL_BUCKET_LABELS: Record<DealBucket, string> = {
  overdue: "Overdue",
  today: "Today",
  week: "This week",
  ahead: "Ahead",
}

const WEEK_DAYS = 7

/** Undated-but-urgent work (no follow-up set, contract to write) lands in Today. */
export function bucketFor(action: NextAction, now: Date): DealBucket {
  if (action.tone === "overdue") return "overdue"
  if (!action.dueAt) return action.tone === "soon" ? "today" : "ahead"
  const days = daysUntil(action.dueAt, now)
  if (days <= 0) return "today"
  if (days <= WEEK_DAYS) return "week"
  return "ahead"
}

export function matchesSearch(deal: SalesDeal, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [deal.buyerName, deal.communityName, deal.lotLabel, deal.planName, deal.buyerPhone, deal.buyerEmail]
    .some((field) => field?.toLowerCase().includes(needle))
}

export interface BoardDeal {
  deal: SalesDeal
  action: NextAction
  bucket: DealBucket
}

export interface BoardGroup {
  bucket: DealBucket
  deals: BoardDeal[]
}

export interface BoardSummary {
  /** Deals in the current view, after search. */
  count: number
  /** Contract/asking value of those deals — the backlog number in one glance. */
  valueCents: number
}

export interface FunnelStageSummary {
  stage: SalesDealStage
  count: number
  valueCents: number
}

export interface Board {
  groups: BoardGroup[]
  /** Flat rows, for the views that do not bucket. */
  rows: BoardDeal[]
  counts: Record<DealFilter, number>
  /** Per-stage totals, counted before either narrowing is applied. */
  funnel: FunnelStageSummary[]
  summary: BoardSummary
  /** Deals in the view before search narrowed it — tells an empty state which story to tell. */
  viewTotal: number
}

function inView(deal: SalesDeal, view: DealView): boolean {
  if (view === "closed") return deal.stage === "closed"
  if (view === "lost") return deal.stage === "lost"
  return deal.stage !== "closed" && deal.stage !== "lost"
}

/** Records read newest-first: the closing that just settled, the deal just lost. */
function compareByRecency(a: SalesDeal, b: SalesDeal): number {
  const left = a.closingActualDate ?? a.updatedAt ?? a.createdAt
  const right = b.closingActualDate ?? b.updatedAt ?? b.createdAt
  return right.localeCompare(left)
}

export function buildBoard(
  deals: SalesDeal[],
  {
    view,
    filter,
    stage,
    search,
    now,
  }: { view: DealView; filter: DealFilter; stage: SalesDealStage | null; search: string; now: Date },
): Board {
  const inScope = deals.filter((deal) => inView(deal, view))
  const searched = inScope.filter((deal) => matchesSearch(deal, search))

  // Both narrowings count against the searched set, never against each other —
  // clicking one lens must not blank out the numbers on the other.
  const counts = Object.fromEntries(
    DEAL_FILTERS.map((key) => [key, searched.filter((deal) => matchesDealFilter(deal, key, now)).length]),
  ) as Record<DealFilter, number>

  const funnel: FunnelStageSummary[] = FUNNEL_STAGES.map((key) => {
    const inStage = searched.filter((deal) => deal.stage === key)
    return {
      stage: key,
      count: inStage.length,
      valueCents: inStage.reduce((total, deal) => total + (deal.priceCents ?? 0), 0),
    }
  })

  const visible = searched
    .filter((deal) => matchesDealFilter(deal, filter, now))
    .filter((deal) => (stage ? deal.stage === stage : true))

  const rows: BoardDeal[] =
    view === "open"
      ? visible
          .map((deal) => {
            const action = nextActionFor(deal, now)
            return { deal, action, bucket: bucketFor(action, now) }
          })
          .sort((a, b) => compareByNextAction(a.action, b.action))
      : visible
          .sort(compareByRecency)
          .map((deal) => {
            const action = nextActionFor(deal, now)
            return { deal, action, bucket: bucketFor(action, now) }
          })

  const groups: BoardGroup[] = DEAL_BUCKETS.map((bucket) => ({
    bucket,
    deals: rows.filter((row) => row.bucket === bucket),
  })).filter((group) => group.deals.length > 0)

  return {
    groups,
    rows,
    counts,
    funnel,
    summary: {
      count: rows.length,
      valueCents: rows.reduce((total, row) => total + (row.deal.priceCents ?? 0), 0),
    },
    viewTotal: inScope.length,
  }
}
