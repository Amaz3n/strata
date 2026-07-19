import type { CostType } from "@/lib/cost-types"
import {
  diffPlanTakeoffs,
  resolveTakeoffLineAmount,
  type PlanTakeoffPricingLine,
  type TakeoffDiff,
} from "@/lib/financials/plan-pricing"
import { recordAudit } from "@/lib/services/audit"
import { getBudgetTemplate } from "@/lib/services/budget-templates"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import {
  availabilityInputSchema,
  elevationInputSchema,
  housePlanInputSchema,
  housePlanUpdateSchema,
  planVersionInputSchema,
  takeoffLineInputSchema,
  type AvailabilityInput,
  type ElevationInput,
  type HousePlanInput,
  type PlanVersionInput,
  type TakeoffLineInput,
} from "@/lib/validation/house-plans"

export type HousePlanElevationDto = {
  id: string
  code: string
  name: string | null
  swing_applicable: boolean
  heated_sqft_delta: number
  is_active: boolean
  cover_file_id: string | null
  sort_order: number
}

export type TakeoffLineDto = PlanTakeoffPricingLine & {
  cost_code_label: string | null
}

export type HousePlanVersionDto = {
  id: string
  version_number: number
  status: "draft" | "released" | "superseded"
  label: string | null
  notes: string | null
  budget_template_id: string | null
  schedule_template_id: string | null
  drawing_source_file_id: string | null
  checklist_template_ids: string[]
  selection_category_ids: string[]
  has_snapshot: boolean
  bundle_snapshot: Record<string, unknown> | null
  released_at: string | null
  released_by: string | null
  takeoff_line_count: number
  takeoff_total_cents_manual: number
  pinned_lot_count: number
  takeoff_lines?: TakeoffLineDto[]
}

export type HousePlanDto = {
  id: string
  code: string
  name: string
  series: string | null
  status: "draft" | "active" | "retired"
  division_id: string | null
  heated_sqft: number | null
  total_sqft: number | null
  beds: number | null
  baths: number | null
  stories: number | null
  garage_bays: number | null
  description: string | null
  cover_file_id: string | null
  elevation_count: number
  current_released_version: number | null
  active_lot_count: number
  community_count: number
  community_ids: string[]
  created_at: string | null
  updated_at: string | null
  elevations?: HousePlanElevationDto[]
  versions?: HousePlanVersionDto[]
}

export type CommunityPlanAvailabilityDto = {
  id: string
  community_id: string
  house_plan_id: string
  elevation_id: string | null
  is_available: boolean
  base_price_cents: number
  effective_start: string | null
  effective_end: string | null
}

export type PlanVersionDriftDto = {
  version_id: string
  version_number: number
  pinned_lot_count: number
  changes: TakeoffDiff[]
  manual_price_delta_cents: number
}

type PlanRow = {
  id: string
  code: string
  name: string
  series: string | null
  status: HousePlanDto["status"]
  division_id: string | null
  heated_sqft: number | null
  total_sqft: number | null
  beds: number | null
  baths: number | null
  stories: number | null
  garage_bays: number | null
  description: string | null
  cover_file_id: string | null
  created_at: string | null
  updated_at: string | null
}

type VersionRow = {
  id: string
  house_plan_id: string
  version_number: number
  status: HousePlanVersionDto["status"]
  label: string | null
  notes: string | null
  budget_template_id: string | null
  schedule_template_id: string | null
  drawing_source_file_id: string | null
  bundle_snapshot: Record<string, unknown> | null
  released_at: string | null
  released_by: string | null
}

type LinkRow = { house_plan_version_id: string; kind: "checklist" | "selection_category"; template_id: string }

type TakeoffRow = {
  id: string
  house_plan_version_id: string
  elevation_id: string | null
  cost_code_id: string
  cost_type: CostType | null
  description: string
  quantity: number
  uom: string
  unit_cost_cents: number | null
  sort_order: number
  cost_code?: { code: string; name: string } | Array<{ code: string; name: string }> | null
}

const planSelect = "id, code, name, series, status, division_id, heated_sqft, total_sqft, beds, baths, stories, garage_bays, description, cover_file_id, created_at, updated_at"
const versionSelect = "id, house_plan_id, version_number, status, label, notes, budget_template_id, schedule_template_id, drawing_source_file_id, bundle_snapshot, released_at, released_by"

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

