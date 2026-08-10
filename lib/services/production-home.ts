import "server-only"

import { getDivisionScopedProjectIds, getDivisionAccessForUser } from "@/lib/services/authorization"
import { getBacklogReport, listClosings } from "@/lib/services/closings"
import { requireOrgContext } from "@/lib/services/context"
import { getStudioRunway } from "@/lib/services/design-studio"
import { listMyHouses, listMyHouseWork, type MyHouseDTO, type MyHouseTaskGroupDTO } from "@/lib/services/my-houses"
import { hasPermission } from "@/lib/services/permissions"
import { listStartPackages } from "@/lib/services/starts"

const STALLED_DAYS = 7

export type FieldWindow = "today" | "week" | "twoweek"

export interface NowExceptionDTO {
  id: string
  label: string
  detail: string
  href: string
  tone: "warning" | "danger"
}

export interface NextItemDTO {
  id: string
  date: string
  type: string
  label: string
  href: string
}

/**
 * Home is a glimpse, so it carries three things and no more: what you are
 * accountable for (tiles), what needs you now, and what is coming.
 *
 * `now` is a union rather than one merged list because the shape of "act on
 * this" genuinely differs by role — a superintendent works one activity across
 * many lots, an office role works a ranked queue of blocked things. Same pane,
 * different renderer.
 *
 * Anything the viewer is not accountable for is `null`, never zeroed, so the
 * surface can tell "not yours" apart from "empty".
 */
export type ProductionHomeData = {
  hasCommunities: boolean
  /** Present when the viewer carries houses. Drives the personal tile + its roster sheet. */
  assigned: {
    houseCount: number
    lateCount: number
    missingLogCount: number
    houses: MyHouseDTO[]
  } | null
  stats: {
    starts: { released: number; target: number } | null
    closings: { scheduled: number; cleared: number; valueCents: number } | null
    construction: { underConstruction: number; averageCycleDays: number | null } | null
    purchasing: { vpoWeekCents: number; percentDirectCost: number } | null
    backlog: { units: number; valueCents: number; specUnits: number } | null
  }
  now:
    | { kind: "activities"; window: FieldWindow; groups: MyHouseTaskGroupDTO[]; truncated: boolean }
    | { kind: "blocked"; items: NowExceptionDTO[] }
  next: NextItemDTO[]
}

/** Home is a glimpse. Past this many rows a pane stops being scannable. */
const PANE_CAP = 5
const WORK_GROUP_CAP = 3

/**
 * Ranked by what actually stops a production line, not by which query returned
 * them. A closing slipping costs the most and is the least recoverable, so it
 * leads; a VPO awaiting a signature can wait a day.
 */
const EXCEPTION_RANK = {
  closing: 0,
  startGate: 1,
  selection: 2,
  stalled: 3,
  vpo: 4,
} as const

