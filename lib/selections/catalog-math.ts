export function chooseResolvedPrice(input: {
  basePriceCents: number
  baseCostCents: number | null
  baseAvailable: boolean
  communityPrice?: { price_cents: number; cost_cents: number | null; is_available: boolean } | null
  planPrice?: { price_cents: number; cost_cents: number | null; is_available: boolean } | null
  isCommunityOption: boolean
}) {
  if (input.communityPrice) return { ...input.communityPrice, source: "plan_community" as const }
  if (input.planPrice) return { ...input.planPrice, source: "plan" as const }
  return {
    price_cents: input.basePriceCents,
    cost_cents: input.baseCostCents,
    is_available: input.baseAvailable,
    source: input.isCommunityOption ? ("option_community" as const) : ("option_base" as const),
  }
}

export function allocatePackageTotal(totalCents: number, memberCount: number) {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new Error("Package total must be a non-negative integer")
  if (!Number.isInteger(memberCount) || memberCount < 1) throw new Error("Package must contain at least one option")
  const base = Math.floor(totalCents / memberCount)
  const remainder = totalCents % memberCount
  return Array.from({ length: memberCount }, (_, index) => base + (index < remainder ? 1 : 0))
}