function mapTakeoff(row: TakeoffRow): TakeoffLineDto {
  const code = one(row.cost_code)
  return {
    id: row.id,
    elevation_id: row.elevation_id,
    cost_code_id: row.cost_code_id,
    cost_code_label: code ? `${code.code} — ${code.name}` : null,
    cost_type: row.cost_type,
    description: row.description,
    quantity: Number(row.quantity),
    uom: row.uom,
    unit_cost_cents: row.unit_cost_cents == null ? null : Number(row.unit_cost_cents),
    sort_order: Number(row.sort_order),
  }
}

async function loadPlanAggregates(context: Awaited<ReturnType<typeof requireOrgContext>>, planIds: string[]) {
  if (planIds.length === 0) return { elevations: [], versions: [], lots: [], availability: [] }
  const [elevationsResult, versionsResult, lotsResult, availabilityResult] = await Promise.all([
    context.supabase.from("house_plan_elevations").select("id, house_plan_id, code, name, swing_applicable, heated_sqft_delta, is_active, cover_file_id, sort_order").eq("org_id", context.orgId).in("house_plan_id", planIds).order("sort_order"),
    context.supabase.from("house_plan_versions").select(versionSelect).eq("org_id", context.orgId).in("house_plan_id", planIds).order("version_number", { ascending: false }),
    context.supabase.from("lots").select("house_plan_id, house_plan_version_id, status").eq("org_id", context.orgId).in("house_plan_id", planIds),
    context.supabase.from("community_plan_availability").select("house_plan_id, community_id").eq("org_id", context.orgId).in("house_plan_id", planIds).eq("is_available", true),
  ])
  for (const result of [elevationsResult, versionsResult, lotsResult, availabilityResult]) {
    if (result.error) throw new Error(`Failed to load plan aggregates: ${result.error.message}`)
  }
  return {
    elevations: elevationsResult.data ?? [],
    versions: (versionsResult.data ?? []) as VersionRow[],
    lots: lotsResult.data ?? [],
    availability: availabilityResult.data ?? [],
  }
}

function mapPlan(row: PlanRow, aggregates: Awaited<ReturnType<typeof loadPlanAggregates>>): HousePlanDto {
  const elevations = aggregates.elevations.filter((item) => item.house_plan_id === row.id)
  const versions = aggregates.versions.filter((item) => item.house_plan_id === row.id)
  const activeLots = aggregates.lots.filter((item) => item.house_plan_id === row.id && !["closed","cancelled"].includes(item.status))
  const communities = new Set(aggregates.availability.filter((item) => item.house_plan_id === row.id).map((item) => item.community_id))
  return {
    ...row,
    heated_sqft: row.heated_sqft == null ? null : Number(row.heated_sqft),
    total_sqft: row.total_sqft == null ? null : Number(row.total_sqft),
    beds: row.beds == null ? null : Number(row.beds),
    baths: row.baths == null ? null : Number(row.baths),
    stories: row.stories == null ? null : Number(row.stories),
    garage_bays: row.garage_bays == null ? null : Number(row.garage_bays),
    elevation_count: elevations.length,
    current_released_version: versions.find((version) => version.status === "released")?.version_number ?? null,
    active_lot_count: activeLots.length,
    community_count: communities.size,
    community_ids: Array.from(communities),
  }
}

export async function listHousePlans(
  filters: { status?: HousePlanDto["status"]; divisionId?: string; communityId?: string } = {},
  orgId?: string,
): Promise<HousePlanDto[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.read", context)
  let query = context.supabase.from("house_plans").select(planSelect).eq("org_id", context.orgId).order("code").limit(100)
  if (filters.status) query = query.eq("status", filters.status)
  if (filters.divisionId) query = query.eq("division_id", filters.divisionId)
  if (filters.communityId) {
    const { data, error } = await context.supabase.from("community_plan_availability").select("house_plan_id").eq("org_id", context.orgId).eq("community_id", filters.communityId).eq("is_available", true)
    if (error) throw new Error(`Failed to filter community plans: ${error.message}`)
    const ids = Array.from(new Set((data ?? []).map((row) => row.house_plan_id)))
    if (ids.length === 0) return []
    query = query.in("id", ids)
  }
  const { data, error } = await query
  if (error) throw new Error(`Failed to list house plans: ${error.message}`)
  const rows = (data ?? []) as PlanRow[]
  const aggregates = await loadPlanAggregates(context, rows.map((row) => row.id))
  return rows.map((row) => mapPlan(row, aggregates))
}