export async function getProductionHomeData(
  filters: { divisionId?: string; communityId?: string; window?: FieldWindow } = {},
  orgId?: string,
): Promise<ProductionHomeData> {
  const context = await requireOrgContext(orgId)
  const access = await getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId })
  if (filters.divisionId && access.assignedOnly && !access.divisionIds.includes(filters.divisionId)) {
    throw new Error("Division access denied")
  }
  const window = filters.window ?? "week"

  // Two different questions. The `can*` keys decide which queries run at all —
  // data access. The `owns*` keys decide which tiles appear: Home shows what you
  // are accountable for changing, not everything you happen to be able to read.
  // That is what keeps a superintendent from being handed the VP's backlog.
  const [canStarts, canSales, canPurchasing, canSelections, canCommunity,
    ownsStarts, ownsClosings, ownsPurchasing, ownsReporting] = await Promise.all([
    hasPermission("start.read", context),
    hasPermission("sales.read", context),
    hasPermission("price_book.read", context),
    hasPermission("selections.read", context),
    hasPermission("community.read", context),
    hasPermission("start.release", context),
    hasPermission("closing.manage", context),
    hasPermission("price_book.write", context),
    hasPermission("report.read", context),
  ])

  const authorizedIds = await getDivisionScopedProjectIds(context)
  const today = new Date()
  const todayIso = today.toISOString().slice(0, 10)
  const monthStart = `${todayIso.slice(0, 7)}-01`
  const monthEndDate = new Date(today.getFullYear(), today.getMonth() + 1, 0)
  const monthEnd = monthEndDate.toISOString().slice(0, 10)
  const weekEndDate = new Date(today)
  weekEndDate.setDate(weekEndDate.getDate() + 7)
  const weekEnd = weekEndDate.toISOString().slice(0, 10)
  const twoWeekDate = new Date(today)
  twoWeekDate.setDate(twoWeekDate.getDate() + 14)
  const twoWeek = twoWeekDate.toISOString().slice(0, 10)
  const monday = new Date(today)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const mondayIso = monday.toISOString().slice(0, 10)

  const [communitiesResult, closingsPage, backlog, packages, runway] = await Promise.all([
    scopedCommunityQuery(context, filters, "id", { count: "exact", head: true }, access.assignedOnly ? access.divisionIds : null),
    canSales
      ? listClosings({ divisionId: filters.divisionId, communityId: filters.communityId, from: monthStart, to: monthEnd, limit: 500 }, context.orgId).catch(() => ({ closings: [], total: 0 }))
      : Promise.resolve({ closings: [] as any[], total: 0 }),
    canSales ? getBacklogReport({ divisionId: filters.divisionId }, context.orgId).catch(() => []) : Promise.resolve([]),
    canStarts
      ? listStartPackages({ divisionId: filters.divisionId, communityId: filters.communityId, status: ["open", "ready", "attention"], pageSize: 100 }, context.orgId).catch(() => ({ packages: [], total: 0 }))
      : Promise.resolve({ packages: [] as any[], total: 0 }),
    canSelections ? getStudioRunway({ communityId: filters.communityId, divisionId: filters.divisionId }).catch(() => null) : Promise.resolve(null),
  ])
  const overdueSelections = (runway?.lanes ?? [])
    .flatMap((lane) => lane.homes.filter((home) => home.state === "overdue").map((home) => ({ lane, home })))
    .sort((a, b) => (a.home.daysToCutoff ?? 0) - (b.home.daysToCutoff ?? 0))

  const scopedProjectIds = await resolveScopedProjectIds(context, filters, authorizedIds)
  const scopedCommunityIds = await resolveScopedCommunityIds(
    context,
    filters,
    access.assignedOnly ? access.divisionIds : null,
  )
  const [{ data: statRollup, error: statError }, { data: vpos }, { data: stalled }, { data: takedowns }, { data: selectionDates }, { data: openClosingItems }, assigned, workGroups] = await Promise.all([
    context.supabase.rpc("production_home_stat_rollup", {
      p_org_id: context.orgId,
      p_project_ids: scopedProjectIds,
      p_community_ids: scopedCommunityIds,
      p_week_start: mondayIso,
      p_month_start: monthStart,
      p_month_end: monthEnd,
    }),
    canPurchasing && scopedProjectIds.length
      ? context.supabase.from("commitment_change_orders").select("id,project_id,title,total_cents,status,project:projects(name)").eq("org_id", context.orgId).in("project_id", scopedProjectIds).not("reason_code_id", "is", null).gte("created_at", `${mondayIso}T00:00:00Z`).in("status", ["draft", "sent", "approved", "executed"]).limit(250)
      : Promise.resolve({ data: [] as any[] }),
    scopedProjectIds.length
      ? context.supabase.from("schedule_items").select("project_id,updated_at,project:projects(name)").eq("org_id", context.orgId).in("project_id", scopedProjectIds).neq("status", "completed").order("updated_at", { ascending: true }).limit(500)
      : Promise.resolve({ data: [] as any[] }),
    canCommunity
      ? scopedCommunityQuery(context, filters, "id,name,lot_takedowns(id,name,scheduled_date,status)", undefined, access.assignedOnly ? access.divisionIds : null).gte("lot_takedowns.scheduled_date", todayIso).lte("lot_takedowns.scheduled_date", twoWeek).limit(100)
      : Promise.resolve({ data: [] as any[] }),
    canSelections && scopedProjectIds.length
      ? context.supabase.from("project_selection_groups").select("id,project_id,cutoff_date,group:selection_groups(name),project:projects(name)").eq("org_id", context.orgId).in("project_id", scopedProjectIds).eq("status", "open").gte("cutoff_date", todayIso).lte("cutoff_date", twoWeek).order("cutoff_date").limit(50)
      : Promise.resolve({ data: [] as any[] }),
    canSales && scopedProjectIds.length
      ? context.supabase.from("closing_checklist_items").select("id,closing_id,closing:closings!inner(project_id,scheduled_date,project:projects(name))").eq("org_id", context.orgId).eq("status", "open").gte("closing.scheduled_date", todayIso).lte("closing.scheduled_date", weekEnd).in("closing.project_id", scopedProjectIds).limit(100)
      : Promise.resolve({ data: [] as any[] }),
    loadAssignedHouses(context.orgId, filters.divisionId, canStarts),
    canStarts ? listMyHouseWork({ window, divisionId: filters.divisionId }, context.orgId) : Promise.resolve([]),
  ])
  if (statError) throw new Error(`Failed to load production Home stats: ${statError.message}`)

  const aggregate = (statRollup ?? {}) as Record<string, unknown>
  const vpoWeekCents = Number(aggregate.vpo_week_cents ?? 0)
  const directCost = Number(aggregate.direct_cost_cents ?? 0)
  const blocked = packages.packages.filter((pkg: any) => pkg.status === "attention" || pkg.gatesPassed < pkg.gatesTotal).slice(0, 6)
  const stalledCutoff = new Date(today)
  stalledCutoff.setDate(stalledCutoff.getDate() - STALLED_DAYS)
  const stalledByProject = new Map<string, any>()
  for (const row of stalled ?? []) {
    if (Date.parse(row.updated_at) >= stalledCutoff.getTime() || stalledByProject.has(row.project_id)) continue
    stalledByProject.set(row.project_id, row)
  }
  const closingOpenCount = new Map<string, number>()
  for (const item of openClosingItems ?? []) closingOpenCount.set(item.closing_id, (closingOpenCount.get(item.closing_id) ?? 0) + 1)

  const blockedItems: NowExceptionDTO[] = [
    ...(closingsPage.closings ?? []).filter((row: any) => row.scheduled_date >= todayIso && row.scheduled_date <= weekEnd && (closingOpenCount.get(row.id) ?? 0) > 0).slice(0, 5).map((row: any) => ({ rank: EXCEPTION_RANK.closing, id: `closing:${row.id}`, label: relation(row.project)?.name ?? "Closing", detail: `${closingOpenCount.get(row.id)} closing checklist items open`, href: `/projects/${row.project_id}/closing`, tone: "danger" as const })),
    ...blocked.map((pkg: any) => ({ rank: EXCEPTION_RANK.startGate, id: `start:${pkg.id}`, label: `${pkg.communityName} · ${pkg.lotLabel}`, detail: `${pkg.gatesTotal - pkg.gatesPassed} start gate${pkg.gatesTotal - pkg.gatesPassed === 1 ? "" : "s"} open`, href: `/starts?package=${pkg.id}`, tone: "danger" as const })),
    ...overdueSelections.slice(0, 5).map(({ lane, home }) => ({
      rank: EXCEPTION_RANK.selection,
      id: `selection:${home.projectId}:${lane.groupId}`,
      label: `${home.lotLabel} · ${home.buyerName}`,
      detail: `${lane.name} · ${home.categoryCount - home.chosenCount} unchosen past cutoff`,
      href: `/design-studio/sheet/${home.projectId}`,
      tone: "danger" as const,
    })),
    ...Array.from(stalledByProject.values()).slice(0, 5).map((row: any) => ({ rank: EXCEPTION_RANK.stalled, id: `stalled:${row.project_id}`, label: relation(row.project)?.name ?? "Home", detail: `No schedule progress in ${STALLED_DAYS}+ days`, href: `/projects/${row.project_id}/schedule`, tone: "warning" as const })),
    ...(vpos ?? []).filter((row: any) => ["draft", "sent"].includes(row.status) && Number(row.total_cents ?? 0) >= 5_000_00).slice(0, 5).map((row: any) => ({ rank: EXCEPTION_RANK.vpo, id: `vpo:${row.id}`, label: relation(row.project)?.name ?? row.title, detail: `${currency(Number(row.total_cents ?? 0))} VPO awaiting approval`, href: `/purchasing?tab=variance`, tone: "warning" as const })),
  ]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, PANE_CAP)
    .map(({ rank: _rank, ...item }) => item)

  const next: NextItemDTO[] = [
    ...packages.packages.filter((pkg: any) => pkg.scheduledStartDate && pkg.scheduledStartDate <= twoWeek).map((pkg: any) => ({ id: `release:${pkg.id}`, date: pkg.scheduledStartDate!, type: "Release", label: `${pkg.communityName} · ${pkg.lotLabel}`, href: `/starts?package=${pkg.id}` })),
    ...(closingsPage.closings ?? []).filter((row: any) => row.scheduled_date >= todayIso && row.scheduled_date <= twoWeek).map((row: any) => ({ id: `closing:${row.id}`, date: row.scheduled_date, type: "Closing", label: relation(row.project)?.name ?? "Home closing", href: `/projects/${row.project_id}/closing` })),
    ...(selectionDates ?? []).map((row: any) => ({ id: `cutoff:${row.id}`, date: row.cutoff_date, type: "Selection cutoff", label: `${relation(row.project)?.name ?? "Home"} · ${relation(row.group)?.name ?? "Selections"}`, href: `/projects/${row.project_id}/selections` })),
    ...(takedowns ?? []).flatMap((community: any) => (community.lot_takedowns ?? []).filter((row: any) => row.status !== "closed").map((row: any) => ({ id: `takedown:${row.id}`, date: row.scheduled_date, type: "Takedown", label: `${community.name} · ${row.name}`, href: `/communities/${community.id}/land` }))),
  ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, PANE_CAP)

  const scopedBacklog = filters.communityId
    ? backlog.filter((row) => row.community_id === filters.communityId)
    : backlog
  return {
    hasCommunities: (communitiesResult.count ?? 0) > 0,
    assigned,
    // A superintendent's "act on this" is one activity across many lots; an
    // office role's is a ranked queue of blocked things. Never both — that
    // double-listed the same house under two headings.
    now: assigned
      ? { kind: "activities", window, groups: workGroups.slice(0, WORK_GROUP_CAP), truncated: workGroups.length > WORK_GROUP_CAP }
      : { kind: "blocked", items: blockedItems },
    next,
    stats: {
      starts: canStarts && ownsStarts
        ? { released: Number(aggregate.starts_released ?? 0), target: Number(aggregate.starts_target ?? 0) }
        : null,
      closings: canSales && ownsClosings
        ? {
          scheduled: Number(aggregate.closings_scheduled ?? 0),
          cleared: Number(aggregate.closings_cleared ?? 0),
          valueCents: Number(aggregate.closing_value_cents ?? 0),
        }
        : null,
      construction: ownsReporting
        ? {
          underConstruction: Number(aggregate.under_construction ?? 0),
          averageCycleDays: aggregate.average_cycle_days == null ? null : Number(aggregate.average_cycle_days),
        }
        : null,
      purchasing: canPurchasing && ownsPurchasing
        ? { vpoWeekCents, percentDirectCost: directCost > 0 ? (vpoWeekCents / directCost) * 100 : 0 }
        : null,
      backlog: canSales && ownsReporting
        ? {
          units: scopedBacklog.reduce((total, row) => total + Number(row.backlog_units), 0),
          valueCents: scopedBacklog.reduce((total, row) => total + Number(row.backlog_value_cents), 0),
          specUnits: scopedBacklog.reduce((total, row) => total + Number(row.spec_units), 0),
        }
        : null,
    },
  }
}

