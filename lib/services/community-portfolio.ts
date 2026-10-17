import "server-only"
import { cache } from "react"


import { LOT_STATUSES, type LotStatus } from "@/lib/land/lot-lifecycle"
import { readAllRows } from "@/lib/land/paging"
import { buildRunway, runwayVerdict, type RunwayPoint, type RunwayVerdict } from "@/lib/land/runway"
import { compareSupplyUrgency, dryDateFrom, lotShortfallByYear, type YearShortfall } from "@/lib/land/supply"
import { takedownCash, type LandDepositStatus } from "@/lib/land/takedown-cash"
import { listCommunities, type CommunityListItemDTO } from "@/lib/services/communities"
import { countEntitlementBlockersByCommunity } from "@/lib/services/land-entitlements"
import { specCompletionDate, specInventoryAge } from "@/lib/sales/spec-inventory"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { getProductionPortfolioReport } from "@/lib/services/production-reporting"

/** Lots a buyer could still be sold. Everything before this is dirt, after it is gone. */
const SELLABLE_LOT_STATUSES: LotStatus[] = ["owned", "developed", "assigned"]
const LIVE_RESERVATION_STATUSES = ["hold", "reserved"]
/** A quarter is the shortest window where a small builder's rate is not noise. */
const RATE_WINDOW_DAYS = 90
/**
 * The board fetches two years so the horizon control is a client-side zoom
 * rather than a refetch; a takedown schedule is a handful of rows either way.
 */
const RUNWAY_HORIZON_MONTHS = 24
const HOLD_EXPIRY_WARNING_DAYS = 3
const CUTOFF_WARNING_DAYS = 14
const SPEC_AGING_ALERT_DAYS = 90
const DAYS_PER_MONTH = 30.4375
const MS_PER_DAY = 86_400_000
/** PostgREST puts `in()` filters in the URL, so long id lists go out in batches. */
const PROJECT_FILTER_BATCH = 400
/**
 * A ceiling on the homes read, not a page size. Only lots that carry a live home
 * are read — closed houses answer none of the questions below — so this bounds a
 * runaway rather than a real portfolio.
 */
const HOMED_LOT_SCAN_CAP = 20_000
/** The same kind of ceiling for each fact read (reservations, starts, closings, takedowns). */
const FACT_SCAN_CAP = 20_000

export type PaceState = "ahead" | "on" | "behind" | "unknown"

export interface CommunityUrgency {
  kind: "holds_expiring" | "starts_blocked" | "cutoffs_due" | "specs_aging" | "entitlements_blocked"
  label: string
  count: number
  href: string
  tone: "warning" | "critical" | "neutral"
}

export interface CommunityTakedown {
  id: string
  name: string
  scheduledDate: string
  /** Fractional months from today — the x position of the step on the runway. */
  monthOffset: number
  lotCount: number
  /** Cash due at closing: the price less the deposits credited against it (`takedownCash`). */
  cashCents: number
  /** Deposits on the contract's schedule that are credited against this takedown. */
  depositCents: number
}

export interface CommunityLane {
  id: string
  name: string
  code: string | null
  status: CommunityListItemDTO["status"]
  divisionName: string | null
  market: string | null
  lotCounts: Record<LotStatus, number>
  totalLots: number
  plannedLotCount: number | null
  sellableLots: number
  /** Net sales per month over the trailing quarter — the demand read. */
  salesPacePerMonth: number
  requiredPacePerMonth: number | null
  paceState: PaceState
  startsLast90: number
  /**
   * Lots leaving sellable inventory per month. A lot is consumed when it is
   * started, not when it is sold, so this is the rate that drains the curve —
   * and the single definition of months of supply in the app.
   */
  consumptionPerMonth: number | null
  monthsOfSupply: number | null
  /** Sellable lots over time: falls at the consumption rate, steps up at takedowns. */
  runway: RunwayPoint[]
  /** Months from today at which the curve reaches zero; null if it never does. */
  dryAtMonth: number | null
  verdict: RunwayVerdict
  takedowns: CommunityTakedown[]
  salesLast90: number
  cancelsLast90: number
  /** Oldest month first; `count` is scheduled closings in that month. */
  closingsByMonth: Array<{ month: string; count: number }>
  marginPercent: number | null
  targetMarginPercent: number | null
  urgencies: CommunityUrgency[]
}