async function loadVersionDetails(context: Awaited<ReturnType<typeof requireOrgContext>>, versions: VersionRow[]): Promise<HousePlanVersionDto[]> {
  if (versions.length === 0) return []
  const ids = versions.map((version) => version.id)
  const [linksResult, takeoffResult, lotsResult] = await Promise.all([
    context.supabase.from("house_plan_version_template_links").select("house_plan_version_id, kind, template_id").eq("org_id", context.orgId).in("house_plan_version_id", ids).order("sort_order"),
    context.supabase.from("house_plan_takeoff_lines").select("id, house_plan_version_id, elevation_id, cost_code_id, cost_type, description, quantity, uom, unit_cost_cents, sort_order, cost_code:cost_codes(code,name)").eq("org_id", context.orgId).in("house_plan_version_id", ids).order("sort_order"),
    context.supabase.from("lots").select("house_plan_version_id").eq("org_id", context.orgId).in("house_plan_version_id", ids),
  ])
  for (const result of [linksResult, takeoffResult, lotsResult]) {
    if (result.error) throw new Error(`Failed to load plan version details: ${result.error.message}`)
  }
  const links = (linksResult.data ?? []) as LinkRow[]
  const takeoffs = (takeoffResult.data ?? []).map((row) => mapTakeoff(row as TakeoffRow))
  return versions.map((version) => {
    const versionLines = takeoffs.filter((line) => (takeoffResult.data ?? []).find((row) => row.id === line.id)?.house_plan_version_id === version.id)
    const versionLinks = links.filter((link) => link.house_plan_version_id === version.id)
    return {
      id: version.id,
      version_number: Number(version.version_number),
      status: version.status,
      label: version.label,
      notes: version.notes,
      budget_template_id: version.budget_template_id,
      schedule_template_id: version.schedule_template_id,
      drawing_source_file_id: version.drawing_source_file_id,
      checklist_template_ids: versionLinks.filter((link) => link.kind === "checklist").map((link) => link.template_id),
      selection_category_ids: versionLinks.filter((link) => link.kind === "selection_category").map((link) => link.template_id),
      has_snapshot: Boolean(version.bundle_snapshot),
      bundle_snapshot: version.bundle_snapshot,
      released_at: version.released_at,
      released_by: version.released_by,
      takeoff_line_count: versionLines.length,
      takeoff_total_cents_manual: versionLines.reduce((sum, line) => sum + resolveTakeoffLineAmount(line.quantity, line.unit_cost_cents ?? 0), 0),
      pinned_lot_count: (lotsResult.data ?? []).filter((lot) => lot.house_plan_version_id === version.id).length,
      takeoff_lines: versionLines,
    }
  })
}

export async function getHousePlan(id: string, orgId?: string): Promise<HousePlanDto> {
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.read", context)
  const { data, error } = await context.supabase.from("house_plans").select(planSelect).eq("org_id", context.orgId).eq("id", id).maybeSingle()
  if (error || !data) throw new Error("House plan not found")
  const aggregates = await loadPlanAggregates(context, [id])
  const plan = mapPlan(data as PlanRow, aggregates)
  const versions = await loadVersionDetails(context, aggregates.versions)
  return {
    ...plan,
    elevations: aggregates.elevations.map((item) => ({
      id: item.id,
      code: item.code,
      name: item.name,
      swing_applicable: item.swing_applicable,
      heated_sqft_delta: Number(item.heated_sqft_delta),
      is_active: item.is_active,
      cover_file_id: item.cover_file_id,
      sort_order: Number(item.sort_order),
    })),
    versions,
  }
}

function planPayload(input: Partial<HousePlanInput>) {
  const patch: Record<string, unknown> = {}
  if (input.code !== undefined) patch.code = input.code
  if (input.name !== undefined) patch.name = input.name
  if (input.series !== undefined) patch.series = input.series ?? null
  if (input.divisionId !== undefined) patch.division_id = input.divisionId ?? null
  if (input.status !== undefined) patch.status = input.status
  if (input.heatedSqft !== undefined) patch.heated_sqft = input.heatedSqft ?? null
  if (input.totalSqft !== undefined) patch.total_sqft = input.totalSqft ?? null
  if (input.beds !== undefined) patch.beds = input.beds ?? null
  if (input.baths !== undefined) patch.baths = input.baths ?? null
  if (input.stories !== undefined) patch.stories = input.stories ?? null
  if (input.garageBays !== undefined) patch.garage_bays = input.garageBays ?? null
  if (input.description !== undefined) patch.description = input.description ?? null
  if (input.coverFileId !== undefined) patch.cover_file_id = input.coverFileId ?? null
  if (input.metadata !== undefined) patch.metadata = input.metadata
  return patch
}