/**
 * The personal band. Derived from assignment, not from a role name — you carry
 * houses or you do not, and that alone decides whether Home leads with your work
 * and whether the roster tile exists. Returns null for everyone else.
 */
async function loadAssignedHouses(
  orgId: string,
  divisionId: string | undefined,
  canReadStarts: boolean,
): Promise<ProductionHomeData["assigned"]> {
  if (!canReadStarts) return null
  const { houses, total } = await listMyHouses({ pageSize: 100, divisionId }, orgId)
  if (!houses.length) return null
  const today = new Date().toISOString().slice(0, 10)
  return {
    houseCount: total,
    lateCount: houses.reduce((sum, house) => sum + house.lateCount, 0),
    missingLogCount: houses.filter((house) => !house.lastDailyLogDate || house.lastDailyLogDate < today).length,
    houses,
  }
}

function scopedCommunityQuery(
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  filters: { divisionId?: string; communityId?: string },
  columns: string,
  options?: { count: "exact"; head: true },
  allowedDivisionIds: string[] | null = null,
) {
  let query = context.supabase.from("communities").select(columns, options).eq("org_id", context.orgId).is("archived_at", null)
  if (filters.divisionId) query = query.eq("division_id", filters.divisionId)
  else if (allowedDivisionIds) {
    query = query.in(
      "division_id",
      allowedDivisionIds.length
        ? allowedDivisionIds
        : ["00000000-0000-0000-0000-000000000000"],
    )
  }
  if (filters.communityId) query = query.eq("id", filters.communityId)
  return query
}

