import "server-only"

/**
 * The org's reusable condition library.
 *
 * Conditions repeat almost exactly from job to job — "LVP flooring", "base
 * trim", "4in slab" — and retyping them with their cost codes, waste, and axis
 * factors is both the largest tax on starting a takeoff and where the errors
 * come from. A template is a condition minus its scope: no project, no plan
 * version, no measurements, no color assignment (color is identity ON a sheet,
 * so it is claimed at apply time from what the scope has not used yet).
 *
 * Deliberately NOT an assembly. One template becomes one condition with one
 * unit and one cost code. Multi-output formulas are a different feature with a
 * different failure mode, and depth factors plus a library cover the bulk of
 * what a residential estimator retypes.
 */

import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireTakeoffCostCodes, requireTakeoffWriteScope } from "@/lib/services/takeoff-scope"
import { nextConditionColor } from "@/lib/drawings/takeoff-palette"
import type { ConditionUom } from "@/lib/drawings/measure"
import {
  applyConditionTemplatesSchema,
  createConditionTemplateSchema,
  conditionTemplateMutationTargetSchema,
  factorRuleViolation,
  saveConditionsAsTemplatesSchema,
  TEMPLATE_LIST_CAP,
  updateConditionTemplateSchema,
  type ApplyConditionTemplatesInput,
  type CreateConditionTemplateInput,
  type SaveConditionsAsTemplatesInput,
  type UpdateConditionTemplateInput,
} from "@/lib/validation/takeoff"
import { CONDITION_LIST_CAP, STALE_WRITE } from "@/lib/services/takeoff"
import { readAllRowsById } from "@/lib/land/paging"

const TEMPLATE_SELECT =
  "id, org_id, name, uom, depth_in, height_ft, pitch_rise, tons_per_cy, cost_code_id, color, waste_pct, unit_cost_cents, share_with_clients, notes, group_name, sort_order, created_by, created_at, updated_at"

/** Ungrouped templates sort under this heading rather than vanishing. */
// Shape + grouping live in a client-safe module so the takeoff template
// library (a client component) can use them without dragging this service —
// and `server-only` with it — into the browser bundle. Re-exported here so
// server-side callers keep importing them from the service they belong to.
import type { ConditionTemplate } from "@/lib/drawings/condition-templates"

export {
  UNGROUPED_LABEL,
  groupTemplates,
  type ConditionTemplate,
} from "@/lib/drawings/condition-templates"

