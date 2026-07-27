import { LOT_STATUSES, type LotStatus } from "@/lib/land/lot-lifecycle"
import { grossMarginPct } from "@/lib/plans/margin"
import type {
  CommunityPlanAvailabilityDto,
  HousePlanDto,
  PlanLotUsageDto,
  PlanPricingDto,
} from "@/lib/services/house-plans"
import type { CommunityListItemDTO } from "@/lib/services/communities"

/**
 * Where a plan sells and how it is doing there, one row per community. Offering
 * and footprint used to be two sections asking the same question at opposite ends
 * of the page; they are one axis, so they are one calculation.
 */

export type OfferingElevationCell = {
  elevationId: string | null
  code: string
  offered: boolean
  priceCents: number
}

export type OfferingRow = {
  communityId: string
  communityName: string
  offered: boolean
  cells: OfferingElevationCell[]
  /** Lowest live price in this community — the one margin is judged on. */
  priceCents: number | null
  priceMaxCents: number | null
  buildCents: number | null
  lotBasisCents: number | null
  marginPct: number | null
  lotCounts: Array<{ status: LotStatus; count: number }>
  lotTotal: number
}

/** Costs come from the released edition when one exists — that is what is being built. */
function costVersionId(plan: HousePlanDto, versionId: string | null, pricing: PlanPricingDto): string | null {
  const released = (plan.versions ?? []).find((item) => item.status === "released")
  if (released && pricing.community_costs.some((entry) => entry.version_id === released.id)) return released.id
  if (versionId && pricing.community_costs.some((entry) => entry.version_id === versionId)) return versionId
  return null
}

export function buildOfferingRows({
  plan,
  versionId,
  communities,
  availability,
  pricing,
  lots,
}: {
  plan: HousePlanDto
  versionId: string | null
  communities: CommunityListItemDTO[]
  availability: CommunityPlanAvailabilityDto[]
  pricing: PlanPricingDto
  lots: PlanLotUsageDto[]
}): OfferingRow[] {
  const elevations = (plan.elevations ?? []).filter((elevation) => elevation.is_active)
  const columns: Array<{ id: string | null; code: string }> = [
    { id: null, code: "Base" },
    ...elevations.map((elevation) => ({ id: elevation.id, code: elevation.code })),
  ]
  const costVersion = costVersionId(plan, versionId, pricing)

  const lotsByCommunity = new Map<string, PlanLotUsageDto[]>()
  for (const lot of lots) {
    const group = lotsByCommunity.get(lot.community_id) ?? []
    group.push(lot)
    lotsByCommunity.set(lot.community_id, group)
  }

  const relevant = communities.filter(
    (community) =>
      availability.some((row) => row.community_id === community.id && row.is_available) ||
      lotsByCommunity.has(community.id),
  )

  return relevant
    .map((community) => {
      const cells = columns.map((column) => {
        const row = availability.find(
          (entry) => entry.community_id === community.id && entry.elevation_id === column.id,
        )
        return {
          elevationId: column.id,
          code: column.code,
          offered: Boolean(row?.is_available),
          priceCents: row?.base_price_cents ?? 0,
        }
      })
      const livePrices = cells.filter((cell) => cell.offered && cell.priceCents > 0).map((cell) => cell.priceCents)
      const priceCents = livePrices.length > 0 ? Math.min(...livePrices) : null
      const cheapest = cells.find((cell) => cell.offered && cell.priceCents === priceCents) ?? null

      const buildCents =
        costVersion == null
          ? null
          : pricing.community_costs.find(
              (entry) =>
                entry.version_id === costVersion &&
                entry.community_id === community.id &&
                entry.elevation_id === (cheapest?.elevationId ?? null),
            )?.cost_cents ?? null
      const lotBasisCents =
        pricing.community_lot_basis.find((entry) => entry.community_id === community.id)?.lot_basis_cents ?? null

      const communityLots = lotsByCommunity.get(community.id) ?? []
      const counts = new Map<LotStatus, number>()
      for (const lot of communityLots) counts.set(lot.status, (counts.get(lot.status) ?? 0) + 1)

      return {
        communityId: community.id,
        communityName: community.name,
        offered: cells.some((cell) => cell.offered),
        cells,
        priceCents,
        priceMaxCents: livePrices.length > 0 ? Math.max(...livePrices) : null,
        buildCents,
        lotBasisCents,
        marginPct: grossMarginPct({ priceCents, buildCostCents: buildCents, lotBasisCents }),
        lotCounts: LOT_STATUSES.filter((status) => counts.has(status)).map((status) => ({
          status,
          count: counts.get(status) ?? 0,
        })),
        lotTotal: communityLots.length,
      }
    })
    .sort((left, right) => right.lotTotal - left.lotTotal || left.communityName.localeCompare(right.communityName))
}

/** The margin a plan is actually judged on: its weakest live community. */
export function worstMargin(rows: OfferingRow[]): { pct: number; communityName: string } | null {
  const scored = rows.filter((row) => row.offered && row.marginPct != null)
  if (scored.length === 0) return null
  const worst = scored.reduce((low, row) => ((row.marginPct as number) < (low.marginPct as number) ? row : low))
  return { pct: worst.marginPct as number, communityName: worst.communityName }
}
