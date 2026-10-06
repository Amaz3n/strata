export type AgreementCatalogChoice = {
  optionId?: string
  packageId?: string
  label: string
  category: string | null
}

export function agreementChoiceKey(choice: { optionId?: string; packageId?: string }): string {
  return choice.optionId ? `option:${choice.optionId}` : choice.packageId ? `package:${choice.packageId}` : ""
}

function searchable(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()
}

export function indexAgreementCatalog<Item extends AgreementCatalogChoice>(items: Item[]) {
  return items.map(item => ({ item, key: agreementChoiceKey(item), search: searchable(`${item.label} ${item.category ?? ""}`) }))
}

export function pageAgreementCatalog<Item extends AgreementCatalogChoice>(
  index: ReturnType<typeof indexAgreementCatalog<Item>>,
  selected: Set<string>,
  { query, selectedOnly, page, pageSize = 40 }: { query: string; selectedOnly: boolean; page: number; pageSize?: number },
) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("Catalog page size must be between 1 and 100")
  const terms = searchable(query).split(/\s+/).filter(Boolean)
  let selectedCount = 0
  const matches = index.filter(entry => {
    const picked = selected.has(entry.key)
    if (picked) selectedCount++
    return (!selectedOnly || picked) && terms.every(term => entry.search.includes(term))
  })
  const pages = Math.max(1, Math.ceil(matches.length / pageSize))
  const currentPage = Math.min(Number.isSafeInteger(page) && page >= 0 ? page : 0, pages - 1)
  const offset = currentPage * pageSize
  return {
    items: matches.slice(offset, offset + pageSize).map(entry => entry.item),
    selectedCount,
    matchesCount: matches.length,
    page: currentPage,
    pages,
    start: matches.length ? offset + 1 : 0,
    end: Math.min(offset + pageSize, matches.length),
  }
}