export interface CommunityPortfolio {
  horizonMonths: number
  lanes: CommunityLane[]
  /**
   * True when a read ceiling stopped this board short of the whole portfolio, so
   * the aging and cutoff counts below it are floors rather than totals. The board
   * says so on screen; it must never quietly report a partial number as a total.
   */
  truncated: boolean
  totals: {
    communities: number
    totalLots: number
    sellableLots: number
    closingsThisMonth: number
    behindPace: number
    runningDry: number
    takedownCashCents: number
  }
}

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10)
}

function monthKey(value: string) {
  return value.slice(0, 7)
}

function paceStateFor(pace: number, required: number | null): PaceState {
  if (required == null || required <= 0) return "unknown"
  if (pace >= required * 1.05) return "ahead"
  if (pace >= required * 0.9) return "on"
  return "behind"
}

/**
 * Every community on one page, shaped for the runway board: sellable inventory
 * projected forward against the rate it is being consumed, the takedowns that
 * refill it, and the handful of things that need somebody today. One bounded
 * read per fact — a local production builder runs 3–10 communities, so this
 * stays a small page.
 */
export async function getCommunityPortfolio(
  { divisionId, status, communityId }: { divisionId?: string; status?: string; communityId?: string } = {},
  orgId?: string,
): Promise<CommunityPortfolio> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)

  const listed = await listCommunities({ divisionId, status }, context.orgId)
  // Filtering after the list keeps division scoping and the lot-count map on one
  // path, so a single community's lane is computed by exactly the same math the
  // board uses — the workbench must never disagree with the desk it came from.
  const communities = communityId ? listed.filter((community) => community.id === communityId) : listed
  const ids = communities.map((community) => community.id)
  if (ids.length === 0) {
    return {
      horizonMonths: RUNWAY_HORIZON_MONTHS,
      lanes: [],
      truncated: false,
      totals: {
        communities: 0,
        totalLots: 0,
        sellableLots: 0,
        closingsThisMonth: 0,
        behindPace: 0,
        runningDry: 0,
        takedownCashCents: 0,
      },
    }
  }

  const today = new Date()
  const rateSince = new Date(today)
  rateSince.setDate(rateSince.getDate() - RATE_WINDOW_DAYS)
  const horizonEnd = new Date(today)
  horizonEnd.setMonth(horizonEnd.getMonth() + RUNWAY_HORIZON_MONTHS)
  const holdWarning = new Date(today)
  holdWarning.setDate(holdWarning.getDate() + HOLD_EXPIRY_WARNING_DAYS)
  const cutoffWarning = new Date(today)
  cutoffWarning.setDate(cutoffWarning.getDate() + CUTOFF_WARNING_DAYS)

  // Margin is an executive fact; a land manager without report.read still gets a
  // full lane, just without the money column.
  const canReadMargin = await hasPermission("financials.margin.read", context)
  // Unmet entitlements and conditions, read alongside the facts below. Its
  // failure surfaces at the await; the no-op catch only keeps it from being
  // reported as unhandled if a read below fails first.
  const entitlementPressurePromise = countEntitlementBlockersByCommunity(context.supabase, context.orgId, ids)
  entitlementPressurePromise.catch(() => undefined)

  const [
    liveReservations,
    convertedReservations,
    cancelledReservations,
    releasedStarts,
    closings,
    takedowns,
    blockedStarts,
    lots,
    marginReport,
  ] = await Promise.all([
    readAllRows<{ community_id: string; lot_id: string; status: string; expires_at: string | null }>(
      (from, to) =>
        context.supabase
          .from("lot_reservations")
          .select("community_id, lot_id, status, expires_at")
          .eq("org_id", context.orgId)
          .in("community_id", ids)
          .in("status", LIVE_RESERVATION_STATUSES)
          .order("id")
          .range(from, to),
      { cap: FACT_SCAN_CAP, label: "Failed to load community portfolio" },
    ),
    readAllRows<{ community_id: string }>(
      (from, to) =>
        context.supabase
          .from("lot_reservations")
          .select("community_id, converted_at")
          .eq("org_id", context.orgId)
          .in("community_id", ids)
          .gte("converted_at", rateSince.toISOString())
          .order("id")
          .range(from, to),
      { cap: FACT_SCAN_CAP, label: "Failed to load community portfolio" },
    ),
    readAllRows<{ community_id: string }>(
      (from, to) =>
        context.supabase
          .from("lot_reservations")
          .select("community_id, released_at, converted_at")
          .eq("org_id", context.orgId)
          .in("community_id", ids)
          .eq("status", "released")
          .not("converted_at", "is", null)
          .gte("released_at", rateSince.toISOString())
          .order("id")
          .range(from, to),
      { cap: FACT_SCAN_CAP, label: "Failed to load community portfolio" },
    ),
    readAllRows<{ community_id: string }>(
      (from, to) =>
        context.supabase
          .from("start_packages")
          .select("community_id")
          .eq("org_id", context.orgId)
          .in("community_id", ids)
          .eq("status", "released")
          .gte("actual_start_date", isoDay(rateSince))
          .order("id")
          .range(from, to),
      { cap: FACT_SCAN_CAP, label: "Failed to load community portfolio" },
    ),
    readAllRows<{ community_id: string; scheduled_date: string | null }>(
      (from, to) =>
        context.supabase
          .from("closings")
          .select("community_id, status, scheduled_date")
          .eq("org_id", context.orgId)
          .in("community_id", ids)
          .neq("status", "cancelled")
          .gte("scheduled_date", isoDay(today))
          .lte("scheduled_date", isoDay(horizonEnd))
          .order("id")
          .range(from, to),
      { cap: FACT_SCAN_CAP, label: "Failed to load community portfolio" },
    ),
    readAllRows<{ id: string; community_id: string; name: string; scheduled_date: string | null; lot_count: number | null; price_per_lot_cents: number | null }>(
      (from, to) =>
        context.supabase
          .from("lot_takedowns")
          .select("id, community_id, name, scheduled_date, lot_count, price_per_lot_cents")
          .eq("org_id", context.orgId)
          .in("community_id", ids)
          .eq("status", "scheduled")
          // An overdue takedown is still owed: it lands at month 0, as the cash plan carries it.
          .lte("scheduled_date", isoDay(horizonEnd))
          .order("scheduled_date", { ascending: true })
          .order("id")
          .range(from, to),
      { cap: FACT_SCAN_CAP, label: "Failed to load community portfolio" },
    ),
    readAllRows<{ community_id: string }>(
      (from, to) =>
        context.supabase
          .from("start_packages")
          .select("community_id, status")
          .eq("org_id", context.orgId)
          .in("community_id", ids)
          .eq("status", "attention")
          .order("id")
          .range(from, to),
      { cap: FACT_SCAN_CAP, label: "Failed to load community portfolio" },
    ),
    // Only lots that carry a live home, read to exhaustion. Lot *counts* come
    // from the status aggregate on each community, so this read exists purely to
    // find the houses behind the aging and cutoff alerts — and a flat 5,000-row
    // cap across every community under-reported both on the biggest ones.
    readAllRows<{ id: string; community_id: string; status: LotStatus; project_id: string | null; project: { status?: string | null; completed_on?: string | null } | Array<{ status?: string | null; completed_on?: string | null }> | null }>(
      (from, to) =>
        context.supabase
          .from("lots")
          .select("id, community_id, status, project_id, project:projects(status, completed_on)")
          .eq("org_id", context.orgId)
          .in("community_id", ids)
          .not("project_id", "is", null)
          .neq("status", "closed")
          .order("id")
          .range(from, to),
      { cap: HOMED_LOT_SCAN_CAP, label: "Failed to load community portfolio" },
    ),
    canReadMargin
      ? getProductionPortfolioReport({ divisionId }, context.orgId).catch(() => null)
      : Promise.resolve(null),
  ])
  const entitlementPressure = await entitlementPressurePromise

  const reservedLotIds = new Set(liveReservations.rows.map((row) => row.lot_id as string))
  const startedProjectIds = new Set(
    lots.rows
      .filter((row) => row.project_id && row.status === "started" && !reservedLotIds.has(row.id))
      .map((row) => row.project_id)
      .filter((projectId): projectId is string => Boolean(projectId)),
  )

  // Selections are keyed by project; the lot rows above are the only bridge
  // back to a community, so the cutoff lookup rides that same project set.
  const projectCommunity = new Map<string, string>()
  for (const row of lots.rows) {
    if (row.project_id) projectCommunity.set(row.project_id, row.community_id)
  }
  // Chunked rather than truncated: a silently dropped tail would under-report
  // cutoffs on exactly the largest communities.
  const projectIds = [...projectCommunity.keys()]
  const startedProjectList = [...startedProjectIds]
  const [cutoffBatches, completionBatches] = await Promise.all([
    Promise.all(
    Array.from({ length: Math.ceil(projectIds.length / PROJECT_FILTER_BATCH) }, (_, index) =>
      readAllRows<{ project_id: string }>(
        (from, to) =>
          context.supabase
            .from("project_selections")
            .select("project_id, due_date, status")
            .eq("org_id", context.orgId)
            .in("project_id", projectIds.slice(index * PROJECT_FILTER_BATCH, (index + 1) * PROJECT_FILTER_BATCH))
            .not("due_date", "is", null)
            .lte("due_date", isoDay(cutoffWarning))
            .not("status", "in", "(confirmed,ordered,received)")
            .order("id")
            .range(from, to),
        { cap: FACT_SCAN_CAP, label: "Failed to load selection cutoffs" },
      ),
    )
    ),
    // The recorded completion date is the only clock a spec ages on: Books' date,
    // else the one sales recorded on the home (specCompletionDate), exactly as the
    // sales inventory ages it.
    Promise.all(
      Array.from({ length: Math.ceil(startedProjectList.length / PROJECT_FILTER_BATCH) }, (_, index) =>
        readAllRows<{ project_id: string; books_inventory_completed_on: string | null }>(
          (from, to) =>
            context.supabase
              .from("project_financial_settings")
              .select("project_id, books_inventory_completed_on")
              .eq("org_id", context.orgId)
              .in("project_id", startedProjectList.slice(index * PROJECT_FILTER_BATCH, (index + 1) * PROJECT_FILTER_BATCH))
              .not("books_inventory_completed_on", "is", null)
              .order("project_id")
              .range(from, to),
          { cap: FACT_SCAN_CAP, label: "Failed to load spec completion dates" },
        ),
      ),
    ),
  ])
  const cutoffRows = cutoffBatches.flatMap((batch) => batch.rows)
  const completedOnByProject = new Map(
    completionBatches.flatMap((batch) => batch.rows).map((row) => [row.project_id, row.books_inventory_completed_on] as const),
  )

  const months = Array.from({ length: RUNWAY_HORIZON_MONTHS }, (_, index) => {
    const month = new Date(today.getFullYear(), today.getMonth() + index, 1)
    return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`
  })
  const thisMonth = months[0]

  const countBy = <T,>(rows: T[], key: (row: T) => string | null | undefined) => {
    const map = new Map<string, number>()
    for (const row of rows) {
      const id = key(row)
      if (!id) continue
      map.set(id, (map.get(id) ?? 0) + 1)
    }
    return map
  }

  const convertedByCommunity = countBy(convertedReservations.rows, (row) => row.community_id as string)
  const cancelledByCommunity = countBy(cancelledReservations.rows, (row) => row.community_id as string)
  const startsByCommunity = countBy(releasedStarts.rows, (row) => row.community_id as string)
  const blockedByCommunity = countBy(blockedStarts.rows, (row) => row.community_id as string)
  const expiringByCommunity = countBy(
    liveReservations.rows.filter(
      (row) => row.status === "hold" && row.expires_at && new Date(row.expires_at as string) <= holdWarning,
    ),
    (row) => row.community_id as string,
  )
  const cutoffsByCommunity = countBy(cutoffRows, (row) => projectCommunity.get(row.project_id))

  const closingsByCommunityMonth = new Map<string, number>()
  for (const row of closings.rows) {
    if (!row.scheduled_date) continue
    const key = `${row.community_id as string}:${monthKey(row.scheduled_date as string)}`
    closingsByCommunityMonth.set(key, (closingsByCommunityMonth.get(key) ?? 0) + 1)
  }

  const agingByCommunity = new Map<string, number>()
  for (const row of lots.rows) {
    if (!row.project_id || !startedProjectIds.has(row.project_id)) continue
    const relation = row.project
    const project = Array.isArray(relation) ? relation[0] : relation
    const completedOn = specCompletionDate(completedOnByProject.get(row.project_id), project?.completed_on)
    const { completedAt, agingDays } = specInventoryAge(project, completedOn, today.getTime())
    if (!completedAt || agingDays < SPEC_AGING_ALERT_DAYS) continue
    agingByCommunity.set(row.community_id, (agingByCommunity.get(row.community_id) ?? 0) + 1)
  }

  // The deposits credited against these takedowns, so the board nets them out
  // exactly as the org cash forecast does.
  const credits = takedowns.rows.length
    ? await readAllRows<{ takedown_id: string; due_on: string; amount_cents: number; status: LandDepositStatus }>(
      (from, to) =>
        context.supabase
          .from("land_contract_deposits")
          .select("takedown_id, due_on, amount_cents, status")
          .eq("org_id", context.orgId)
          .in("takedown_id", takedowns.rows.map((row) => row.id))
          .order("id")
          .range(from, to),
      { cap: FACT_SCAN_CAP, label: "Failed to load community portfolio" },
    )
    : { rows: [], truncated: false }
  const deposits = credits.rows.map((row) => ({ takedownId: row.takedown_id, dueOn: row.due_on, amountCents: Number(row.amount_cents), status: row.status }))

  const takedownsByCommunity = new Map<string, CommunityTakedown[]>()
  for (const row of takedowns.rows) {
    const scheduledDate = row.scheduled_date as string | null
    if (!scheduledDate) continue
    const communityId = row.community_id as string
    const lotCount = Number(row.lot_count ?? 0)
    const list = takedownsByCommunity.get(communityId) ?? []
    const cash = takedownCash(
      { id: row.id, scheduledDate, lotCount, pricePerLotCents: row.price_per_lot_cents == null ? null : Number(row.price_per_lot_cents), status: "scheduled" },
      deposits,
    )
    list.push({
      id: row.id as string,
      name: row.name as string,
      scheduledDate,
      monthOffset: Math.max(0, (Date.parse(scheduledDate) - today.getTime()) / MS_PER_DAY / DAYS_PER_MONTH),
      lotCount,
      cashCents: cash.netCents,
      depositCents: cash.creditedDepositCents,
    })
    takedownsByCommunity.set(communityId, list)
  }

  const marginByCommunity = new Map(
    (marginReport?.communities ?? []).map((row) => [
      row.communityId,
      { marginPercent: row.projectedMarginPercent, targetMarginPercent: row.targetMarginPercent },
    ]),
  )

  const lanes: CommunityLane[] = communities.map((community) => {
    const totalLots = LOT_STATUSES.reduce((sum, lotStatus) => sum + community.lotCounts[lotStatus], 0)
    const sellableLots = SELLABLE_LOT_STATUSES.reduce((sum, lotStatus) => sum + community.lotCounts[lotStatus], 0)
    const salesLast90 = convertedByCommunity.get(community.id) ?? 0
    const cancelsLast90 = cancelledByCommunity.get(community.id) ?? 0
    const salesPacePerMonth = (salesLast90 - cancelsLast90) / (RATE_WINDOW_DAYS / 30)
    const startsLast90 = startsByCommunity.get(community.id) ?? 0
    const consumptionPerMonth = startsLast90 > 0 ? startsLast90 / (RATE_WINDOW_DAYS / 30) : null
    const communityTakedowns = takedownsByCommunity.get(community.id) ?? []
    const { runway, dryAtMonth } = buildRunway(
      sellableLots,
      consumptionPerMonth,
      communityTakedowns,
      RUNWAY_HORIZON_MONTHS,
    )

    const urgencies: CommunityUrgency[] = []
    const expiring = expiringByCommunity.get(community.id) ?? 0
    if (expiring > 0) {
      urgencies.push({
        kind: "holds_expiring",
        label: expiring === 1 ? "1 hold expiring" : `${expiring} holds expiring`,
        count: expiring,
        href: `/sales?community=${community.id}`,
        tone: "critical",
      })
    }
    const blocked = blockedByCommunity.get(community.id) ?? 0
    if (blocked > 0) {
      urgencies.push({
        kind: "starts_blocked",
        label: blocked === 1 ? "1 start blocked" : `${blocked} starts blocked`,
        count: blocked,
        href: `/starts?community=${community.id}`,
        tone: "critical",
      })
    }
    const dueCutoffs = cutoffsByCommunity.get(community.id) ?? 0
    if (dueCutoffs > 0) {
      urgencies.push({
        kind: "cutoffs_due",
        label: dueCutoffs === 1 ? "1 cutoff due" : `${dueCutoffs} cutoffs due`,
        count: dueCutoffs,
        href: `/design-studio?community=${community.id}`,
        tone: "warning",
      })
    }
    const aging = agingByCommunity.get(community.id) ?? 0
    if (aging > 0) {
      urgencies.push({
        kind: "specs_aging",
        label: `${aging} spec${aging === 1 ? "" : "s"} ${SPEC_AGING_ALERT_DAYS}d+`,
        count: aging,
        href: `/sales?community=${community.id}`,
        tone: "warning",
      })
    }
    // Entitlements hold delivery and starts: overdue is critical, merely unmet a warning.
    const entitlements = entitlementPressure.get(community.id)
    if (entitlements) {
      urgencies.push({
        kind: "entitlements_blocked",
        label: entitlements.overdue > 0
          ? `${entitlements.overdue} entitlement item${entitlements.overdue === 1 ? "" : "s"} overdue`
          : `${entitlements.open} entitlement item${entitlements.open === 1 ? "" : "s"} open`,
        count: entitlements.overdue > 0 ? entitlements.overdue : entitlements.open,
        href: `/communities/${community.id}/land#entitlements`,
        tone: entitlements.overdue > 0 ? "critical" : "warning",
      })
    }

    return {
      id: community.id,
      name: community.name,
      code: community.code,
      status: community.status,
      divisionName: community.divisionName,
      market: [community.city, community.state].filter(Boolean).join(", ") || null,
      lotCounts: community.lotCounts,
      totalLots,
      plannedLotCount: community.plannedLotCount,
      sellableLots,
      salesPacePerMonth,
      requiredPacePerMonth: community.targetAbsorptionPerMonth,
      paceState: paceStateFor(salesPacePerMonth, community.targetAbsorptionPerMonth),
      startsLast90,
      consumptionPerMonth,
      monthsOfSupply: consumptionPerMonth != null ? sellableLots / consumptionPerMonth : null,
      runway,
      dryAtMonth,
      verdict: runwayVerdict({
        status: community.status,
        sellableLots,
        deliveryCount: communityTakedowns.length,
        consumptionPerMonth,
        dryAtMonth,
      }),
      takedowns: communityTakedowns,
      salesLast90,
      cancelsLast90,
      closingsByMonth: months.map((month) => ({
        month,
        count: closingsByCommunityMonth.get(`${community.id}:${month}`) ?? 0,
      })),
      marginPercent: marginByCommunity.get(community.id)?.marginPercent ?? null,
      targetMarginPercent: marginByCommunity.get(community.id)?.targetMarginPercent ?? null,
      urgencies,
    }
  })

  return {
    horizonMonths: RUNWAY_HORIZON_MONTHS,
    lanes,
    truncated:
      lots.truncated ||
      cutoffBatches.some((batch) => batch.truncated) ||
      completionBatches.some((batch) => batch.truncated) ||
      [liveReservations, convertedReservations, cancelledReservations, releasedStarts, closings, takedowns, credits, blockedStarts].some(
        (fact) => fact.truncated,
      ),
    totals: {
      communities: lanes.length,
      totalLots: lanes.reduce((sum, lane) => sum + lane.totalLots, 0),
      sellableLots: lanes.reduce((sum, lane) => sum + lane.sellableLots, 0),
      closingsThisMonth: lanes.reduce(
        (sum, lane) => sum + (lane.closingsByMonth.find((entry) => entry.month === thisMonth)?.count ?? 0),
        0,
      ),
      behindPace: lanes.filter((lane) => lane.paceState === "behind").length,
      runningDry: lanes.filter((lane) => lane.verdict === "dry").length,
      takedownCashCents: lanes.reduce(
        (sum, lane) => sum + lane.takedowns.reduce((cash, takedown) => cash + takedown.cashCents, 0),
        0,
      ),
    },
  }
}

