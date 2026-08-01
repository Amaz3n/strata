import { CommunitySpecInventory, type SpecRow } from "@/components/communities/community-spec-inventory"
import { CommunityTrafficPanel, weekOf, type TrafficWeek } from "@/components/communities/community-traffic-panel"
import { OfferingIncentives } from "@/components/communities/offering-incentives"
import { OfferingPriceSheet, type OfferingPlanRow } from "@/components/communities/offering-price-sheet"
import { OfferingSummary } from "@/components/communities/offering-summary"
import { getCommunityLane } from "@/lib/services/community-portfolio"
import { getCommunityOfferingCosts, getCommunityPriceSheet, listSpecInventory } from "@/lib/services/community-sales"
import { listCommunityTraffic } from "@/lib/services/community-traffic"
import { listPlansWithPublishedModels } from "@/lib/services/floorplan-models"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { grossMarginPct } from "@/lib/plans/margin"
import { isIncentiveLive, offeringPrice, type OfferingIncentive } from "@/lib/sales/offering"

export const dynamic = "force-dynamic"

/**
 * The lane's sales and cancellation counts are a trailing quarter, so the
 * traffic they are divided by has to be the same quarter. Reading eight weeks
 * of visits against ninety days of sales overstated conversion by roughly half.
 */
const TRAFFIC_WINDOW_DAYS = 90

/**
 * The offer this community is making, as one document: what it sells, for how
 * much, what is coming off that price, and what the market is doing with it.
 *
 * The price sheet and the incentives sit in one panel because they are one
 * decision — the give shows up as a net price on the row it changes, not as a
 * table somebody has to reconcile by hand. Demand and standing inventory sit
 * below because they are the evidence the decision is made against.
 */
