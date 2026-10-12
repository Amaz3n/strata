type CatalogPriceRow = { price_cents: number; cost_cents: number | null; is_available: boolean }

/**
 * The price an option or package sells at on a home, and whether it is on sale.
 * A plan+community row outranks a plan row, which outranks the item's own
 * price. A price row only narrows availability: the item is on sale only while
 * every catalog row it stands on — the option and its community override, or
 * the package — is available and not archived, AND the chosen price row (if
 * any) is available. A published plan price never puts a withdrawn option back
 * on sale.
 */
export function chooseResolvedPrice(input: {
  basePriceCents: number
  baseCostCents: number | null
  subjects: ReadonlyArray<{ is_available: boolean; is_archived: boolean }>
  communityPrice?: CatalogPriceRow | null
  planPrice?: CatalogPriceRow | null
  isCommunityOption: boolean
}) {
  const subjectsOnSale = input.subjects.length > 0 && input.subjects.every((subject) => subject.is_available && !subject.is_archived)
  const row = input.communityPrice
    ? { ...input.communityPrice, source: "plan_community" as const }
    : input.planPrice
      ? { ...input.planPrice, source: "plan" as const }
      : null
  if (row) return { ...row, is_available: subjectsOnSale && row.is_available }
  return {
    price_cents: input.basePriceCents,
    cost_cents: input.baseCostCents,
    is_available: subjectsOnSale,
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