function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function mapTemplate(row: any): ConditionTemplate {
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    uom: row.uom as ConditionUom,
    depth_in: numericOrNull(row.depth_in),
    height_ft: numericOrNull(row.height_ft),
    pitch_rise: numericOrNull(row.pitch_rise),
    tons_per_cy: numericOrNull(row.tons_per_cy),
    cost_code_id: row.cost_code_id ?? null,
    color: row.color ?? null,
    waste_pct: Number(row.waste_pct ?? 0),
    unit_cost_cents: row.unit_cost_cents ?? null,
    share_with_clients: row.share_with_clients ?? false,
    notes: row.notes ?? null,
    group_name: row.group_name ?? null,
    sort_order: row.sort_order ?? 0,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function verifiedTemplateCount(count: unknown, error: { message: string } | null): number {
  if (error || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("Unable to verify the template library size. Reload before retrying.")
  }
  return count
}

const TEMPLATE_COPY_FIELDS = [
  "org_id", "name", "uom", "depth_in", "height_ft", "pitch_rise", "tons_per_cy",
  "cost_code_id", "color", "waste_pct", "unit_cost_cents", "share_with_clients",
  "notes", "group_name", "sort_order", "created_by",
] as const

function isConfirmedTemplate(saved: ConditionTemplate, expected: Partial<ConditionTemplate>): boolean {
  return typeof saved.id === "string" && Boolean(saved.id) &&
    TEMPLATE_COPY_FIELDS.every((key) => !Object.hasOwn(expected, key) || saved[key] === expected[key])
}

// ============================================================================
// CRUD
// ============================================================================

export async function listConditionTemplates(orgId?: string): Promise<ConditionTemplate[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.read", { supabase, orgId: resolvedOrgId, userId })

  // Read legacy over-cap libraries so their original rows can be inspected and
  // removed. The creation limit remains separate from this validation bound.
  const rows = await readAllRowsById(async (afterId, limit) => {
    let query = supabase.from("takeoff_condition_templates").select(TEMPLATE_SELECT)
      .eq("org_id", resolvedOrgId).order("id", { ascending: true }).limit(limit)
    if (afterId) query = query.gt("id", afterId)
    const result = await query
    if (result.data?.some((row) => row.org_id !== resolvedOrgId)) {
      throw new Error("Failed to load complete condition template library: organization mismatch")
    }
    return result
  }, { cap: 10_000, pageSize: 500, label: "Failed to load complete condition template library" })
  return rows.map(mapTemplate).sort((a, b) => {
    if (a.group_name === null && b.group_name !== null) return 1
    if (a.group_name !== null && b.group_name === null) return -1
    return (a.group_name ?? "").localeCompare(b.group_name ?? "") ||
      a.sort_order - b.sort_order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  })
}

export async function createConditionTemplate(
  input: CreateConditionTemplateInput,
  orgId?: string,
): Promise<ConditionTemplate> {
  const parsed = createConditionTemplateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  const { count, error: countError } = await supabase
    .from("takeoff_condition_templates")
    .select("id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)
  const libraryCount = verifiedTemplateCount(count, countError)
  if (libraryCount >= TEMPLATE_LIST_CAP) {
    throw new Error(`The library holds at most ${TEMPLATE_LIST_CAP} templates`)
  }

  const payload = {
      org_id: resolvedOrgId,
      name: parsed.name,
      uom: parsed.uom,
      depth_in: parsed.depth_in ?? null,
      height_ft: parsed.height_ft ?? null,
      pitch_rise: parsed.pitch_rise ?? null,
      tons_per_cy: parsed.tons_per_cy ?? null,
      cost_code_id: parsed.cost_code_id ?? null,
      color: parsed.color ?? null,
      waste_pct: parsed.waste_pct ?? 0,
      unit_cost_cents: parsed.unit_cost_cents ?? null,
      share_with_clients: parsed.share_with_clients ?? false,
      notes: parsed.notes ?? null,
      group_name: parsed.group_name?.trim() || null,
      sort_order: libraryCount,
      created_by: userId,
  }
  await requireTakeoffCostCodes(context, [payload])
  const { data, error } = await supabase
    .from("takeoff_condition_templates")
    .insert(payload)
    .select(TEMPLATE_SELECT)
    .single()

  if (error?.code === "23505") {
    throw new Error(`The library already has a template called "${parsed.name}"`)
  }
  if (error || !data) {
    throw new Error(`Failed to create condition template: ${error?.message}`)
  }
  const saved = mapTemplate(data)
  if (!isConfirmedTemplate(saved, payload)) {
    throw new Error("Created template could not be confirmed. Reload before retrying.")
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "takeoff_condition_template",
    entityId: data.id as string,
    after: data,
  })

  return saved
}

export async function updateConditionTemplate(
  templateId: string,
  updates: UpdateConditionTemplateInput,
  orgId?: string,
  seenUpdatedAt?: string | null,
): Promise<ConditionTemplate> {
  const parsed = updateConditionTemplateSchema.parse(updates)
  const target = conditionTemplateMutationTargetSchema.parse({ templateId, seenUpdatedAt })
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  let existingQuery = supabase
    .from("takeoff_condition_templates")
    .select(TEMPLATE_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", target.templateId)
  if (target.seenUpdatedAt) existingQuery = existingQuery.eq("updated_at", target.seenUpdatedAt)
  const { data: existing, error: existingError } = await existingQuery.maybeSingle()

  if (existingError) throw new Error(`Failed to load condition template: ${existingError.message}`)
  if (!existing && target.seenUpdatedAt) throw new Error(STALE_WRITE)
  if (!existing || existing.id !== target.templateId || existing.org_id !== resolvedOrgId) throw new Error("Condition template not found")
  if (typeof existing.updated_at !== "string") throw new Error("Template revision unavailable. Reload before retrying.")
  conditionTemplateMutationTargetSchema.parse({ templateId: existing.id, seenUpdatedAt: existing.updated_at })

  const payload: Record<string, unknown> = {}
  for (const key of [
    "name",
    "depth_in",
    "height_ft",
    "pitch_rise",
    "tons_per_cy",
    "cost_code_id",
    "color",
    "waste_pct",
    "unit_cost_cents",
    "share_with_clients",
    "notes",
    "sort_order",
  ] as const) {
    if (parsed[key] !== undefined) payload[key] = parsed[key]
  }
  if (parsed.group_name !== undefined) {
    payload.group_name = parsed.group_name?.trim() || null
  }
  if (Object.keys(payload).length === 0) return mapTemplate(existing)

  // Factors are legal only against the stored uom, which an update never sends.
  const expected = { ...mapTemplate(existing), ...payload }
  const violation = factorRuleViolation(expected)
  if (violation) throw new Error(violation)
  await requireTakeoffCostCodes(context, [expected])

  const query = supabase
    .from("takeoff_condition_templates")
    .update(payload)
    .eq("org_id", resolvedOrgId)
    .eq("id", target.templateId)
    .eq("updated_at", target.seenUpdatedAt ?? existing.updated_at)

  const { data, error } = await query.select(TEMPLATE_SELECT).maybeSingle()

  if (!error && !data) throw new Error(STALE_WRITE)
  if (error?.code === "23505") {
    throw new Error(`The library already has a template called "${parsed.name}"`)
  }
  if (error || !data) {
    throw new Error(`Failed to update condition template: ${error?.message}`)
  }
  const saved = mapTemplate(data)
  if (saved.id !== target.templateId || !isConfirmedTemplate(saved, expected)) {
    throw new Error("Updated template could not be confirmed. Reload before retrying.")
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "takeoff_condition_template",
    entityId: templateId,
    before: existing,
    after: data,
  })

  return saved
}

/**
 * Templates are a library, not a link. Conditions already created from one are
 * untouched — they were copied, not bound — so deleting is safe and needs no
 * cascade warning.
 */
export async function deleteConditionTemplate(
  templateId: string,
  orgId?: string,
  seenUpdatedAt?: string | null,
): Promise<void> {
  const target = conditionTemplateMutationTargetSchema.parse({ templateId, seenUpdatedAt })
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  let existingQuery = supabase
    .from("takeoff_condition_templates")
    .select(TEMPLATE_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", target.templateId)
  if (target.seenUpdatedAt) existingQuery = existingQuery.eq("updated_at", target.seenUpdatedAt)
  const { data: existing, error: existingError } = await existingQuery.maybeSingle()

  if (existingError) throw new Error(`Failed to load condition template: ${existingError.message}`)
  if (!existing && target.seenUpdatedAt) throw new Error(STALE_WRITE)
  if (!existing || existing.id !== target.templateId || existing.org_id !== resolvedOrgId) throw new Error("Condition template not found")
  if (typeof existing.updated_at !== "string") throw new Error("Template revision unavailable. Reload before retrying.")
  conditionTemplateMutationTargetSchema.parse({ templateId: existing.id, seenUpdatedAt: existing.updated_at })

  const { data, error } = await supabase
    .from("takeoff_condition_templates")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", target.templateId)
    .eq("updated_at", target.seenUpdatedAt ?? existing.updated_at)
    .select("id,org_id,updated_at")
    .maybeSingle()

  if (error) throw new Error(`Failed to delete condition template: ${error.message}`)
  if (!data) throw new Error(STALE_WRITE)
  if (data.id !== target.templateId || data.org_id !== resolvedOrgId || data.updated_at !== existing.updated_at) {
    throw new Error("Deleted template could not be confirmed. Reload before retrying.")
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "takeoff_condition_template",
    entityId: templateId,
    before: existing,
  })
}

// ============================================================================
// APPLY / HARVEST
// ============================================================================

export interface ApplyTemplatesResult {
  created: number
  /** Templates whose name already exists in this scope, reported not silently dropped. */
  skipped: string[]
  /** Templates that did not fit under the per-scope condition cap. */
  over_cap: string[]
}

/**
 * Copy templates into a takeoff scope as real conditions.
 *
 * A copy, not a link: once applied, the condition is the estimator's to edit
 * per job. Binding them would mean a library edit silently repricing a job
 * already out to bid.
 */
export async function applyConditionTemplates(
  input: ApplyConditionTemplatesInput,
  orgId?: string,
): Promise<ApplyTemplatesResult> {
  const parsed = applyConditionTemplatesSchema.parse(input)
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })
  await requireTakeoffWriteScope(context, parsed)

  const { data: templateRows, error: templateError } = await supabase
    .from("takeoff_condition_templates")
    .select(TEMPLATE_SELECT)
    .eq("org_id", resolvedOrgId)
    .in("id", parsed.template_ids)

  if (templateError) {
    throw new Error(`Failed to load condition templates: ${templateError.message}`)
  }
  const selectedIds = new Set(parsed.template_ids)
  if (
    !templateRows || templateRows.length !== selectedIds.size ||
    new Set(templateRows.map((row) => row.id)).size !== selectedIds.size ||
    templateRows.some((row) => !selectedIds.has(row.id) || row.org_id !== resolvedOrgId)
  ) {
    throw new Error("Selected templates unavailable or changed. Reload before retrying.")
  }
  const templates = templateRows.map(mapTemplate)

  const scopeColumn = parsed.project_id ? "project_id" : "house_plan_version_id"
  const scopeId = parsed.project_id ?? (parsed.house_plan_version_id as string)

  const [{ data: siblings, count: siblingCount, error: siblingError }] = await Promise.all([
    supabase.from("takeoff_conditions")
      .select("id, org_id, project_id, house_plan_version_id, name, color", { count: "exact" })
      .eq("org_id", resolvedOrgId).eq(scopeColumn, scopeId).limit(CONDITION_LIST_CAP + 1),
    requireTakeoffCostCodes(context, templates),
  ])

  if (
    siblingError || !siblings || typeof siblingCount !== "number" ||
    !Number.isSafeInteger(siblingCount) || siblingCount < 0 ||
    siblings.length !== Math.min(siblingCount, CONDITION_LIST_CAP + 1) ||
    new Set(siblings.map((row) => row.id)).size !== siblings.length ||
    siblings.some((row) => typeof row.id !== "string" || !row.id || row.org_id !== resolvedOrgId || row[scopeColumn] !== scopeId) ||
    siblings.some((row) => typeof row.name !== "string" || !row.name.trim() || typeof row.color !== "string" || !row.color)
  ) {
    throw new Error("Unable to verify existing takeoff conditions. Reload before retrying.")
  }

  const existingNames = new Set(
    siblings.map((row) => row.name.trim().toLowerCase()),
  )
  const usedColors = siblings.map((row) => row.color)
  let slotsLeft = CONDITION_LIST_CAP - siblingCount
  let sortOrder = siblingCount

  const result: ApplyTemplatesResult = { created: 0, skipped: [], over_cap: [] }
  const rows: Record<string, unknown>[] = []

  // Ordered by the caller's selection so the applied block reads the way the
  // library does, not the way Postgres returned it.
  const byId = new Map(templates.map((template) => [template.id, template]))
  for (const templateId of parsed.template_ids) {
    const template = byId.get(templateId)
    if (!template) throw new Error("Selected template unavailable. Reload before retrying.")

    if (existingNames.has(template.name.trim().toLowerCase())) {
      result.skipped.push(template.name)
      continue
    }
    if (slotsLeft <= 0) {
      result.over_cap.push(template.name)
      continue
    }

    // Color is identity on the sheet, so it is claimed from what this scope has
    // free rather than carried from the library — two templates that happen to
    // share a stored hue must not land as two indistinguishable overlays.
    const color = nextConditionColor(usedColors)
    usedColors.push(color)
    existingNames.add(template.name.trim().toLowerCase())
    slotsLeft -= 1

    rows.push({
      org_id: resolvedOrgId,
      project_id: parsed.project_id ?? null,
      house_plan_version_id: parsed.house_plan_version_id ?? null,
      name: template.name,
      uom: template.uom,
      depth_in: template.depth_in,
      height_ft: template.height_ft,
      pitch_rise: template.pitch_rise,
      tons_per_cy: template.tons_per_cy,
      cost_code_id: template.cost_code_id,
      color,
      waste_pct: template.waste_pct,
      // Rate resolution stays live: the pinned rate is only carried when the
      // library itself pinned one. Snapshotting the cost code's current default
      // here would quietly turn a live rate into a stale one.
      unit_cost_cents: template.unit_cost_cents,
      share_with_clients: template.share_with_clients,
      notes: template.notes,
      sort_order: sortOrder++,
      created_by: userId,
    })
  }

  if (rows.length > 0) {
    const { data, error } = await supabase
      .from("takeoff_conditions")
      .insert(rows)
      .select("id, name")
    if (error) throw new Error(`Failed to apply templates: ${error.message}`)
    if (
      !data || data.length !== rows.length || new Set(data.map((row) => row.id)).size !== rows.length ||
      data.some((row) => typeof row.id !== "string" || !row.id) ||
      data.some((row) => !rows.some((requested) => requested.name === row.name)) ||
      new Set(data.map((row) => row.name)).size !== rows.length
    ) {
      throw new Error("Applied conditions could not be confirmed. Reload before retrying.")
    }
    result.created = data.length

    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "takeoff_templates_applied",
      entityType: parsed.project_id ? "project" : "house_plan_version",
      entityId: scopeId,
      payload: { created: result.created, template_ids: parsed.template_ids },
    })
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "takeoff_condition_template",
    entityId: scopeId,
    after: { applied: result },
  })

  return result
}