async function resolveScopedProjectIds(
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  filters: { divisionId?: string; communityId?: string },
  authorizedIds: string[] | null,
) {
  let query = context.supabase.from("projects").select("id").eq("org_id", context.orgId).eq("phase", "delivery").eq("property_type", "production").eq("status", "active")
  if (filters.divisionId) query = query.eq("division_id", filters.divisionId)
  if (authorizedIds) query = query.in("id", authorizedIds.length ? authorizedIds : ["00000000-0000-0000-0000-000000000000"])
  const { data } = await query.limit(500)
  let ids = (data ?? []).map((row) => row.id as string)
  if (filters.communityId && ids.length) {
    const { data: lots } = await context.supabase.from("lots").select("project_id").eq("org_id", context.orgId).eq("community_id", filters.communityId).in("project_id", ids)
    ids = (lots ?? []).flatMap((row) => row.project_id ? [row.project_id] : [])
  }
  return ids
}

async function resolveScopedCommunityIds(
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  filters: { divisionId?: string; communityId?: string },
  allowedDivisionIds: string[] | null,
) {
  const { data, error } = await scopedCommunityQuery(
    context,
    filters,
    "id",
    undefined,
    allowedDivisionIds,
  ).limit(500)
  if (error) throw new Error(`Failed to scope production Home communities: ${error.message}`)
  return ((data ?? []) as unknown as Array<{ id: string }>).map((community) => community.id)
}

function relation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

function currency(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}
