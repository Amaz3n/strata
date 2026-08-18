import "server-only"

import { LOT_STATUSES, UNPHASED_KEY, type LotStatus } from "@/lib/land/lot-lifecycle"
import {
  inventoryFilterClauses,
  inventoryWindow,
  isTruncated,
  orderColumns,
  type InventoryFilters,
} from "@/lib/land/inventory-query"
import { readAllRows } from "@/lib/land/paging"
import { getCommunity } from "@/lib/services/communities"
import { requireOrgContext } from "@/lib/services/context"
import { mapDimensions, type LotDimensions } from "@/lib/services/lots"
import { requirePermission } from "@/lib/services/permissions"

/** A hold or reservation still standing against a lot. */
export interface InventoryBuyerDTO {
  reservationId: string
  status: string
  prospectId: string | null
  name: string | null
  expiresAt: string | null
  contractId: string | null
  askingPriceCents: number | null
}

export interface InventoryClosingDTO {
  status: string
  scheduledDate: string | null
  actualDate: string | null
}

export interface InventoryLotDTO {
  id: string
  lotNumber: string
  block: string | null
  address: string | null
  status: LotStatus
  phaseId: string | null
  phaseName: string | null
  takedownId: string | null
  takedownName: string | null
  dimensions: LotDimensions
  swing: "left" | "right" | "either"
  premiumCents: number
  costBasisCents: number | null
  askingPriceOverrideCents: number | null
  acquiredDate: string | null
  notes: string | null
  planId: string | null
  planName: string | null
  elevationName: string | null
  projectId: string | null
  projectName: string | null
  platX: number | null
  platY: number | null
  /** Read-only here. Holds and agreements are mutated on the Sales desk. */
  buyer: InventoryBuyerDTO | null
  /** Read-only here. Closings are mutated by the closing coordinator. */
  closing: InventoryClosingDTO | null
}

/**
 * Filter, sort, and page composition lives in `lib/land/inventory-query.ts` so
 * the three reads of this inventory cannot drift apart, and so the arithmetic
 * behind them is testable without a database. Margin is deliberately not a
 * sortable column: it is computed from the P&L rather than stored on the lot, so
 * it is ordered by the page that already holds both halves.
 */
export { INVENTORY_SORTS, isInventorySort, type InventorySort } from "@/lib/land/inventory-query"

export interface CommunityInventoryFilters extends InventoryFilters {
  status?: LotStatus
}

export interface CommunityInventoryPage {
  lots: InventoryLotDTO[]
  total: number
  page: number
  pageSize: number
  truncated: boolean
}

/**
 * The plat draws every lot at once, so the map view asks for one page this
 * size. Past it the map stops being readable anyway and the table is the
 * honest surface.
 */
export const INVENTORY_MAP_PAGE_SIZE = 600
export const INVENTORY_TABLE_PAGE_SIZE = 100

/**
 * A ceiling on the phase cross-tab read, not a page size. Ten times the largest
 * community anyone has platted, so it exists to stop a runaway rather than to
 * trim a real community — and when it does stop one, the tab says so.
 */
const PHASE_COUNT_SCAN_CAP = 20_000

/** One literal: PostgREST derives the row type from the select string itself. */
const LOT_SELECT =
  "id, lot_number, block, address, status, community_phase_id, takedown_id, dimensions, swing, premium_cents, cost_basis_cents, asking_price_override_cents, acquired_date, notes, house_plan_id, house_plan_elevation_id, project_id, plat_x, plat_y, phase:community_phases(name), takedown:lot_takedowns(name), project:projects(name), plan:house_plans(name, code), elevation:house_plan_elevations(name)"

/** A live hold or reservation; anything else has already left the lot. */
const LIVE_RESERVATION_STATUSES = ["hold", "reserved"]

function relation<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null
  return Array.isArray(value) ? value[0] ?? null : value
}

function emptyStatusCounts(): Record<LotStatus, number> {
  return Object.fromEntries(LOT_STATUSES.map((status) => [status, 0])) as Record<LotStatus, number>
}

/**
 * The status mix behind the filter chips. Counted with every filter *except*
 * status applied, so the chips keep showing what else is there once one is
 * picked rather than collapsing to the one you chose.
 *
 * One exact `COUNT` per status rather than a capped row read tallied here: the
 * old shape read up to 5,000 lot rows and added them up in JS, so past the cap
 * the chips reported numbers that were not merely low but wrong, on exactly the
 * communities big enough to need them.
 */