async function logPlan(context: Awaited<ReturnType<typeof requireOrgContext>>, input: { eventType: string; entityType: string; entityId: string; action: "insert" | "update"; before?: Record<string, unknown>; after?: Record<string, unknown>; payload?: Record<string, unknown> }) {
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: input.eventType, entityType: input.entityType, entityId: input.entityId, payload: input.payload }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: input.action, entityType: input.entityType, entityId: input.entityId, before: input.before, after: input.after }),
  ])
}

export async function createHousePlan(input: HousePlanInput, orgId?: string): Promise<HousePlanDto> {
  const parsed = housePlanInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.write", context)
  if (parsed.status === "active") throw new Error("Release a plan version before activating the plan")
  const { data, error } = await context.supabase.from("house_plans").insert({ ...planPayload(parsed), org_id: context.orgId, created_by: context.userId }).select(planSelect).single()
  if (error || !data) throw new Error(`Failed to create house plan: ${error?.message ?? "unknown error"}`)
  const { error: versionError } = await context.supabase.from("house_plan_versions").insert({ org_id: context.orgId, house_plan_id: data.id, version_number: 1, status: "draft", created_by: context.userId })
  if (versionError) throw new Error(`Failed to create initial plan version: ${versionError.message}`)
  await logPlan(context, { eventType: "house_plan.created", entityType: "house_plan", entityId: data.id, action: "insert", after: data })
  return getHousePlan(data.id, context.orgId)
}

export async function updateHousePlan(id: string, input: Partial<HousePlanInput>, orgId?: string): Promise<HousePlanDto> {
  const parsed = housePlanUpdateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.write", context)
  const before = await getHousePlan(id, context.orgId)
  if (parsed.status === "active" && !before.versions?.some((version) => version.status === "released")) {
    throw new Error("A plan needs a released version before it can be active")
  }
  const { data, error } = await context.supabase.from("house_plans").update(planPayload(parsed)).eq("org_id", context.orgId).eq("id", id).select(planSelect).single()
  if (error || !data) throw new Error(`Failed to update house plan: ${error?.message ?? "not found"}`)
  await logPlan(context, { eventType: "house_plan.updated", entityType: "house_plan", entityId: id, action: "update", before: { ...before }, after: data })
  return getHousePlan(id, context.orgId)
}

export async function upsertElevation(planId: string, input: ElevationInput, orgId?: string): Promise<HousePlanElevationDto> {
  const parsed = elevationInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.write", context)
  await getHousePlan(planId, context.orgId)
  const payload = {
    org_id: context.orgId,
    house_plan_id: planId,
    code: parsed.code,
    name: parsed.name ?? null,
    swing_applicable: parsed.swingApplicable,
    heated_sqft_delta: parsed.heatedSqftDelta,
    is_active: parsed.isActive,
    cover_file_id: parsed.coverFileId ?? null,
    sort_order: parsed.sortOrder,
    metadata: parsed.metadata ?? {},
  }
  const query = parsed.id
    ? context.supabase.from("house_plan_elevations").update(payload).eq("org_id", context.orgId).eq("house_plan_id", planId).eq("id", parsed.id)
    : context.supabase.from("house_plan_elevations").insert(payload)
  const { data, error } = await query.select("id, code, name, swing_applicable, heated_sqft_delta, is_active, cover_file_id, sort_order").single()
  if (error || !data) throw new Error(`Failed to save elevation: ${error?.message ?? "unknown error"}`)
  await logPlan(context, { eventType: "house_plan.updated", entityType: "house_plan", entityId: planId, action: "update", after: { elevation_id: data.id, code: data.code } })
  return { ...data, heated_sqft_delta: Number(data.heated_sqft_delta), sort_order: Number(data.sort_order) }
}

export async function listPlanVersions(planId: string, orgId?: string): Promise<HousePlanVersionDto[]> {
  const plan = await getHousePlan(planId, orgId)
  return plan.versions ?? []
}

