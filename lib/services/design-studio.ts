import { requireOrgContext } from "@/lib/services/context"
import { readAllRows } from "@/lib/land/paging"
import { getDivisionScopedProjectIds } from "@/lib/services/authorization"
import { intersectProjectReadScopes } from "@/lib/services/authorization-policy"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { countAppointments, listAppointments, listCatalog, type AppointmentDto, type CatalogDto } from "@/lib/services/option-catalog"

/**
 * The Design Studio desk. Two surfaces sit on top of this file:
 *
 * - the runway, which plots every open selection group on time so the
 *   coordinator can see when the wave of cutoffs arrives rather than only
 *   which homes are already late, and
 * - the selection sheet, the screen a buyer actually sits in front of.
 *
 * Reads need `selections.read` only. The sidebar offers this desk to anyone
 * with that permission, so requiring `design_studio.manage` to render would
 * hard-fail the page for a superintendent checking a cutoff. Mutations keep
 * the stricter permission, on the actions that perform them.
 */

const DAY_MS = 86_400_000
const DEFAULT_HORIZON_DAYS = 84
const SOON_WINDOW_DAYS = 14
/** PostgREST puts `in()` filters in the URL, so long id lists go out in batches. */
const ID_BATCH = 200
/** A ceiling on one fact read, not a page size. Hitting it is an error, never a quiet undercount. */
const FACT_ROW_CAP = 100_000
/** Open cutoffs the runway plots. Past this the board says so instead of dropping the tail. */
const RUNWAY_INSTANCE_CAP = 5_000

