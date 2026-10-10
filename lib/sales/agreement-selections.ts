export type StructuralOptionSource = { id: string; name: string; categoryId: string; costCents: number | null }

export type AgreementStructuralSelection = {
  optionId: string
  categoryId: string
  priceCents: number
  costCents: number | null
}

/**
 * The structural options a signed agreement commits the builder to build, as the
 * home's selections. Purchasing buys what the home's confirmed selections name,
 * so an option that lived only in the agreement snapshot was sold and never
 * bought. A home holds one selection per category, so two structural options in
 * one category cannot both be carried — that is refused, never silently dropped.
 */
export function agreementStructuralSelections(
  pricing: { structuralOptions: ReadonlyArray<{ optionId?: string; label: string; priceCents: number }> },
  options: readonly StructuralOptionSource[],
): AgreementStructuralSelection[] {
  const byId = new Map(options.map((option) => [option.id, option]))
  const seen = new Map<string, string>()
  return pricing.structuralOptions.map((item) => {
    const option = item.optionId ? byId.get(item.optionId) : undefined
    if (!option) throw new Error(`The structural option "${item.label}" could not be found in the catalog`)
    assertCategoryFree(seen, option)
    return { optionId: option.id, categoryId: option.categoryId, priceCents: item.priceCents, costCents: option.costCents }
  })
}

/** Refuses a configuration with two structural options in one selection category. */
export function assertOneStructuralOptionPerCategory(options: readonly Pick<StructuralOptionSource, "name" | "categoryId">[]) {
  const seen = new Map<string, string>()
  for (const option of options) assertCategoryFree(seen, option)
}

function assertCategoryFree(seen: Map<string, string>, option: Pick<StructuralOptionSource, "name" | "categoryId">) {
  const other = seen.get(option.categoryId)
  if (other !== undefined) {
    throw new Error(`"${other}" and "${option.name}" are structural options in the same category; a home carries one choice per category`)
  }
  seen.set(option.categoryId, option.name)
}