export async function createPlanVersion(planId: string, input: { copyFromVersionId?: string | null; label?: string | null } = {}, orgId?: string): Promise<HousePlanVersionDto> {
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.write", context)
  const versions = await listPlanVersions(planId, context.orgId)
  const source = input.copyFromVersionId ? versions.find((version) => version.id === input.copyFromVersionId) : undefined
  if (input.copyFromVersionId && !source) throw new Error("Source plan version not found")
  const nextNumber = Math.max(0, ...versions.map((version) => version.version_number)) + 1
  const { data, error } = await context.supabase.from("house_plan_versions").insert({
    org_id: context.orgId,
    house_plan_id: planId,
    version_number: nextNumber,
    status: "draft",
    label: input.label ?? source?.label ?? null,
    notes: source?.notes ?? null,
    budget_template_id: source?.budget_template_id ?? null,
    schedule_template_id: source?.schedule_template_id ?? null,
    drawing_source_file_id: source?.drawing_source_file_id ?? null,
    created_by: context.userId,
  }).select(versionSelect).single()
  if (error || !data) throw new Error(`Failed to create plan version: ${error?.message ?? "unknown error"}`)
  if (source) {
    const links = [
      ...source.checklist_template_ids.map((templateId, index) => ({ org_id: context.orgId, house_plan_version_id: data.id, kind: "checklist", template_id: templateId, sort_order: index })),
      ...source.selection_category_ids.map((templateId, index) => ({ org_id: context.orgId, house_plan_version_id: data.id, kind: "selection_category", template_id: templateId, sort_order: index })),
    ]
    if (links.length > 0) {
      const { error: linkError } = await context.supabase.from("house_plan_version_template_links").insert(links)
      if (linkError) throw new Error(`Failed to copy plan bundle links: ${linkError.message}`)
    }
    if ((source.takeoff_lines ?? []).length > 0) {
      const { error: takeoffError } = await context.supabase.from("house_plan_takeoff_lines").insert((source.takeoff_lines ?? []).map((line) => ({
        org_id: context.orgId,
        house_plan_version_id: data.id,
        elevation_id: line.elevation_id,
        cost_code_id: line.cost_code_id,
        cost_type: line.cost_type,
        description: line.description,
        quantity: line.quantity,
        uom: line.uom,
        unit_cost_cents: line.unit_cost_cents,
        sort_order: line.sort_order,
      })))
      if (takeoffError) throw new Error(`Failed to copy plan takeoff: ${takeoffError.message}`)
    }
  }
  await logPlan(context, { eventType: "house_plan.updated", entityType: "house_plan_version", entityId: data.id, action: "insert", after: data })
  return (await listPlanVersions(planId, context.orgId)).find((version) => version.id === data.id) ?? (() => { throw new Error("Created plan version not found") })()
}

async function getVersionForWrite(versionId: string, context: Awaited<ReturnType<typeof requireOrgContext>>) {
  const { data, error } = await context.supabase.from("house_plan_versions").select(versionSelect).eq("org_id", context.orgId).eq("id", versionId).maybeSingle()
  if (error || !data) throw new Error("Plan version not found")
  if (data.status !== "draft") throw new Error("Released plan versions are read-only")
  return data as VersionRow
}

export async function updatePlanVersion(versionId: string, input: PlanVersionInput, orgId?: string): Promise<HousePlanVersionDto> {
  const parsed = planVersionInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.write", context)
  const before = await getVersionForWrite(versionId, context)
  const { data, error } = await context.supabase.from("house_plan_versions").update({
    label: parsed.label ?? null,
    notes: parsed.notes ?? null,
    budget_template_id: parsed.budgetTemplateId ?? null,
    schedule_template_id: parsed.scheduleTemplateId ?? null,
    drawing_source_file_id: parsed.drawingSourceFileId ?? null,
    metadata: parsed.metadata ?? {},
  }).eq("org_id", context.orgId).eq("id", versionId).select(versionSelect).single()
  if (error || !data) throw new Error(`Failed to update plan version: ${error?.message ?? "not found"}`)
  const { error: deleteError } = await context.supabase.from("house_plan_version_template_links").delete().eq("org_id", context.orgId).eq("house_plan_version_id", versionId)
  if (deleteError) throw new Error(`Failed to update plan bundle links: ${deleteError.message}`)
  const links = [
    ...parsed.checklistTemplateIds.map((templateId, index) => ({ org_id: context.orgId, house_plan_version_id: versionId, kind: "checklist", template_id: templateId, sort_order: index })),
    ...parsed.selectionCategoryIds.map((templateId, index) => ({ org_id: context.orgId, house_plan_version_id: versionId, kind: "selection_category", template_id: templateId, sort_order: index })),
  ]
  if (links.length > 0) {
    const { error: linkError } = await context.supabase.from("house_plan_version_template_links").insert(links)
    if (linkError) throw new Error(`Failed to update plan bundle links: ${linkError.message}`)
  }
  await logPlan(context, { eventType: "house_plan.updated", entityType: "house_plan_version", entityId: versionId, action: "update", before, after: data })
  return (await listPlanVersions(before.house_plan_id, context.orgId)).find((version) => version.id === versionId) ?? (() => { throw new Error("Updated plan version not found") })()
}