type RangedRead<Row> = (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>

async function readComplete<Row>(label: string, read: RangedRead<Row>): Promise<Row[]> {
  const { rows, truncated } = await readAllRows<Row>(read, { cap: FACT_ROW_CAP, label: `Failed to load ${label}` })
  if (truncated) throw new Error(`Too many ${label} to read accurately; narrow the community or division and retry`)
  return rows
}

/** Reads one fact for a long id list: batched for URL length, each batch read to exhaustion. */
async function readForIds<Row>(
  label: string,
  ids: string[],
  read: (batch: string[], from: number, to: number) => ReturnType<RangedRead<Row>>,
): Promise<Row[]> {
  const batches = Array.from({ length: Math.ceil(ids.length / ID_BATCH) }, (_, index) => ids.slice(index * ID_BATCH, (index + 1) * ID_BATCH))
  return (await Promise.all(batches.map((batch) => readComplete<Row>(label, (from, to) => read(batch, from, to))))).flat()
}

export type CutoffState = "overdue" | "due_soon" | "scheduled" | "unresolved" | "locked"

export interface StudioHomeIdentity {
  projectId: string
  lotId: string | null
  lotLabel: string
  buyerName: string
  planName: string | null
  planVersionId: string | null
  communityId: string | null
  communityName: string | null
  basePriceCents: number | null
  lotPremiumCents: number
}

export interface RunwayHome {
  projectId: string
  lotLabel: string
  buyerName: string
  cutoffDate: string | null
  /** Negative once the cutoff has passed. Null when the schedule cannot resolve one. */
  daysToCutoff: number | null
  state: CutoffState
  chosenCount: number
  categoryCount: number
  appointmentAt: string | null
  blocksStart: boolean
  /** 0–1, how much of this group the buyer has decided. Drives the chip ring. */
  progress: number
}

export interface RunwayLane {
  groupId: string
  name: string
  cutoffRule: string
  homes: RunwayHome[]
}

export interface RunwayCounters {
  overdue: number
  dueSoon: number
  unbooked: number
  sessionsThisWeek: number
  readyToSign: number
}

export interface BlockedStart {
  projectId: string
  lotLabel: string
  buyerName: string
  /** Every open group on this home — the gate counts them all, not just one. */
  groupNames: string[]
  worstDaysOverdue: number | null
  targetWeek: string | null
}

export interface StudioRunway {
  horizonDays: number
  lanes: RunwayLane[]
  counters: RunwayCounters
  appointments: AppointmentDto[]
  blockedStarts: BlockedStart[]
  /** Set when more open cutoffs exist than the board plots; the board says so. */
  truncatedAt: number | null
}

interface StudioScope {
  /** Null means "every project in the org" — the caller must not filter. */
  projectIds: string[] | null
  empty: boolean
}

async function resolveStudioScope(
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  opts: { communityId?: string; divisionId?: string },
): Promise<StudioScope> {
  const membershipScope = await getDivisionScopedProjectIds(context)
  const { divisionId, communityId } = opts
  const [divisionRows, communityRows] = await Promise.all([
    divisionId
      ? readComplete<{ id: string }>("design studio scope", (from, to) =>
          context.supabase.from("projects").select("id").eq("org_id", context.orgId).eq("division_id", divisionId).order("id").range(from, to))
      : Promise.resolve(null),
    communityId
      ? readComplete<{ id: string; project_id: string | null }>("design studio scope", (from, to) =>
          context.supabase.from("lots").select("id, project_id").eq("org_id", context.orgId).eq("community_id", communityId).not("project_id", "is", null).order("id").range(from, to))
      : Promise.resolve(null),
  ])

  const divisionIds = divisionRows ? divisionRows.map((row) => row.id) : null
  const communityIds = communityRows
    ? Array.from(new Set(communityRows.map((row) => row.project_id).filter((value): value is string => Boolean(value))))
    : null
  const projectIds = intersectProjectReadScopes(intersectProjectReadScopes(membershipScope, divisionIds), communityIds)
  return { projectIds, empty: projectIds !== null && projectIds.length === 0 }
}

function lotLabelFor(row: { lot_number: string | null; block: string | null }): string {
  const block = row.block?.trim()
  if (block && row.lot_number) return `${block}-${row.lot_number}`
  return row.lot_number ?? "Lot"
}

/**
 * PostgREST types an embedded relation as `T | T[]` depending on how it infers
 * cardinality, so every read of one goes through here rather than a cast.
 */
type Embedded<T> = T | T[] | null | undefined

function relation<T>(value: Embedded<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

interface GroupRow {
  id: string
  name: string
  sort_order: number
}

interface RunwayInstanceRow {
  id: string
  project_id: string
  group_id: string
  cutoff_date: string | null
  cutoff_source: string
  status: string
  group: Embedded<CutoffGroupRow>
}

interface CutoffGroupRow extends GroupRow {
  schedule_task_key: string
  cutoff_offset_days: number
  cutoff_anchor: string
}

interface CategoryRow {
  id: string
  name: string
  description: string | null
  sort_order: number
}

interface IdentityLotRow {
  id: string
  project_id: string | null
  community_id: string | null
  lot_number: string | null
  block: string | null
  premium_cents: number | null
  asking_price_override_cents: number | null
  house_plan_id: string | null
  house_plan_version_id: string | null
}

interface IdentityReservationRow {
  lot_id: string
  asking_price_cents: number | null
  buyer: Embedded<{ full_name: string }>
  prospect: Embedded<{ name: string }>
}

interface IdentityContractRow {
  project_id: string
  total_cents: number | null
}

/**
 * Lot, plan, community and buyer for a set of projects, in a fixed number of
 * queries. The buyer is the reservation's contact where one exists, falling
 * back to the prospect's primary contact — the same precedence get_sales_deals
 * uses, resolved here because a coordinator does not hold `sales.read`.
 */
export async function loadHomeIdentities(
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  projectIds: string[],
): Promise<Map<string, StudioHomeIdentity>> {
  const identities = new Map<string, StudioHomeIdentity>()
  if (projectIds.length === 0) return identities

  const lotRows = await readForIds<IdentityLotRow>("lots for the design studio", projectIds, (batch, from, to) =>
    context.supabase
      .from("lots")
      .select("id, project_id, community_id, lot_number, block, premium_cents, asking_price_override_cents, house_plan_id, house_plan_version_id")
      .eq("org_id", context.orgId)
      .in("project_id", batch)
      .order("id")
      .range(from, to),
  )
  const planIds = Array.from(new Set(lotRows.map((row) => row.house_plan_id).filter((value): value is string => Boolean(value))))
  const communityIds = Array.from(new Set(lotRows.map((row) => row.community_id).filter((value): value is string => Boolean(value))))
  const lotIds = lotRows.map((row) => row.id)

  const [plansResult, communitiesResult, reservationRows, contractRows] = await Promise.all([
    planIds.length
      ? context.supabase.from("house_plans").select("id, name").eq("org_id", context.orgId).in("id", planIds)
      : Promise.resolve({ data: [], error: null }),
    communityIds.length
      ? context.supabase.from("communities").select("id, name").eq("org_id", context.orgId).in("id", communityIds)
      : Promise.resolve({ data: [], error: null }),
    readForIds<IdentityReservationRow>("buyers", lotIds, (batch, from, to) =>
      context.supabase
        .from("lot_reservations")
        .select("id, lot_id, asking_price_cents, buyer:contacts!lot_reservations_buyer_contact_id_fkey(full_name), prospect:prospects(name)")
        .eq("org_id", context.orgId)
        .in("lot_id", batch)
        .in("status", ["hold", "reserved", "converted"])
        .order("id")
        .range(from, to),
    ),
    readForIds<IdentityContractRow>("agreements", projectIds, (batch, from, to) =>
      context.supabase
        .from("contracts")
        .select("id, project_id, total_cents")
        .eq("org_id", context.orgId)
        .eq("contract_type", "purchase_agreement")
        .in("project_id", batch)
        .order("id")
        .range(from, to),
    ),
  ])
  if (plansResult.error) throw new Error(`Failed to load plans: ${plansResult.error.message}`)
  if (communitiesResult.error) throw new Error(`Failed to load communities: ${communitiesResult.error.message}`)

  const planById = new Map((plansResult.data ?? []).map((row) => [row.id as string, row.name as string]))
  const communityById = new Map((communitiesResult.data ?? []).map((row) => [row.id as string, row.name as string]))
  const reservationByLot = new Map(reservationRows.map((row) => [row.lot_id, row]))
  const contractByProject = new Map(contractRows.map((row) => [row.project_id, row]))

  for (const lot of lotRows) {
    const projectId = lot.project_id as string | null
    if (!projectId) continue
    const reservation = reservationByLot.get(lot.id as string)
    const buyer = relation<{ full_name: string }>(reservation?.buyer)
    const prospect = relation<{ name: string }>(reservation?.prospect)
    identities.set(projectId, {
      projectId,
      lotId: lot.id as string,
      lotLabel: lotLabelFor(lot),
      // A started home with no reservation is a spec, not a missing record.
      buyerName: buyer?.full_name ?? prospect?.name ?? "Spec",
      planName: lot.house_plan_id ? planById.get(lot.house_plan_id) ?? null : null,
      planVersionId: lot.house_plan_version_id,
      communityId: lot.community_id,
      communityName: lot.community_id ? communityById.get(lot.community_id) ?? null : null,
      basePriceCents:
        contractByProject.get(projectId)?.total_cents ??
        reservation?.asking_price_cents ??
        lot.asking_price_override_cents ??
        null,
      lotPremiumCents: lot.premium_cents ?? 0,
    })
  }
  return identities
}

function cutoffStateFor(input: { cutoffDate: string | null; status: string; today: string; daysToCutoff: number | null }): CutoffState {
  if (input.status === "locked") return "locked"
  if (!input.cutoffDate) return "unresolved"
  if (input.cutoffDate < input.today) return "overdue"
  if (input.daysToCutoff !== null && input.daysToCutoff <= SOON_WINDOW_DAYS) return "due_soon"
  return "scheduled"
}

function describeCutoffRule(group: { cutoff_offset_days: number; cutoff_anchor: string; schedule_task_key: string }): string {
  const days = Math.abs(group.cutoff_offset_days)
  const direction = group.cutoff_offset_days <= 0 ? "before" : "after"
  const anchor = group.cutoff_anchor === "end" ? "end" : "start"
  return `${days}d ${direction} ${group.schedule_task_key} ${anchor}`
}

function startOfWeekIso(now: Date): { from: string; to: string } {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - start.getDay())
  const end = new Date(start.getTime() + 7 * DAY_MS)
  return { from: start.toISOString(), to: end.toISOString() }
}

/**
 * Every open selection group inside the horizon, laned by group and positioned
 * by cutoff date. Overdue groups are always included regardless of how far
 * back they run — a cutoff missed two months ago is the most urgent thing on
 * the desk, not the least.
 */
export async function getStudioRunway(
  opts: { communityId?: string; divisionId?: string; horizonDays?: number; refused?: boolean } = {},
): Promise<StudioRunway> {
  const context = await requireOrgContext()
  await requirePermission("selections.read", context)
  const horizonDays = opts.horizonDays ?? DEFAULT_HORIZON_DAYS
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const horizonDate = new Date(now.getTime() + horizonDays * DAY_MS).toISOString().slice(0, 10)

  const emptyRunway: StudioRunway = {
    horizonDays,
    lanes: [],
    counters: { overdue: 0, dueSoon: 0, unbooked: 0, sessionsThisWeek: 0, readyToSign: 0 },
    appointments: [],
    blockedStarts: [],
    truncatedAt: null,
  }
  // A community the caller may not pin is an empty desk, never a widened one.
  if (opts.refused) return emptyRunway
  const scope = await resolveStudioScope(context, opts)
  if (scope.empty) return emptyRunway

  const scopeBatches: Array<string[] | null> = scope.projectIds
    ? Array.from({ length: Math.ceil(scope.projectIds.length / ID_BATCH) }, (_, index) => scope.projectIds?.slice(index * ID_BATCH, (index + 1) * ID_BATCH) ?? [])
    : [null]
  const instanceReads = await Promise.all(
    scopeBatches.map((batch) =>
      readAllRows<RunwayInstanceRow>(
        (from, to) => {
          let query = context.supabase
            .from("project_selection_groups")
            .select("id, project_id, group_id, cutoff_date, cutoff_source, status, group:selection_groups(id, name, sort_order, schedule_task_key, cutoff_offset_days, cutoff_anchor)")
            .eq("org_id", context.orgId)
            .eq("status", "open")
            .or(`cutoff_date.is.null,cutoff_date.lte.${horizonDate}`)
          if (batch) query = query.in("project_id", batch)
          return query.order("id").range(from, to)
        },
        { cap: RUNWAY_INSTANCE_CAP, label: "Failed to load selection cutoffs" },
      ),
    ),
  )
  const instances = instanceReads.flatMap((read) => read.rows)
  const truncatedAt = instanceReads.some((read) => read.truncated) ? RUNWAY_INSTANCE_CAP : null
  if (!instances.length) {
    const week = startOfWeekIso(now)
    const [appointments, sessionsThisWeek] = await Promise.all([
      listAppointments({ communityId: opts.communityId, divisionId: opts.divisionId, from: week.from, to: week.to, limit: 50 }),
      countAppointments({ communityId: opts.communityId, divisionId: opts.divisionId, from: week.from, to: week.to }),
    ])
    return { ...emptyRunway, appointments, counters: { ...emptyRunway.counters, sessionsThisWeek } }
  }

  const projectIds = Array.from(new Set(instances.map((row) => row.project_id as string)))
  const week = startOfWeekIso(now)

  const [selectionRows, appointments, sessionsThisWeek, upcoming, startRows, identities] = await Promise.all([
    readForIds<{ id: string; project_id: string; group_id: string; selected_option_id: string | null }>("selections", projectIds, (batch, from, to) =>
      context.supabase
        .from("project_selections")
        .select("id, project_id, group_id, selected_option_id, status")
        .eq("org_id", context.orgId)
        .in("project_id", batch)
        .order("id")
        .range(from, to),
    ),
    listAppointments({ communityId: opts.communityId, divisionId: opts.divisionId, from: week.from, to: week.to, limit: 50 }),
    countAppointments({ communityId: opts.communityId, divisionId: opts.divisionId, from: week.from, to: week.to }),
    listAppointments({ communityId: opts.communityId, divisionId: opts.divisionId, from: now.toISOString(), status: "scheduled", limit: 100 }),
    readForIds<{ id: string; project_id: string; target_week: string | null }>("start packages", projectIds, (batch, from, to) =>
      context.supabase
        .from("start_packages")
        .select("id, project_id, status, target_week")
        .eq("org_id", context.orgId)
        .in("project_id", batch)
        .is("released_at", null)
        .order("id")
        .range(from, to),
    ),
    loadHomeIdentities(context, projectIds),
  ])

  const tally = new Map<string, { chosen: number; total: number }>()
  for (const row of selectionRows) {
    const key = `${row.project_id}:${row.group_id}`
    const entry = tally.get(key) ?? { chosen: 0, total: 0 }
    entry.total += 1
    if (row.selected_option_id) entry.chosen += 1
    tally.set(key, entry)
  }
  const nextAppointmentByProject = new Map<string, string>()
  for (const appointment of upcoming) {
    if (!nextAppointmentByProject.has(appointment.project_id)) {
      nextAppointmentByProject.set(appointment.project_id, appointment.scheduled_at)
    }
  }
  const pendingStartByProject = new Map(
    startRows.map((row) => [row.project_id, row.target_week]),
  )

  const laneById = new Map<string, RunwayLane & { sortOrder: number }>()
  const counters: RunwayCounters = { overdue: 0, dueSoon: 0, unbooked: 0, sessionsThisWeek, readyToSign: 0 }
  const blockedByProject = new Map<string, BlockedStart>()

  for (const instance of instances) {
    const group = relation<CutoffGroupRow>(instance.group)
    if (!group) continue
    const identity = identities.get(instance.project_id as string)
    const counts = tally.get(`${instance.project_id}:${instance.group_id}`) ?? { chosen: 0, total: 0 }
    if (counts.total === 0) continue

    const cutoffDate = instance.cutoff_date as string | null
    const daysToCutoff = cutoffDate ? Math.round((Date.parse(`${cutoffDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS) : null
    const state = cutoffStateFor({ cutoffDate, status: instance.status as string, today, daysToCutoff })
    const appointmentAt = nextAppointmentByProject.get(instance.project_id as string) ?? null
    // Mirrors the `selections_locked` start gate exactly: it counts open groups,
    // not late ones, so a home with an unresolved cutoff is still blocking.
    const blocksStart = pendingStartByProject.has(instance.project_id as string)

    if (state === "overdue") counters.overdue += 1
    if (state === "due_soon") counters.dueSoon += 1
    if (!appointmentAt && (state === "overdue" || state === "due_soon")) counters.unbooked += 1
    if (counts.total > 0 && counts.chosen === counts.total) counters.readyToSign += 1

    const lane = laneById.get(group.id) ?? {
      groupId: group.id,
      name: group.name,
      cutoffRule: describeCutoffRule(group),
      homes: [],
      sortOrder: group.sort_order ?? 0,
    }
    lane.homes.push({
      projectId: instance.project_id as string,
      lotLabel: identity?.lotLabel ?? "Lot",
      buyerName: identity?.buyerName ?? "Unsold",
      cutoffDate,
      daysToCutoff,
      state,
      chosenCount: counts.chosen,
      categoryCount: counts.total,
      appointmentAt,
      blocksStart,
      progress: counts.total === 0 ? 0 : counts.chosen / counts.total,
    })
    laneById.set(group.id, lane)

    if (blocksStart) {
      const projectId = instance.project_id as string
      const existing = blockedByProject.get(projectId)
      const overdueDays = daysToCutoff !== null && daysToCutoff < 0 ? Math.abs(daysToCutoff) : null
      if (existing) {
        existing.groupNames.push(group.name)
        existing.worstDaysOverdue = Math.max(existing.worstDaysOverdue ?? 0, overdueDays ?? 0) || null
      } else {
        blockedByProject.set(projectId, {
          projectId,
          lotLabel: identity?.lotLabel ?? "Lot",
          buyerName: identity?.buyerName ?? "Spec",
          groupNames: [group.name],
          worstDaysOverdue: overdueDays,
          targetWeek: pendingStartByProject.get(projectId) ?? null,
        })
      }
    }
  }

  const lanes = Array.from(laneById.values())
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(({ sortOrder: _sortOrder, ...lane }) => ({
      ...lane,
      homes: lane.homes.sort((a, b) => (a.cutoffDate ?? "9999-12-31").localeCompare(b.cutoffDate ?? "9999-12-31")),
    }))

  return {
    horizonDays,
    lanes,
    counters,
    appointments,
    blockedStarts: Array.from(blockedByProject.values())
      .sort((a, b) => (b.worstDaysOverdue ?? 0) - (a.worstDaysOverdue ?? 0))
      .slice(0, 12),
    truncatedAt,
  }
}

export interface SheetOption {
  id: string
  name: string
  description: string | null
  priceCents: number
  costCents: number | null
  isStandard: boolean
  isAvailable: boolean
  imageUrl: string | null
  sku: string | null
  vendor: string | null
  leadTimeDays: number | null
  scope: "structural" | "design_studio"
}

export interface SheetCategory {
  id: string
  name: string
  description: string | null
  selectionId: string
  selectedOptionId: string | null
  status: string
  priceCentsSnapshot: number | null
  options: SheetOption[]
}

export interface SheetPackage {
  id: string
  name: string
  description: string | null
  priceCents: number
  optionIds: string[]
  swatches: string[]
  categoryCount: number
}

export interface SheetGroup {
  groupId: string
  name: string
  cutoffDate: string | null
  cutoffSource: "schedule" | "manual_override"
  overrideReason: string | null
  status: "open" | "locked"
  daysToCutoff: number | null
  state: CutoffState
  categories: SheetCategory[]
  packages: SheetPackage[]
  chosenCount: number
  subtotalCents: number
}

export interface SheetTally {
  basePriceCents: number | null
  lotPremiumCents: number
  optionTotalCents: number
  contractPriceCents: number | null
  byGroup: Array<{ groupId: string; name: string; subtotalCents: number; locked: boolean }>
}

export interface SelectionSheet {
  home: StudioHomeIdentity
  groups: SheetGroup[]
  tally: SheetTally
  canReadMargin: boolean
  canManage: boolean
  /** The community's fee for changing a selection after its cutoff. */
  changeFeeCents: number
  canWaiveChangeFee: boolean
  appointment: AppointmentDto | null
}

const DEFAULT_CHANGE_FEE_CENTS = 25_000

function swatchesFor(catalog: CatalogDto, optionIds: string[]): string[] {
  const byId = new Map(catalog.categories.flatMap((category) => category.options.map((option) => [option.id, option] as const)))
  return optionIds
    .map((id) => byId.get(id)?.image_url)
    .filter((value): value is string => Boolean(value))
    .slice(0, 4)
}

/**
 * Everything the appointment screen renders for one home: the buyer's identity,
 * each selection group with its categories and the options they may choose
 * from, and the running money. Cost and vendor are stripped unless the caller
 * holds the margin permission, so a buyer reading over a shoulder never sees
 * them even if the coordinator forgets the buyer-view toggle.
 */
export async function getSelectionSheet(projectId: string): Promise<SelectionSheet | null> {
  const context = await requireOrgContext()
  await requirePermission("selections.read", context)
  const [canReadMargin, canManage, canWaiveChangeFee] = await Promise.all([
    hasPermission("financials.margin.read", context),
    hasPermission("selections.write", context),
    hasPermission("selections.cutoff.override", context),
  ])

  const identities = await loadHomeIdentities(context, [projectId])
  const home = identities.get(projectId)
  if (!home) return null

  const today = new Date().toISOString().slice(0, 10)
  const [instancesResult, selectionsResult, catalog, appointments, communityResult] = await Promise.all([
    context.supabase
      .from("project_selection_groups")
      .select("group_id, cutoff_date, cutoff_source, override_reason, status, group:selection_groups(id, name, sort_order)")
      .eq("org_id", context.orgId)
      .eq("project_id", projectId)
      .limit(100),
    context.supabase
      .from("project_selections")
      .select("id, category_id, group_id, selected_option_id, status, price_cents_snapshot, category:selection_categories(id, name, description, sort_order)")
      .eq("org_id", context.orgId)
      .eq("project_id", projectId)
      .limit(500),
    listCatalog({ communityId: home.communityId ?? undefined }),
    listAppointments({ from: new Date().toISOString(), status: "scheduled", limit: 100 }),
    home.communityId
      ? context.supabase
          .from("communities")
          .select("selection_change_fee_cents")
          .eq("org_id", context.orgId)
          .eq("id", home.communityId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (instancesResult.error) throw new Error(`Failed to load selection groups: ${instancesResult.error.message}`)
  if (selectionsResult.error) throw new Error(`Failed to load selections: ${selectionsResult.error.message}`)
  if (communityResult.error) throw new Error(`Failed to load the change fee: ${communityResult.error.message}`)

  const optionsByCategory = new Map(catalog.categories.map((category) => [category.id, category.options]))
  const selectionRows = selectionsResult.data ?? []

  const groups: SheetGroup[] = []
  for (const instance of instancesResult.data ?? []) {
    const group = relation<GroupRow>(instance.group)
    if (!group) continue
    const members = selectionRows
      .filter((row) => row.group_id === instance.group_id)
      .sort((a, b) => (relation<CategoryRow>(a.category)?.sort_order ?? 0) - (relation<CategoryRow>(b.category)?.sort_order ?? 0))
    if (members.length === 0) continue

    const categories: SheetCategory[] = members.map((row) => {
      const category = relation<CategoryRow>(row.category)
      const options = (optionsByCategory.get(row.category_id as string) ?? [])
        .filter((option) => !option.is_archived)
        .map<SheetOption>((option) => ({
          id: option.id,
          name: option.name,
          description: option.description,
          priceCents: option.price_cents ?? 0,
          costCents: canReadMargin ? option.cost_cents ?? null : null,
          isStandard: (option.price_cents ?? 0) === 0,
          isAvailable: option.is_available,
          imageUrl: option.image_url,
          sku: option.sku,
          vendor: canReadMargin ? option.vendor : null,
          leadTimeDays: option.lead_time_days,
          scope: option.option_scope,
        }))
      return {
        id: row.category_id as string,
        name: category?.name ?? "Selection",
        description: category?.description ?? null,
        selectionId: row.id as string,
        selectedOptionId: row.selected_option_id as string | null,
        status: row.status as string,
        priceCentsSnapshot: row.price_cents_snapshot as number | null,
        options,
      }
    })

    const categoryIds = new Set(categories.map((category) => category.id))
    const packages: SheetPackage[] = catalog.packages
      .filter((item) => !item.is_archived && item.is_available)
      .map((item) => {
        const covered = item.option_ids.filter((optionId) =>
          catalog.categories.some((category) => categoryIds.has(category.id) && category.options.some((option) => option.id === optionId)),
        )
        return {
          id: item.id,
          name: item.name,
          description: item.description,
          priceCents: item.price_cents,
          optionIds: item.option_ids,
          swatches: swatchesFor(catalog, item.option_ids),
          categoryCount: covered.length,
        }
      })
      .filter((item) => item.categoryCount > 0)

    const cutoffDate = instance.cutoff_date as string | null
    const daysToCutoff = cutoffDate ? Math.round((Date.parse(`${cutoffDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS) : null
    groups.push({
      groupId: instance.group_id as string,
      name: group.name,
      cutoffDate,
      cutoffSource: instance.cutoff_source === "manual_override" ? "manual_override" : "schedule",
      overrideReason: instance.override_reason as string | null,
      status: instance.status === "locked" ? "locked" : "open",
      daysToCutoff,
      state: cutoffStateFor({ cutoffDate, status: instance.status as string, today, daysToCutoff }),
      categories,
      packages,
      chosenCount: categories.filter((category) => category.selectedOptionId).length,
      subtotalCents: categories.reduce((total, category) => total + (category.priceCentsSnapshot ?? 0), 0),
    })
  }

  groups.sort((a, b) => (a.cutoffDate ?? "9999-12-31").localeCompare(b.cutoffDate ?? "9999-12-31"))

  const optionTotalCents = groups.reduce((total, group) => total + group.subtotalCents, 0)
  const tally: SheetTally = {
    basePriceCents: home.basePriceCents,
    lotPremiumCents: home.lotPremiumCents,
    optionTotalCents,
    contractPriceCents: home.basePriceCents === null ? null : home.basePriceCents + home.lotPremiumCents + optionTotalCents,
    byGroup: groups.map((group) => ({
      groupId: group.groupId,
      name: group.name,
      subtotalCents: group.subtotalCents,
      locked: group.status === "locked",
    })),
  }

  return {
    home,
    groups,
    tally,
    canReadMargin,
    canManage,
    changeFeeCents: communityResult.data?.selection_change_fee_cents ?? DEFAULT_CHANGE_FEE_CENTS,
    canWaiveChangeFee,
    appointment: appointments.find((item) => item.project_id === projectId) ?? null,
  }
}

export interface BookableHome {
  projectId: string
  label: string
  communityId: string | null
}

/** Homes the booking picker shows at once; typing a lot number reaches the rest. */
const BOOKABLE_HOME_LIMIT = 25
const BOOKABLE_SCAN_PAGE = 200

/**
 * Homes a coordinator can actually book: under contract, carrying at least one
 * open selection group. Searched on the server by lot number and bounded —
 * `truncated` means more homes match than the picker shows.
 */
export async function listBookableHomes(
  opts: { communityId?: string; divisionId?: string; search?: string } = {},
): Promise<{ homes: BookableHome[]; truncated: boolean }> {
  const none = { homes: [], truncated: false }
  const context = await requireOrgContext()
  await requirePermission("selections.read", context)
  const scope = await resolveStudioScope(context, opts)
  if (scope.empty) return none

  let candidateIds = scope.projectIds
  const term = opts.search?.trim().replace(/[\\%_,()]/g, "")
  if (term) {
    const { communityId } = opts
    const matches = await readComplete<{ id: string; project_id: string | null }>("lots", (from, to) => {
      let lotQuery = context.supabase.from("lots").select("id, project_id").eq("org_id", context.orgId).not("project_id", "is", null).ilike("lot_number", `%${term}%`)
      if (communityId) lotQuery = lotQuery.eq("community_id", communityId)
      return lotQuery.order("id").range(from, to)
    })
    candidateIds = intersectProjectReadScopes(
      candidateIds,
      Array.from(new Set(matches.map((row) => row.project_id).filter((value): value is string => Boolean(value)))),
    )
    if (candidateIds?.length === 0) return none
  }

  const batches: Array<string[] | null> = candidateIds
    ? Array.from({ length: Math.ceil(candidateIds.length / ID_BATCH) }, (_, index) => candidateIds?.slice(index * ID_BATCH, (index + 1) * ID_BATCH) ?? [])
    : [null]
  const found = new Set<string>()
  // Page through open groups only until one more than the picker shows has been
  // seen: that extra home is what proves the list was cut short.
  scan: for (const batch of batches) {
    for (let from = 0; ; from += BOOKABLE_SCAN_PAGE) {
      let query = context.supabase
        .from("project_selection_groups")
        .select("id, project_id")
        .eq("org_id", context.orgId)
        .eq("status", "open")
      if (batch) query = query.in("project_id", batch)
      const { data, error } = await query.order("project_id").order("id").range(from, from + BOOKABLE_SCAN_PAGE - 1)
      if (error) throw new Error(`Failed to load bookable homes: ${error.message}`)
      for (const row of data ?? []) {
        found.add(row.project_id as string)
        if (found.size > BOOKABLE_HOME_LIMIT) break scan
      }
      if ((data ?? []).length < BOOKABLE_SCAN_PAGE) break
    }
  }

  const projectIds = Array.from(found)
  const truncated = projectIds.length > BOOKABLE_HOME_LIMIT
  const identities = await loadHomeIdentities(context, projectIds.slice(0, BOOKABLE_HOME_LIMIT))
  const homes = Array.from(identities.values())
    .map((home) => ({
      projectId: home.projectId,
      label: `${home.lotLabel} · ${home.buyerName}${home.planName ? ` · ${home.planName}` : ""}`,
      communityId: home.communityId,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return { homes, truncated }
}