export default async function CommunityOfferingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [sheet, permissions, traffic, specs, lane, costs] = await Promise.all([
    getCommunityPriceSheet(id),
    getCurrentUserPermissions(),
    listCommunityTraffic(id, { days: TRAFFIC_WINDOW_DAYS }).catch(() => []),
    listSpecInventory({ communityId: id, limit: 100 }).catch(() => []),
    getCommunityLane(id).catch(() => null),
    getCommunityOfferingCosts(id).catch(() => null),
  ])
  const canManage = permissions.permissions.some((permission) =>
    ["sales.manage", "org.admin", "*"].includes(permission),
  )
  const plansWith3d = await listPlansWithPublishedModels([
    ...new Set(sheet.rows.map((row) => row.planId)),
  ]).catch(() => new Set<string>())

  const rows: OfferingPlanRow[] = sheet.rows.map((row, index) => ({
    key: `${row.planId}:${row.elevationId ?? index}`,
    availabilityId: row.availabilityId,
    planId: row.planId,
    planCode: row.planCode ?? null,
    planName: row.planName ?? "—",
    elevationName: row.elevationName,
    beds: row.beds ?? null,
    baths: row.baths ?? null,
    sqft: row.sqft ?? null,
    stories: row.stories ?? null,
    garageBays: row.garageBays ?? null,
    basePriceCents: row.basePriceCents,
    repricedAt: row.repricedAt,
    previousBasePriceCents: row.previousBasePriceCents,
    soldCount: row.soldCount,
    buildingCount: row.buildingCount,
  }))

  const incentives: OfferingIncentive[] = sheet.incentives.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    incentiveType: row.incentive_type === "percent_of_base" ? "percent_of_base" : "fixed_amount",
    amountCents: row.amount_cents == null ? null : Number(row.amount_cents),
    percent: row.percent == null ? null : Number(row.percent),
    appliesTo: row.applies_to === "design_credit" ? "design_credit" : "price",
    status: String(row.status),
    effectiveStart: row.effective_start ?? null,
    effectiveEnd: row.effective_end ?? null,
    isOrgWide: row.community_id == null,
  }))
  // A promotion that starts next month is "active" but takes nothing off today's
  // price, so only the live ones ever reach the sheet's arithmetic.
  const liveIncentives = incentives.filter((incentive) => isIncentiveLive(incentive, sheet.asOfDate))

  const priced = rows.map((row) => ({ row, price: offeringPrice(row.basePriceCents, liveIncentives) }))
  const netPrices = priced.map((item) => item.price.netCents)
  const averageGiveCents = priced.length
    ? Math.round(priced.reduce((sum, item) => sum + item.price.giveCents, 0) / priced.length)
    : 0
  const averageBaseCents = rows.length
    ? Math.round(rows.reduce((sum, row) => sum + row.basePriceCents, 0) / rows.length)
    : 0
  const margins = costs
    ? rows
        .map((row) =>
          grossMarginPct({
            priceCents: row.basePriceCents,
            buildCostCents: costs.buildCostByPlanId[row.planId] ?? null,
            lotBasisCents: costs.lotBasisCents,
          }),
        )
        .filter((value): value is number => value != null)
    : []

  const byWeek = new Map<string, TrafficWeek>()
  for (const day of traffic) {
    const key = weekOf(day.loggedDate)
    const week = byWeek.get(key) ?? { weekOf: key, walkIns: 0, appointments: 0, webInquiries: 0 }
    week.walkIns += day.walkIns
    week.appointments += day.appointments
    week.webInquiries += day.webInquiries
    byWeek.set(key, week)
  }
  const weeks = [...byWeek.values()].sort((a, b) => b.weekOf.localeCompare(a.weekOf))

  const specRows: SpecRow[] = specs
    .filter((spec) => spec.isSpec)
    .map((spec) => ({
      lotId: spec.lotId,
      lotLabel: spec.lotLabel,
      projectId: spec.projectId,
      planLabel: spec.planLabel,
      beds: spec.beds,
      baths: spec.baths,
      sqft: spec.sqft,
      agingDays: spec.agingDays,
      askingPriceCents: spec.askingPriceCents,
    }))

  return (
    <div className="space-y-6 p-4">
      <div className="desk-rise border">
        <OfferingSummary
          planCount={new Set(rows.map((row) => row.planId)).size}
          libraryPlanCount={sheet.libraryPlanCount}
          fromCents={netPrices.length ? Math.min(...netPrices) + sheet.minPremiumCents : null}
          topCents={netPrices.length ? Math.max(...netPrices) + sheet.maxPremiumCents : null}
          minPremiumCents={sheet.minPremiumCents}
          maxPremiumCents={sheet.maxPremiumCents}
          averageGiveCents={averageGiveCents}
          givePercent={averageBaseCents > 0 ? (averageGiveCents / averageBaseCents) * 100 : null}
          designCreditCents={
            priced.length
              ? Math.round(priced.reduce((sum, item) => sum + item.price.designCreditCents, 0) / priced.length)
              : 0
          }
          thinnestMarginPercent={margins.length ? Math.min(...margins) : null}
          asOfDate={sheet.asOfDate}
        />
        <OfferingPriceSheet
          communityId={id}
          rows={rows}
          incentives={liveIncentives}
          minPremiumCents={sheet.minPremiumCents}
          asOfDate={sheet.asOfDate}
          lotBasisCents={costs?.lotBasisCents ?? null}
          buildCostByPlanId={costs?.buildCostByPlanId ?? {}}
          lotsTruncated={sheet.lotsTruncated}
          plansWith3d={plansWith3d}
          canManage={canManage}
        />
        <OfferingIncentives
          communityId={id}
          incentives={incentives}
          asOfDate={sheet.asOfDate}
          averageGiveCents={averageGiveCents}
          givePercent={averageBaseCents > 0 ? (averageGiveCents / averageBaseCents) * 100 : null}
          canManage={canManage}
        />
      </div>

      <div className="desk-rise grid gap-4 xl:grid-cols-2" style={{ "--desk-stagger": 1 } as React.CSSProperties}>
        <CommunityTrafficPanel
          communityId={id}
          weeks={weeks}
          recentDays={traffic}
          salesInWindow={lane?.salesLast90 ?? 0}
          cancelsInWindow={lane?.cancelsLast90 ?? 0}
          windowDays={TRAFFIC_WINDOW_DAYS}
          pacePerMonth={lane?.salesPacePerMonth ?? null}
          requiredPacePerMonth={lane?.requiredPacePerMonth ?? null}
          canManage={canManage}
        />
        <CommunitySpecInventory rows={specRows} />
      </div>
    </div>
  )
}