export async function replaceTakeoffLines(versionId: string, lines: TakeoffLineInput[], orgId?: string): Promise<TakeoffLineDto[]> {
  const parsed = lines.map((line) => takeoffLineInputSchema.parse(line))
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.write", context)
  const version = await getVersionForWrite(versionId, context)
  const { error: deleteError } = await context.supabase.from("house_plan_takeoff_lines").delete().eq("org_id", context.orgId).eq("house_plan_version_id", versionId)
  if (deleteError) throw new Error(`Failed to replace takeoff lines: ${deleteError.message}`)
  if (parsed.length > 0) {
    const { error } = await context.supabase.from("house_plan_takeoff_lines").insert(parsed.map((line, index) => ({
      org_id: context.orgId,
      house_plan_version_id: versionId,
      elevation_id: line.elevationId ?? null,
      cost_code_id: line.costCodeId,
      cost_type: line.costType ?? null,
      description: line.description,
      quantity: line.quantity,
      uom: line.uom,
      unit_cost_cents: line.unitCostCents ?? null,
      sort_order: index,
      metadata: line.metadata ?? {},
    })))
    if (error) throw new Error(`Failed to replace takeoff lines: ${error.message}`)
  }
  await logPlan(context, { eventType: "house_plan.updated", entityType: "house_plan_version", entityId: versionId, action: "update", after: { takeoff_line_count: parsed.length } })
  const updated = (await listPlanVersions(version.house_plan_id, context.orgId)).find((item) => item.id === versionId)
  return updated?.takeoff_lines ?? []
}