export interface HarvestTemplatesResult {
  created: number
  /** Conditions whose name is already in the library. */
  skipped: string[]
}

/**
 * The reverse direction, and the only way a library ever gets its first rows:
 * an estimator finishes a real job and keeps the conditions they built.
 */
export async function saveConditionsAsTemplates(
  input: SaveConditionsAsTemplatesInput,
  orgId?: string,
): Promise<HarvestTemplatesResult> {
  const parsed = saveConditionsAsTemplatesSchema.parse(input)
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: conditionRows, error } = await supabase
    .from("takeoff_conditions")
    .select(
      "id, org_id, project_id, house_plan_version_id, name, uom, depth_in, height_ft, pitch_rise, tons_per_cy, cost_code_id, waste_pct, unit_cost_cents, share_with_clients, notes",
    )
    .eq("org_id", resolvedOrgId)
    .in("id", parsed.condition_ids)

  if (error) throw new Error(`Failed to load conditions: ${error.message}`)
  const selectedIds = new Set(parsed.condition_ids)
  if (
    !conditionRows || conditionRows.length !== selectedIds.size ||
    new Set(conditionRows.map((row) => row.id)).size !== selectedIds.size ||
    conditionRows.some((row) => !selectedIds.has(row.id) || row.org_id !== resolvedOrgId ||
      Boolean(row.project_id) === Boolean(row.house_plan_version_id))
  ) {
    throw new Error("Selected conditions unavailable or changed. Reload before retrying.")
  }

  const scopes = new Map<string, Pick<ApplyConditionTemplatesInput, "project_id" | "house_plan_version_id">>()
  for (const row of conditionRows) {
    const scope = { project_id: row.project_id, house_plan_version_id: row.house_plan_version_id }
    scopes.set(row.project_id ? `project:${row.project_id}` : `plan:${row.house_plan_version_id}`, scope)
  }
  // Selection is bounded to 200. Deduplicate homes and limit concurrent gates;
  // each mutation gate still uses the canonical, audit-logged authorization.
  const uniqueScopes = [...scopes.values()]
  for (let offset = 0; offset < uniqueScopes.length; offset += 10) {
    await Promise.all(uniqueScopes.slice(offset, offset + 10).map((scope) => requireTakeoffWriteScope(context, scope)))
  }
  await requireTakeoffCostCodes(context, conditionRows)

  const { data: library, count, error: libraryError } = await supabase
    .from("takeoff_condition_templates")
    .select("name", { count: "exact" })
    .eq("org_id", resolvedOrgId)
    .limit(TEMPLATE_LIST_CAP)

  const libraryCount = verifiedTemplateCount(count, libraryError)
  if (
    !library ||
    library.length !== Math.min(libraryCount, TEMPLATE_LIST_CAP) ||
    library.some((row) => typeof row.name !== "string" || !row.name.trim())
  ) {
    throw new Error("Unable to verify the template library names. Reload before retrying.")
  }

  const existingNames = new Set(
    library.map((row) => row.name.trim().toLowerCase()),
  )
  let slotsLeft = TEMPLATE_LIST_CAP - libraryCount
  let sortOrder = libraryCount

  const result: HarvestTemplatesResult = { created: 0, skipped: [] }
  const rows: Record<string, unknown>[] = []

  const byId = new Map(conditionRows.map((row) => [row.id, row]))
  for (const conditionId of parsed.condition_ids) {
    const row = byId.get(conditionId)
    if (!row) throw new Error("Selected condition unavailable. Reload before retrying.")
    for (const key of ["depth_in", "height_ft", "pitch_rise", "tons_per_cy"] as const) {
      const value = row[key]
      if (value !== null && value !== undefined &&
        ((typeof value !== "number" && typeof value !== "string") || numericOrNull(value) === null)) {
        throw new Error("Selected condition factors unavailable. Reload before retrying.")
      }
    }
    const source = createConditionTemplateSchema.parse({ ...mapTemplate(row), group_name: parsed.group_name })
    const name = source.name
    if (existingNames.has(name.toLowerCase()) || slotsLeft <= 0) {
      result.skipped.push(name)
      continue
    }
    existingNames.add(name.toLowerCase())
    slotsLeft -= 1
    rows.push({
      org_id: resolvedOrgId,
      name,
      uom: source.uom,
      depth_in: source.depth_in ?? null,
      height_ft: source.height_ft ?? null,
      pitch_rise: source.pitch_rise ?? null,
      tons_per_cy: source.tons_per_cy ?? null,
      cost_code_id: source.cost_code_id ?? null,
      // Color is deliberately not carried: it belongs to a sheet, not a library.
      color: null,
      waste_pct: source.waste_pct ?? 0,
      unit_cost_cents: source.unit_cost_cents ?? null,
      share_with_clients: source.share_with_clients ?? false,
      notes: source.notes ?? null,
      group_name: parsed.group_name?.trim() || null,
      sort_order: sortOrder++,
      created_by: userId,
    })
  }

  if (rows.length > 0) {
    const { data, error: insertError } = await supabase
      .from("takeoff_condition_templates")
      .insert(rows)
      .select(TEMPLATE_SELECT)
    if (insertError) {
      throw new Error(`Failed to save templates: ${insertError.message}`)
    }
    const requestedByName = new Map(rows.map((row) => [row.name, row]))
    const copiedKeys = [
      "org_id", "name", "uom", "depth_in", "height_ft", "pitch_rise", "tons_per_cy",
      "cost_code_id", "color", "waste_pct", "unit_cost_cents", "share_with_clients",
      "notes", "group_name", "sort_order", "created_by",
    ] as const
    if (
      !data || data.length !== rows.length || new Set(data.map((row) => row.id)).size !== rows.length ||
      new Set(data.map((row) => row.name)).size !== rows.length ||
      data.some((row) => typeof row.id !== "string" || !row.id || !requestedByName.has(row.name)) ||
      data.some((row) => {
        const requested = requestedByName.get(row.name)
        if (!requested) return true
        const saved = mapTemplate(row)
        return copiedKeys.some((key) => saved[key] !== requested[key])
      })
    ) {
      throw new Error("Saved templates could not be confirmed. Reload before retrying.")
    }
    result.created = data.length
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "takeoff_condition_template",
    entityId: resolvedOrgId,
    after: { harvested: result },
  })

  return result
}
