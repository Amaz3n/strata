import { OfferingTab, type OfferingIncentive, type OfferingPlanRow } from "@/components/communities/offering-tab"
import { getCommunityPriceSheet } from "@/lib/services/community-sales"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export const dynamic = "force-dynamic"

export default async function CommunityOfferingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [sheet, permissions] = await Promise.all([getCommunityPriceSheet(id), getCurrentUserPermissions()])
  const canManage = permissions.permissions.some((permission) =>
    ["sales.manage", "org.admin", "*"].includes(permission),
  )

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
    basePriceCents: row.basePriceCents,
    fromPriceCents: row.fromPriceCents,
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

  return (
    <OfferingTab
      communityId={id}
      rows={rows}
      incentives={incentives}
      premiumRange={{ minCents: sheet.minPremiumCents, maxCents: sheet.maxPremiumCents }}
      asOfDate={sheet.asOfDate}
      canManage={canManage}
    />
  )
}