export async function countCommunityLotsByStatus(
  communityId: string,
  filters: Omit<CommunityInventoryFilters, "status" | "page" | "pageSize" | "sort" | "direction"> = {},
  orgId?: string,
): Promise<Record<LotStatus, number>> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  const clauses = inventoryFilterClauses(filters)
  const results = await Promise.all(
    LOT_STATUSES.map((status) => {
      let query = context.supabase
        .from("lots")
        .select("id", { count: "exact", head: true })
        .eq("org_id", context.orgId)
        .eq("community_id", communityId)
        .eq("status", status)
      for (const clause of clauses) {
        query = clause.kind === "eq" ? query.eq(clause.column, clause.value) : query.or(clause.filter)
      }
      return query
    }),
  )
  const counts = emptyStatusCounts()
  results.forEach((result, index) => {
    if (result.error) throw new Error(`Failed to count the inventory: ${result.error.message}`)
    counts[LOT_STATUSES[index]] = result.count ?? 0
  })
  return counts
}

export interface PhaseLotCounts {
  byPhase: Record<string, Record<LotStatus, number>>
  /** True when the read stopped before the community ran out of lots. */
  truncated: boolean
}

/**
 * The status mix inside each phase. A phase list of names and target dates
 * answers none of the land manager's questions — "how much is left in Phase 2
 * and when does it dry up" needs the lots that are in it.
 *
 * This is the one count here that still reads rows: it is a phase-by-status
 * cross-tab, which PostgREST cannot aggregate, and the alternative is a `COUNT`
 * per cell — six per phase. So it reads two narrow columns and pages to the end
 * of the community rather than stopping at an arbitrary row cap, and says so if
 * a ceiling ever stops it first.
 */
export async function countLotsByPhase(communityId: string, orgId?: string): Promise<PhaseLotCounts> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  const { rows, truncated } = await readAllRows<{ community_phase_id: string | null; status: LotStatus }>(
    (from, to) =>
      context.supabase
        .from("lots")
        .select("community_phase_id, status")
        .eq("org_id", context.orgId)
        .eq("community_id", communityId)
        .order("id")
        .range(from, to),
    { cap: PHASE_COUNT_SCAN_CAP, label: "Failed to count the phases" },
  )
  const byPhase: Record<string, Record<LotStatus, number>> = {}
  for (const row of rows) {
    const key = row.community_phase_id ?? UNPHASED_KEY
    const counts = (byPhase[key] ??= emptyStatusCounts())
    if (row.status in counts) counts[row.status] += 1
  }
  return { byPhase, truncated }
}

/** A bulk patch carries its ids in the request, so a select-all is capped where the patch is. */
export const BULK_SELECTION_CAP = 500

/**
 * Every lot id matching the current filters, so "select all 340 matching" is a
 * real selection rather than the hundred rows that happen to be on screen.
 */
export async function listCommunityInventoryLotIds(
  communityId: string,
  filters: Omit<CommunityInventoryFilters, "page" | "pageSize"> = {},
  orgId?: string,
): Promise<{ ids: string[]; total: number; capped: boolean }> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  let query = context.supabase
    .from("lots")
    .select("id", { count: "exact" })
    .eq("org_id", context.orgId)
    .eq("community_id", communityId)
    .range(0, BULK_SELECTION_CAP - 1)
  for (const clause of inventoryFilterClauses(filters)) {
    query = clause.kind === "eq" ? query.eq(clause.column, clause.value) : query.or(clause.filter)
  }
  for (const column of orderColumns(filters)) {
    query = query.order(column.name, { ascending: column.ascending, nullsFirst: column.ascending })
  }
  const { data, error, count } = await query
  if (error) throw new Error(`Failed to select the lots: ${error.message}`)
  const ids = (data ?? []).map((row) => row.id as string)
  const total = count ?? ids.length
  return { ids, total, capped: total > ids.length }
}

/**
 * One community's lots with everything a production builder reads about them:
 * land state, product, buyer, and the home. Filtering and paging happen in
 * Postgres — the plat used to filter on the client, which silently stranded
 * every lot past the row cap.
 *
 * Buyer and closing are joined for display only. They are owned by the Sales
 * desk and the closing coordinator; nothing here writes them.
 */
