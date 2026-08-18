/**
 * What "the current inventory filters" mean, decided once.
 *
 * The community inventory is read three ways — the page on screen, the status
 * counts behind the filter chips, and the id list a select-all bulk edit acts
 * on. Three readings of one filter set that could drift are three chances to
 * update lots the user never saw, so the filter, the ordering, and the page
 * arithmetic are defined here and applied by the service.
 *
 * Pure — no data access, no Supabase types — because this is the part that is
 * worth being sure about, and it is the part a database makes hard to test.
 */

export const INVENTORY_SORTS = ["lot", "address", "status", "price", "premium"] as const
export type InventorySort = (typeof INVENTORY_SORTS)[number]

export function isInventorySort(value: string | undefined | null): value is InventorySort {
  return value != null && (INVENTORY_SORTS as readonly string[]).includes(value)
}

export interface InventoryFilters {
  status?: string
  phaseId?: string
  /** Matches lot number, block, or address — the lot's own columns. */
  search?: string
  sort?: InventorySort
  direction?: "asc" | "desc"
  page?: number
  pageSize?: number
}

/**
 * Applied to a query builder by the service. Returned as clauses rather than
 * applied here because the three call sites select different columns, and
 * threading their builder types through a generic helper blows the inference
 * budget.
 */
export type LotFilterClause =
  | { kind: "eq"; column: string; value: string }
  | { kind: "or"; filter: string }

/** PostgREST puts `or` patterns in the URL, so the term is bounded and escaped. */
export function searchPattern(term: string) {
  return term.replace(/[(),*]/g, " ").trim().slice(0, 60)
}

export function inventoryFilterClauses(filters: InventoryFilters): LotFilterClause[] {
  const clauses: LotFilterClause[] = []
  if (filters.status) clauses.push({ kind: "eq", column: "status", value: filters.status })
  if (filters.phaseId) clauses.push({ kind: "eq", column: "community_phase_id", value: filters.phaseId })
  const term = filters.search ? searchPattern(filters.search) : ""
  if (term) {
    clauses.push({ kind: "or", filter: `lot_number.ilike.%${term}%,block.ilike.%${term}%,address.ilike.%${term}%` })
  }
  return clauses
}

const SORT_COLUMNS: Record<InventorySort, string[]> = {
  lot: ["block", "lot_number"],
  address: ["address"],
  status: ["status", "block", "lot_number"],
  price: ["asking_price_override_cents"],
  premium: ["premium_cents"],
}

export function orderColumns(filters: InventoryFilters) {
  const ascending = filters.direction !== "desc"
  return SORT_COLUMNS[filters.sort ?? "lot"].map((name) => ({ name, ascending }))
}

export interface InventoryWindow {
  page: number
  pageSize: number
  from: number
  to: number
}

/**
 * The page a request actually gets. A page number or size arriving off a query
 * string is user input, so it is clamped rather than trusted: page 0 and a
 * 10,000-row page size are both a URL away.
 */
export function inventoryWindow(
  filters: InventoryFilters,
  { defaultPageSize, maxPageSize }: { defaultPageSize: number; maxPageSize: number },
): InventoryWindow {
  const pageSize = Math.min(Math.max(filters.pageSize ?? defaultPageSize, 1), maxPageSize)
  const page = Math.max(Math.floor(filters.page ?? 1), 1)
  const from = (page - 1) * pageSize
  return { page, pageSize, from, to: from + pageSize - 1 }
}

/** True when rows exist past the page just read — the signal the table shows. */
export function isTruncated({ total, from, returned }: { total: number; from: number; returned: number }) {
  return total > from + returned
}