async function captureBundleSnapshot(version: HousePlanVersionDto, context: Awaited<ReturnType<typeof requireOrgContext>>) {
  const [scheduleResult, checklistResult, selectionResult] = await Promise.all([
    version.schedule_template_id
      ? context.supabase.from("schedule_templates").select("id, name, description, items").eq("org_id", context.orgId).eq("id", version.schedule_template_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    version.checklist_template_ids.length > 0
      ? context.supabase.from("checklist_templates").select("id, name, kind, trade, description, items:checklist_template_items(section,prompt,response_type,sort_order)").eq("org_id", context.orgId).in("id", version.checklist_template_ids)
      : Promise.resolve({ data: [], error: null }),
    version.selection_category_ids.length > 0
      ? context.supabase.from("selection_categories").select("id").eq("org_id", context.orgId).in("id", version.selection_category_ids).eq("is_template", true)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (scheduleResult.error) throw new Error(`Failed to snapshot schedule template: ${scheduleResult.error.message}`)
  if (checklistResult.error) throw new Error(`Failed to snapshot checklist templates: ${checklistResult.error.message}`)
  if (selectionResult.error) throw new Error(`Failed to snapshot selection templates: ${selectionResult.error.message}`)
  const budgetTemplate = version.budget_template_id ? await getBudgetTemplate(version.budget_template_id, context.orgId) : null
  return {
    budget_template: budgetTemplate,
    schedule_template: scheduleResult.data,
    checklists: checklistResult.data ?? [],
    selection_categories: (selectionResult.data ?? []).map((row) => row.id),
    drawing_source_file_id: version.drawing_source_file_id,
    captured_at: new Date().toISOString(),
  }
}

export async function releasePlanVersion(versionId: string, orgId?: string): Promise<HousePlanVersionDto> {
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.release", context)
  const writable = await getVersionForWrite(versionId, context)
  const version = (await listPlanVersions(writable.house_plan_id, context.orgId)).find((item) => item.id === versionId)
  if (!version) throw new Error("Plan version not found")
  if (version.takeoff_line_count === 0 && !version.budget_template_id) throw new Error("Add a takeoff or budget template before release")
  if (!version.schedule_template_id) throw new Error("Choose a schedule template before release")
  const snapshot = await captureBundleSnapshot(version, context)
  const currentReleased = (await listPlanVersions(writable.house_plan_id, context.orgId)).find((item) => item.status === "released")
  const releasedAt = new Date().toISOString()
  const { error } = await context.supabase.rpc("release_house_plan_version", {
    p_org_id: context.orgId,
    p_version_id: versionId,
    p_actor_id: context.userId,
    p_bundle_snapshot: snapshot,
    p_released_at: releasedAt,
  })
  if (error) throw new Error(`Failed to release plan version: ${error.message}`)
  if (currentReleased) {
    await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "house_plan_version.superseded", entityType: "house_plan_version", entityId: currentReleased.id, payload: { house_plan_id: writable.house_plan_id } })
  }
  await logPlan(context, { eventType: "house_plan_version.released", entityType: "house_plan_version", entityId: versionId, action: "update", before: writable, after: { ...writable, status: "released", bundle_snapshot: snapshot, released_at: releasedAt, released_by: context.userId }, payload: { house_plan_id: writable.house_plan_id, version_number: writable.version_number } })
  return (await listPlanVersions(writable.house_plan_id, context.orgId)).find((item) => item.id === versionId) ?? (() => { throw new Error("Released plan version not found") })()
}

export async function setCommunityAvailability(entries: AvailabilityInput[], orgId?: string): Promise<CommunityPlanAvailabilityDto[]> {
  const parsed = entries.map((entry) => availabilityInputSchema.parse(entry))
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.write", context)
  if (parsed.length === 0) return []
  const { data, error } = await context.supabase.from("community_plan_availability").upsert(parsed.map((entry) => ({
    org_id: context.orgId,
    community_id: entry.communityId,
    house_plan_id: entry.housePlanId,
    elevation_id: entry.elevationId ?? null,
    is_available: entry.isAvailable,
    base_price_cents: entry.basePriceCents,
    effective_start: entry.effectiveStart ?? null,
    effective_end: entry.effectiveEnd ?? null,
    metadata: entry.metadata ?? {},
  })), { onConflict: "community_id,house_plan_id,elevation_id" }).select("id, community_id, house_plan_id, elevation_id, is_available, base_price_cents, effective_start, effective_end")
  if (error) throw new Error(`Failed to save community plan availability: ${error.message}`)
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "community_plan_availability.updated", entityType: "house_plan", entityId: parsed[0].housePlanId, payload: { entry_count: parsed.length } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "house_plan", entityId: parsed[0].housePlanId, after: { availability: data ?? [] } })
  return (data ?? []).map((row) => ({ ...row, base_price_cents: Number(row.base_price_cents) }))
}

export async function listCommunityAvailability(filters: { communityId?: string; housePlanId?: string }, orgId?: string): Promise<CommunityPlanAvailabilityDto[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.read", context)
  let query = context.supabase.from("community_plan_availability").select("id, community_id, house_plan_id, elevation_id, is_available, base_price_cents, effective_start, effective_end").eq("org_id", context.orgId).order("effective_start", { ascending: false, nullsFirst: false }).limit(1000)
  if (filters.communityId) query = query.eq("community_id", filters.communityId)
  if (filters.housePlanId) query = query.eq("house_plan_id", filters.housePlanId)
  const { data, error } = await query
  if (error) throw new Error(`Failed to list community plan availability: ${error.message}`)
  return (data ?? []).map((row) => ({ ...row, base_price_cents: Number(row.base_price_cents) }))
}

export async function getPlanVersionDrift(planId: string, orgId?: string): Promise<PlanVersionDriftDto[]> {
  const versions = await listPlanVersions(planId, orgId)
  const current = versions.find((version) => version.status === "released")
  if (!current) return []
  return versions.filter((version) => version.status === "superseded").map((version) => {
    const changes = diffPlanTakeoffs(version.takeoff_lines ?? [], current.takeoff_lines ?? [])
    return {
      version_id: version.id,
      version_number: version.version_number,
      pinned_lot_count: version.pinned_lot_count,
      changes,
      manual_price_delta_cents: changes.reduce((sum, change) => sum + change.manual_price_delta_cents, 0),
    }
  })
}