export interface LandSupplyRow {
  communityId: string
  communityName: string
  divisionName: string | null
  market: string | null
  status: CommunityListItemDTO["status"]
  sellableLots: number
  consumptionPerMonth: number | null
  monthsOfSupply: number | null
  dryAtMonth: number | null
  /** First of the month the community runs out, or null if it never does. */
  dryDate: string | null
  verdict: RunwayVerdict
  /** Lots already under contract inside the horizon, and what they cost. */
  scheduledLots: number
  scheduledCashCents: number
  /** Lots wanted and not owned, by calendar year — the buy list. */
  shortfallByYear: YearShortfall[]
  shortfallLots: number
}

export interface LandSupplyReport {
  asOf: string
  horizonMonths: number
  rows: LandSupplyRow[]
  totals: {
    communities: number
    sellableLots: number
    scheduledLots: number
    scheduledCashCents: number
    dryWithinHorizon: number
    shortfallLots: number
  }
  /** True when the portfolio read stopped short; the counts above are floors. */
  truncated: boolean
}

/**
 * Where a builder needs to buy dirt, and by when — every community on one page.
 *
 * The land runway has always existed per community; nothing aggregated it, so
 * answering "which markets am I short in for 2027" meant opening twelve
 * workbenches and adding up in your head. This runs the same projection the
 * board runs and turns each lane's curve into a year-by-year buy list.
 *
 * Read-only and derived: it mutates nothing and owns no fact of its own, so the
 * report can never disagree with the community it came from.
 */
