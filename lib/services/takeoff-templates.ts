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
import { nextConditionColor } from "@/lib/drawings/takeoff-palette"
import type { ConditionUom } from "@/lib/drawings/measure"
import {
  applyConditionTemplatesSchema,
  createConditionTemplateSchema,
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

// ============================================================================
// CRUD
// ============================================================================

export async function listConditionTemplates(orgId?: string): Promise<ConditionTemplate[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.read", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("takeoff_condition_templates")
    .select(TEMPLATE_SELECT)
    .eq("org_id", resolvedOrgId)
    .order("group_name", { ascending: true, nullsFirst: false })
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
    .limit(TEMPLATE_LIST_CAP)

  if (error) throw new Error(`Failed to list condition templates: ${error.message}`)
  return (data ?? []).map(mapTemplate)
}

/** The distinct group headings in use, for the editor's combobox. */
export async function listTemplateGroups(orgId?: string): Promise<string[]> {
  const templates = await listConditionTemplates(orgId)
  const groups = new Set<string>()
  for (const template of templates) {
    if (template.group_name) groups.add(template.group_name)
  }
  return Array.from(groups).sort((a, b) => a.localeCompare(b))
}

export async function createConditionTemplate(
  input: CreateConditionTemplateInput,
  orgId?: string,
): Promise<ConditionTemplate> {
  const parsed = createConditionTemplateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  const { count } = await supabase
    .from("takeoff_condition_templates")
    .select("id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)
  if ((count ?? 0) >= TEMPLATE_LIST_CAP) {
    throw new Error(`The library holds at most ${TEMPLATE_LIST_CAP} templates`)
  }

  const { data, error } = await supabase
    .from("takeoff_condition_templates")
    .insert({
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
      sort_order: count ?? 0,
      created_by: userId,
    })
    .select(TEMPLATE_SELECT)
    .single()

  if (error?.code === "23505") {
    throw new Error(`The library already has a template called "${parsed.name}"`)
  }
  if (error || !data) {
    throw new Error(`Failed to create condition template: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "takeoff_condition_template",
    entityId: data.id as string,
    after: data,
  })

  return mapTemplate(data)
}

export async function updateConditionTemplate(
  templateId: string,
  updates: UpdateConditionTemplateInput,
  orgId?: string,
  seenUpdatedAt?: string | null,
): Promise<ConditionTemplate> {
  const parsed = updateConditionTemplateSchema.parse(updates)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing } = await supabase
    .from("takeoff_condition_templates")
    .select(TEMPLATE_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", templateId)
    .maybeSingle()

  if (!existing) throw new Error("Condition template not found")

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
  const violation = factorRuleViolation({ ...mapTemplate(existing), ...payload } as any)
  if (violation) throw new Error(violation)

  let query = supabase
    .from("takeoff_condition_templates")
    .update(payload)
    .eq("org_id", resolvedOrgId)
    .eq("id", templateId)
  if (seenUpdatedAt) query = query.eq("updated_at", seenUpdatedAt)

  const { data, error } = await query.select(TEMPLATE_SELECT).maybeSingle()

  if (!error && !data && seenUpdatedAt) throw new Error(STALE_WRITE)
  if (error?.code === "23505") {
    throw new Error(`The library already has a template called "${parsed.name}"`)
  }
  if (error || !data) {
    throw new Error(`Failed to update condition template: ${error?.message}`)
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

  return mapTemplate(data)
}

/**
 * Templates are a library, not a link. Conditions already created from one are
 * untouched — they were copied, not bound — so deleting is safe and needs no
 * cascade warning.
 */
export async function deleteConditionTemplate(
  templateId: string,
  orgId?: string,
): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing } = await supabase
    .from("takeoff_condition_templates")
    .select(TEMPLATE_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", templateId)
    .maybeSingle()

  if (!existing) throw new Error("Condition template not found")

  const { error } = await supabase
    .from("takeoff_condition_templates")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", templateId)

  if (error) throw new Error(`Failed to delete condition template: ${error.message}`)

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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: templateRows, error: templateError } = await supabase
    .from("takeoff_condition_templates")
    .select(TEMPLATE_SELECT)
    .eq("org_id", resolvedOrgId)
    .in("id", parsed.template_ids)

  if (templateError) {
    throw new Error(`Failed to load condition templates: ${templateError.message}`)
  }
  const templates = (templateRows ?? []).map(mapTemplate)
  if (templates.length === 0) throw new Error("No templates to apply")

  const scopeColumn = parsed.project_id ? "project_id" : "house_plan_version_id"
  const scopeId = parsed.project_id ?? (parsed.house_plan_version_id as string)

  const { data: siblings } = await supabase
    .from("takeoff_conditions")
    .select("name, color")
    .eq("org_id", resolvedOrgId)
    .eq(scopeColumn, scopeId)
    .limit(CONDITION_LIST_CAP + 1)

  const existingNames = new Set(
    (siblings ?? []).map((row: any) => String(row.name).trim().toLowerCase()),
  )
  const usedColors = (siblings ?? []).map((row: any) => row.color as string)
  let slotsLeft = CONDITION_LIST_CAP - (siblings?.length ?? 0)
  let sortOrder = siblings?.length ?? 0

  const result: ApplyTemplatesResult = { created: 0, skipped: [], over_cap: [] }
  const rows: Record<string, unknown>[] = []

  // Ordered by the caller's selection so the applied block reads the way the
  // library does, not the way Postgres returned it.
  const byId = new Map(templates.map((template) => [template.id, template]))
  for (const templateId of parsed.template_ids) {
    const template = byId.get(templateId)
    if (!template) continue

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
    result.created = data?.length ?? 0

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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: conditionRows, error } = await supabase
    .from("takeoff_conditions")
    .select(
      "id, name, uom, depth_in, height_ft, pitch_rise, tons_per_cy, cost_code_id, waste_pct, unit_cost_cents, share_with_clients, notes",
    )
    .eq("org_id", resolvedOrgId)
    .in("id", parsed.condition_ids)

  if (error) throw new Error(`Failed to load conditions: ${error.message}`)
  if (!conditionRows || conditionRows.length === 0) {
    throw new Error("No conditions to save")
  }

  const { data: library, count } = await supabase
    .from("takeoff_condition_templates")
    .select("name", { count: "exact" })
    .eq("org_id", resolvedOrgId)
    .limit(TEMPLATE_LIST_CAP)

  const existingNames = new Set(
    (library ?? []).map((row: any) => String(row.name).trim().toLowerCase()),
  )
  let slotsLeft = TEMPLATE_LIST_CAP - (count ?? 0)
  let sortOrder = count ?? 0

  const result: HarvestTemplatesResult = { created: 0, skipped: [] }
  const rows: Record<string, unknown>[] = []

  for (const row of conditionRows) {
    const name = String(row.name).trim()
    if (existingNames.has(name.toLowerCase()) || slotsLeft <= 0) {
      result.skipped.push(name)
      continue
    }
    existingNames.add(name.toLowerCase())
    slotsLeft -= 1
    rows.push({
      org_id: resolvedOrgId,
      name,
      uom: row.uom,
      depth_in: row.depth_in,
      height_ft: row.height_ft,
      pitch_rise: row.pitch_rise,
      tons_per_cy: row.tons_per_cy,
      cost_code_id: row.cost_code_id,
      // Color is deliberately not carried: it belongs to a sheet, not a library.
      color: null,
      waste_pct: row.waste_pct,
      unit_cost_cents: row.unit_cost_cents,
      share_with_clients: row.share_with_clients,
      notes: row.notes,
      group_name: parsed.group_name?.trim() || null,
      sort_order: sortOrder++,
      created_by: userId,
    })
  }

  if (rows.length > 0) {
    const { data, error: insertError } = await supabase
      .from("takeoff_condition_templates")
      .insert(rows)
      .select("id")
    if (insertError) {
      throw new Error(`Failed to save templates: ${insertError.message}`)
    }
    result.created = data?.length ?? 0
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
