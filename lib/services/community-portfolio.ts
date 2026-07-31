import "server-only"
import { cache } from "react"


import { LOT_STATUSES, type LotStatus } from "@/lib/land/lot-lifecycle"
import { buildRunway, runwayVerdict, type RunwayPoint, type RunwayVerdict } from "@/lib/land/runway"
import { listCommunities, type CommunityListItemDTO } from "@/lib/services/communities"
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

export type PaceState = "ahead" | "on" | "behind" | "unknown"

export interface CommunityUrgency {
  kind: "holds_expiring" | "starts_blocked" | "cutoffs_due" | "specs_aging"
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
  cashCents: number
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
  const canReadMargin = await hasPermission("report.read", context)

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
    context.supabase
      .from("lot_reservations")
      .select("community_id, lot_id, status, expires_at")
      .eq("org_id", context.orgId)
      .in("community_id", ids)
      .in("status", LIVE_RESERVATION_STATUSES)
      .limit(2_000),
    context.supabase
      .from("lot_reservations")
      .select("community_id, converted_at")
      .eq("org_id", context.orgId)
      .in("community_id", ids)
      .gte("converted_at", rateSince.toISOString())
      .limit(2_000),
    context.supabase
      .from("lot_reservations")
      .select("community_id, released_at, converted_at")
      .eq("org_id", context.orgId)
      .in("community_id", ids)
      .eq("status", "released")
      .not("converted_at", "is", null)
      .gte("released_at", rateSince.toISOString())
      .limit(2_000),
    context.supabase
      .from("start_packages")
      .select("community_id")
      .eq("org_id", context.orgId)
      .in("community_id", ids)
      .eq("status", "released")
      .gte("actual_start_date", isoDay(rateSince))
      .limit(2_000),
    context.supabase
      .from("closings")
      .select("community_id, status, scheduled_date")
      .eq("org_id", context.orgId)
      .in("community_id", ids)
      .neq("status", "cancelled")
      .gte("scheduled_date", isoDay(today))
      .lte("scheduled_date", isoDay(horizonEnd))
      .limit(2_000),
    context.supabase
      .from("lot_takedowns")
      .select("id, community_id, name, scheduled_date, lot_count, price_per_lot_cents, deposit_cents")
      .eq("org_id", context.orgId)
      .in("community_id", ids)
      .eq("status", "scheduled")
      .gte("scheduled_date", isoDay(today))
      .lte("scheduled_date", isoDay(horizonEnd))
      .order("scheduled_date", { ascending: true })
      .limit(500),
    context.supabase
      .from("start_packages")
      .select("community_id, status")
      .eq("org_id", context.orgId)
      .in("community_id", ids)
      .eq("status", "attention")
      .limit(1_000),
    context.supabase
      .from("lots")
      .select("id, community_id, status, project_id, project:projects(start_date)")
      .eq("org_id", context.orgId)
      .in("community_id", ids)
      .limit(5_000),
    canReadMargin
      ? getProductionPortfolioReport({ divisionId }, context.orgId).catch(() => null)
      : Promise.resolve(null),
  ])

  for (const result of [
    liveReservations,
    convertedReservations,
    cancelledReservations,
    releasedStarts,
    closings,
    takedowns,
    blockedStarts,
    lots,
  ]) {
    if (result.error) throw new Error(`Failed to load community portfolio: ${result.error.message}`)
  }

  const reservedLotIds = new Set((liveReservations.data ?? []).map((row) => row.lot_id as string))
  const startedProjectIds = new Set(
    (lots.data ?? [])
      .filter((row) => row.project_id && row.status === "started" && !reservedLotIds.has(row.id as string))
      .map((row) => row.project_id as string),
  )

  // Selections are keyed by project; the lot rows above are the only bridge
  // back to a community, so the cutoff lookup rides that same project set.
  const projectCommunity = new Map<string, string>()
  for (const row of lots.data ?? []) {
    if (row.project_id) projectCommunity.set(row.project_id as string, row.community_id as string)
  }
  // Chunked rather than truncated: a silently dropped tail would under-report
  // cutoffs on exactly the largest communities.
  const projectIds = [...projectCommunity.keys()]
  const cutoffBatches = await Promise.all(
    Array.from({ length: Math.ceil(projectIds.length / PROJECT_FILTER_BATCH) }, (_, index) =>
      context.supabase
        .from("project_selections")
        .select("project_id, due_date, status")
        .eq("org_id", context.orgId)
        .in("project_id", projectIds.slice(index * PROJECT_FILTER_BATCH, (index + 1) * PROJECT_FILTER_BATCH))
        .not("due_date", "is", null)
        .lte("due_date", isoDay(cutoffWarning))
        .not("status", "in", "(confirmed,ordered,received)")
        .limit(2_000),
    ),
  )
  const cutoffRows: Array<{ project_id: string }> = []
  for (const batch of cutoffBatches) {
    if (batch.error) throw new Error(`Failed to load selection cutoffs: ${batch.error.message}`)
    for (const row of batch.data ?? []) cutoffRows.push({ project_id: row.project_id as string })
  }

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

  const convertedByCommunity = countBy(convertedReservations.data ?? [], (row) => row.community_id as string)
  const cancelledByCommunity = countBy(cancelledReservations.data ?? [], (row) => row.community_id as string)
  const startsByCommunity = countBy(releasedStarts.data ?? [], (row) => row.community_id as string)
  const blockedByCommunity = countBy(blockedStarts.data ?? [], (row) => row.community_id as string)
  const expiringByCommunity = countBy(
    (liveReservations.data ?? []).filter(
      (row) => row.status === "hold" && row.expires_at && new Date(row.expires_at as string) <= holdWarning,
    ),
    (row) => row.community_id as string,
  )
  const cutoffsByCommunity = countBy(cutoffRows, (row) => projectCommunity.get(row.project_id))

  const closingsByCommunityMonth = new Map<string, number>()
  for (const row of closings.data ?? []) {
    if (!row.scheduled_date) continue
    const key = `${row.community_id as string}:${monthKey(row.scheduled_date as string)}`
    closingsByCommunityMonth.set(key, (closingsByCommunityMonth.get(key) ?? 0) + 1)
  }

  const agingByCommunity = new Map<string, number>()
  for (const row of lots.data ?? []) {
    if (!row.project_id || !startedProjectIds.has(row.project_id as string)) continue
    const relation = row.project as { start_date?: string | null } | Array<{ start_date?: string | null }> | null
    const startDate = (Array.isArray(relation) ? relation[0]?.start_date : relation?.start_date) ?? null
    if (!startDate) continue
    const agingDays = Math.floor((today.getTime() - Date.parse(startDate)) / MS_PER_DAY)
    if (agingDays < SPEC_AGING_ALERT_DAYS) continue
    const communityId = row.community_id as string
    agingByCommunity.set(communityId, (agingByCommunity.get(communityId) ?? 0) + 1)
  }

  const takedownsByCommunity = new Map<string, CommunityTakedown[]>()
  for (const row of takedowns.data ?? []) {
    const scheduledDate = row.scheduled_date as string | null
    if (!scheduledDate) continue
    const communityId = row.community_id as string
    const lotCount = Number(row.lot_count ?? 0)
    const list = takedownsByCommunity.get(communityId) ?? []
    list.push({
      id: row.id as string,
      name: row.name as string,
      scheduledDate,
      monthOffset: Math.max(0, (Date.parse(scheduledDate) - today.getTime()) / MS_PER_DAY / DAYS_PER_MONTH),
      lotCount,
      cashCents: lotCount * Number(row.price_per_lot_cents ?? 0),
      depositCents: Number(row.deposit_cents ?? 0),
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