export async function listCommunityInventory(
  communityId: string,
  filters: CommunityInventoryFilters = {},
  orgId?: string,
): Promise<CommunityInventoryPage> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  await getCommunity(communityId, context.orgId)

  const { page, pageSize, from, to } = inventoryWindow(filters, {
    defaultPageSize: INVENTORY_TABLE_PAGE_SIZE,
    maxPageSize: INVENTORY_MAP_PAGE_SIZE,
  })

  let query = context.supabase
    .from("lots")
    .select(LOT_SELECT, { count: "exact" })
    .eq("org_id", context.orgId)
    .eq("community_id", communityId)
    .range(from, to)

  for (const clause of inventoryFilterClauses(filters)) {
    query = clause.kind === "eq" ? query.eq(clause.column, clause.value) : query.or(clause.filter)
  }
  for (const column of orderColumns(filters)) {
    query = query.order(column.name, { ascending: column.ascending, nullsFirst: column.ascending })
  }

  const { data, error, count } = await query
  if (error) throw new Error(`Failed to load the inventory: ${error.message}`)

  const rows = data ?? []
  const lotIds = rows.map((row) => row.id as string)

  // Buyer and closing ride the page, not the community, so a 400-lot community
  // never pulls its whole sales history to render 100 rows.
  const [reservations, closings] = await Promise.all([
    lotIds.length > 0
      ? context.supabase
          .from("lot_reservations")
          .select("id, lot_id, status, expires_at, contract_id, asking_price_cents, prospect_id, prospect:prospects(name)")
          .eq("org_id", context.orgId)
          .in("lot_id", lotIds)
          .in("status", LIVE_RESERVATION_STATUSES)
          .limit(INVENTORY_MAP_PAGE_SIZE)
      : Promise.resolve({ data: [], error: null }),
    lotIds.length > 0
      ? context.supabase
          .from("closings")
          .select("lot_id, status, scheduled_date, actual_date")
          .eq("org_id", context.orgId)
          .in("lot_id", lotIds)
          .neq("status", "cancelled")
          .limit(INVENTORY_MAP_PAGE_SIZE)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (reservations.error) throw new Error(`Failed to load lot holds: ${reservations.error.message}`)
  if (closings.error) throw new Error(`Failed to load lot closings: ${closings.error.message}`)

  const buyerByLot = new Map<string, InventoryBuyerDTO>()
  for (const row of reservations.data ?? []) {
    buyerByLot.set(row.lot_id as string, {
      reservationId: row.id as string,
      status: row.status as string,
      prospectId: (row.prospect_id as string | null) ?? null,
      name: relation(row.prospect as { name?: string | null } | Array<{ name?: string | null }> | null)?.name ?? null,
      expiresAt: (row.expires_at as string | null) ?? null,
      contractId: (row.contract_id as string | null) ?? null,
      askingPriceCents: row.asking_price_cents == null ? null : Number(row.asking_price_cents),
    })
  }

  const closingByLot = new Map<string, InventoryClosingDTO>()
  for (const row of closings.data ?? []) {
    closingByLot.set(row.lot_id as string, {
      status: row.status as string,
      scheduledDate: (row.scheduled_date as string | null) ?? null,
      actualDate: (row.actual_date as string | null) ?? null,
    })
  }

  const lots: InventoryLotDTO[] = rows.map((row) => {
    const plan = relation(row.plan as { name?: string | null; code?: string | null } | null)
    return {
      id: row.id as string,
      lotNumber: row.lot_number as string,
      block: (row.block as string | null) ?? null,
      address: (row.address as string | null) ?? null,
      status: row.status as LotStatus,
      phaseId: (row.community_phase_id as string | null) ?? null,
      phaseName: relation(row.phase as { name?: string | null } | null)?.name ?? null,
      takedownId: (row.takedown_id as string | null) ?? null,
      takedownName: relation(row.takedown as { name?: string | null } | null)?.name ?? null,
      // Stored snake_case alongside imported address parts, so it goes through
      // the same mapper every other lot read uses.
      dimensions: mapDimensions(row.dimensions as Record<string, unknown> | null),
      swing: (row.swing as InventoryLotDTO["swing"] | null) ?? "either",
      premiumCents: Number(row.premium_cents ?? 0),
      costBasisCents: row.cost_basis_cents == null ? null : Number(row.cost_basis_cents),
      askingPriceOverrideCents:
        row.asking_price_override_cents == null ? null : Number(row.asking_price_override_cents),
      acquiredDate: (row.acquired_date as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      planId: (row.house_plan_id as string | null) ?? null,
      planName: plan ? [plan.code, plan.name].filter(Boolean).join(" · ") || null : null,
      elevationName: relation(row.elevation as { name?: string | null } | null)?.name ?? null,
      projectId: (row.project_id as string | null) ?? null,
      projectName: relation(row.project as { name?: string | null } | null)?.name ?? null,
      platX: row.plat_x == null ? null : Number(row.plat_x),
      platY: row.plat_y == null ? null : Number(row.plat_y),
      buyer: buyerByLot.get(row.id as string) ?? null,
      closing: closingByLot.get(row.id as string) ?? null,
    }
  })

  const total = count ?? lots.length
  return { lots, total, page, pageSize, truncated: isTruncated({ total, from, returned: lots.length }) }
}