export async function getLandSupplyReport(
  { divisionId, communityId }: { divisionId?: string; communityId?: string } = {},
  orgId?: string,
): Promise<LandSupplyReport> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  const portfolio = await getCommunityPortfolio({ divisionId, communityId }, context.orgId)
  const today = new Date()

  const rows: LandSupplyRow[] = portfolio.lanes.map((lane) => {
    const shortfallByYear = lotShortfallByYear({
      sellableLots: lane.sellableLots,
      consumptionPerMonth: lane.consumptionPerMonth,
      deliveries: lane.takedowns.map((takedown) => ({
        monthOffset: takedown.monthOffset,
        lotCount: takedown.lotCount,
      })),
      horizonMonths: portfolio.horizonMonths,
      startYear: today.getFullYear(),
      startMonth: today.getMonth(),
    })
    return {
      communityId: lane.id,
      communityName: lane.name,
      divisionName: lane.divisionName,
      market: lane.market,
      status: lane.status,
      sellableLots: lane.sellableLots,
      consumptionPerMonth: lane.consumptionPerMonth,
      monthsOfSupply: lane.monthsOfSupply,
      dryAtMonth: lane.dryAtMonth,
      dryDate: dryDateFrom(today, lane.dryAtMonth),
      verdict: lane.verdict,
      scheduledLots: lane.takedowns.reduce((sum, takedown) => sum + takedown.lotCount, 0),
      scheduledCashCents: lane.takedowns.reduce((sum, takedown) => sum + takedown.cashCents, 0),
      shortfallByYear,
      shortfallLots: shortfallByYear.reduce((sum, entry) => sum + entry.lotsNeeded, 0),
    }
  })
  rows.sort(compareSupplyUrgency)

  return {
    asOf: isoDay(today),
    horizonMonths: portfolio.horizonMonths,
    rows,
    totals: {
      communities: rows.length,
      sellableLots: rows.reduce((sum, row) => sum + row.sellableLots, 0),
      scheduledLots: rows.reduce((sum, row) => sum + row.scheduledLots, 0),
      scheduledCashCents: rows.reduce((sum, row) => sum + row.scheduledCashCents, 0),
      dryWithinHorizon: rows.filter((row) => row.dryAtMonth != null).length,
      shortfallLots: rows.reduce((sum, row) => sum + row.shortfallLots, 0),
    },
    truncated: portfolio.truncated,
  }
}

/**
 * One community's lane. The workbench header, its urgency strip, and the Land
 * tab's runway all read this, so the community page and the board it was opened
 * from state supply, pace, and margin identically.
 */
export const getCommunityLane = cache(async function getCommunityLane(
  communityId: string,
  orgId?: string,
): Promise<CommunityLane | null> {
  // Cached per request: the community layout and the tab inside it both want the
  // lane, and the runway projection behind it is not cheap enough to run twice.
  const portfolio = await getCommunityPortfolio({ communityId }, orgId)
  return portfolio.lanes[0] ?? null
})
