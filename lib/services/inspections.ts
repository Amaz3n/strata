import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { inspectionItemNeedsCorrection, inspectionReviewSource, inspectionCompletionResponseSchema, inspectionLifecycleInputSchema, inspectionLifecycleResponseSchema, inspectionObligationPageSchema } from "@/lib/inspections/lifecycle"
import { requireAuthorization } from "@/lib/services/authorization"
import { readAllRowsById } from "@/lib/land/paging"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { insertWithProjectNumberRetry } from "@/lib/services/project-sequence"
import { createPunchItemFromInspection } from "@/lib/services/punch-lists"
import { createObservation } from "@/lib/services/safety"
import { resolveProjectLocation } from "@/lib/services/locations"
import {
  checklistTemplateActiveSchema,
  checklistTemplateInputSchema,
  createInspectionSchema,
  inspectionDeficiencyActionSchema,
  inspectionItemResponseSchema,
  updateInspectionSchema,
  type ChecklistTemplateInput,
  type CreateInspectionInput,
  type InspectionDeficiencyActionInput,
  type InspectionItemResponseInput,
  type UpdateInspectionInput,
} from "@/lib/validation/inspections"

export type ChecklistTemplate = {
  id: string
  org_id: string
  name: string
  kind: "safety" | "quality"
  trade: string | null
  description: string | null
  is_active: boolean
  item_count: number
  created_at: string
}

export type ChecklistTemplateItem = {
  id: string
  template_id: string
  section: string | null
  prompt: string
  response_type: "pass_fail" | "yes_no" | "text" | "number"
  sort_order: number
}

export type Inspection = {
  id: string
  org_id: string
  project_id: string
  inspection_number: number
  template_id: string | null
  kind: "safety" | "quality"
  title: string
  status: "draft" | "in_progress" | "completed"
  result: "pass" | "fail" | "partial" | null
  inspected_at: string | null
  inspector_user_id: string | null
  inspector_name: string | null
  location: string | null
  location_id: string | null
  company_id: string | null
  company_name?: string | null
  schedule_item_id: string | null
  notes: string | null
  metadata: Record<string, unknown>
  deficient_count?: number
  created_at: string
  updated_at: string
}

export type InspectionItem = {
  id: string
  inspection_id: string
  section: string | null
  prompt: string
  response_type: "pass_fail" | "yes_no" | "text" | "number"
  response: string | null
  is_deficient: boolean
  note: string | null
  photo_file_id: string | null
  punch_item_id: string | null
  observation_id: string | null
  sort_order: number
}

export type InspectionDetail = Inspection & { items: InspectionItem[] }

const TEMPLATE_SELECT = "id, org_id, name, kind, trade, description, is_active, created_at, structured_form_items(count)"
const TEMPLATE_ITEM_SELECT = "id, template_id, section, prompt, response_type, sort_order"
const INSPECTION_SELECT =
  "id, org_id, project_id, inspection_number, template_id, kind, title, status, result, inspected_at, inspector_user_id, inspector_name, location, location_id, company_id, schedule_item_id, notes, metadata, created_at, updated_at, company:companies(name)"
const ITEM_SELECT =
  "id, inspection_id, section, prompt, response_type, response, is_deficient, note, photo_file_id, punch_item_id, observation_id, sort_order"

function mapTemplate(row: Record<string, any>): ChecklistTemplate {
  const { structured_form_items, ...rest } = row
  const countRow = Array.isArray(structured_form_items) ? structured_form_items[0] : structured_form_items
  return { ...rest, item_count: countRow?.count ?? 0 } as ChecklistTemplate
}

function mapInspection(row: Record<string, any>): Inspection {
  const { company, ...rest } = row
  const companyRow = Array.isArray(company) ? company[0] : company
  return { ...rest, company_name: companyRow?.name ?? null } as Inspection
}

// ---------------------------------------------------------------------------
// Template library (org-level)
// ---------------------------------------------------------------------------

export async function listChecklistTemplates(orgId?: string, options?: { includeInactive?: boolean }): Promise<ChecklistTemplate[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  let query = supabase
    .from("structured_form_templates")
    .select(TEMPLATE_SELECT)
    .eq("org_id", resolvedOrgId)
    .order("kind")
    .order("name")
  if (!options?.includeInactive) query = query.eq("is_active", true)
  const { data, error } = await query
  if (error) throw new Error(`Failed to load checklist templates: ${error.message}`)
  return (data ?? []).map(mapTemplate)
}

export async function listChecklistTemplateItems(templateId: string, orgId?: string): Promise<ChecklistTemplateItem[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("structured_form_items")
    .select(TEMPLATE_ITEM_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("template_id", templateId)
    .order("sort_order")
  if (error) throw new Error(`Failed to load template items: ${error.message}`)
  return (data ?? []) as ChecklistTemplateItem[]
}

export async function createChecklistTemplate(input: ChecklistTemplateInput, orgId?: string): Promise<ChecklistTemplate> {
  const parsed = checklistTemplateInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("inspection.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: template, error } = await supabase
    .from("structured_form_templates")
    .insert({
      org_id: resolvedOrgId,
      name: parsed.name,
      kind: parsed.kind,
      trade: parsed.trade ?? null,
      description: parsed.description ?? null,
    })
    .select("id, org_id, name, kind, trade, description, is_active, created_at")
    .single()
  if (error || !template) throw new Error(`Failed to create checklist template: ${error?.message}`)

  const { error: itemsError } = await supabase.from("structured_form_items").insert(
    parsed.items.map((item, index) => ({
      org_id: resolvedOrgId,
      template_id: template.id,
      section: item.section ?? null,
      prompt: item.prompt,
      response_type: item.response_type,
      sort_order: index,
    })),
  )
  if (itemsError) throw new Error(`Template created but items failed: ${itemsError.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "checklist_template", entityId: template.id, after: template })
  return { ...template, item_count: parsed.items.length } as ChecklistTemplate
}

export async function updateChecklistTemplate(templateId: string, input: ChecklistTemplateInput, orgId?: string): Promise<ChecklistTemplate> {
  const parsed = checklistTemplateInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("inspection.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing } = await supabase
    .from("structured_form_templates")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("id", templateId)
    .maybeSingle()
  if (!existing) throw new Error("Checklist template not found")

  const { data: template, error } = await supabase
    .from("structured_form_templates")
    .update({ name: parsed.name, kind: parsed.kind, trade: parsed.trade ?? null, description: parsed.description ?? null })
    .eq("org_id", resolvedOrgId)
    .eq("id", templateId)
    .select("id, org_id, name, kind, trade, description, is_active, created_at")
    .single()
  if (error || !template) throw new Error(`Failed to update checklist template: ${error?.message}`)

  // Replace items wholesale — running inspections snapshot their items, so
  // rewriting the template never touches history.
  const { error: deleteError } = await supabase
    .from("structured_form_items")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("template_id", templateId)
  if (deleteError) throw new Error(`Failed to update template items: ${deleteError.message}`)

  const { error: itemsError } = await supabase.from("structured_form_items").insert(
    parsed.items.map((item, index) => ({
      org_id: resolvedOrgId,
      template_id: templateId,
      section: item.section ?? null,
      prompt: item.prompt,
      response_type: item.response_type,
      sort_order: index,
    })),
  )
  if (itemsError) throw new Error(`Failed to update template items: ${itemsError.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "checklist_template", entityId: templateId, after: template })
  return { ...template, item_count: parsed.items.length } as ChecklistTemplate
}

export async function setChecklistTemplateActive(templateId: string, isActive: boolean, orgId?: string): Promise<void> {
  const parsed = checklistTemplateActiveSchema.parse({ templateId, isActive })
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("inspection.write", { supabase, orgId: resolvedOrgId, userId })
  const { data, error } = await supabase
    .from("structured_form_templates")
    .update({ is_active: parsed.isActive })
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.templateId)
    .select("id,is_active")
    .single()
  if (error || !data || data.id !== parsed.templateId || data.is_active !== parsed.isActive) {
    throw new Error("Checklist template unavailable or changed. Reload before retrying.")
  }
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "checklist_template", entityId: data.id, after: { is_active: data.is_active } })
}

// ---------------------------------------------------------------------------
// Starter template seed (mirrors the CSI cost-code seed hookup)
// ---------------------------------------------------------------------------

const STARTER_TEMPLATES: Array<{ name: string; kind: "safety" | "quality"; trade: string | null; description: string; items: Array<{ section?: string; prompt: string }> }> = [
  {
    name: "Site Safety Audit",
    kind: "safety",
    trade: null,
    description: "General jobsite walk covering PPE, housekeeping, and common exposures.",
    items: [
      { section: "PPE", prompt: "Hard hats, safety glasses, and high-visibility vests worn by all workers and visitors" },
      { section: "PPE", prompt: "Hearing and respiratory protection in use where required by task" },
      { section: "Site", prompt: "Site perimeter secured; signage posted at entrances" },
      { section: "Site", prompt: "Emergency contact info, first aid kit, and fire extinguishers accessible and charged" },
      { section: "Site", prompt: "SDS binder / safety data sheets available on site" },
      { section: "Housekeeping", prompt: "Walkways and stairs clear of debris, cords, and materials" },
      { section: "Electrical", prompt: "Temporary power on GFCI; cords undamaged and rated for use" },
      { section: "Ladders & Access", prompt: "Ladders inspected, rated, and used at correct angle; no top-step standing" },
      { section: "Fall Protection", prompt: "Openings and leading edges protected or workers tied off" },
      { section: "Equipment", prompt: "Operators certified for equipment in use; back-up alarms functional" },
      { section: "Excavation", prompt: "Trenches over 5 ft protected (sloped, benched, or shored) with ladder access" },
      { section: "Hot Work", prompt: "Hot work permits issued; fire watch posted where required" },
    ],
  },
  {
    name: "Fall Protection",
    kind: "safety",
    trade: null,
    description: "Focused audit for work at height.",
    items: [
      { prompt: "Written fall protection plan available for work above 6 ft" },
      { prompt: "Harnesses inspected before use; no cuts, burns, or deployed indicators" },
      { prompt: "Lanyards / SRLs compatible with anchors and inspected" },
      { prompt: "Anchor points rated 5,000 lb or engineered, and properly located" },
      { prompt: "Guardrail systems complete: top rail, mid rail, toe boards where required" },
      { prompt: "Floor and roof openings covered, secured, and labeled" },
      { prompt: "Leading edge work has warning lines or monitors per plan" },
      { prompt: "Scaffolds tagged, fully planked, with proper access and guardrails" },
      { prompt: "Aerial lift occupants tied off to manufacturer anchor points" },
      { prompt: "Rescue plan in place for suspended workers" },
    ],
  },
  {
    name: "Housekeeping",
    kind: "safety",
    trade: null,
    description: "Daily housekeeping standards walk.",
    items: [
      { prompt: "Work areas free of accumulated debris and packaging" },
      { prompt: "Protruding nails removed or bent; lumber stacked flat" },
      { prompt: "Materials staged out of walkways and staged to prevent tipping" },
      { prompt: "Dumpsters not overflowing; scheduled pickup adequate" },
      { prompt: "Cords and hoses routed overhead or covered at crossings" },
      { prompt: "Stairs and landings clear, lit, and handrails in place" },
      { prompt: "Flammable materials stored in approved containers away from ignition" },
      { prompt: "Dust control measures in place (sweeping compound, HEPA vac, wet cut)" },
      { prompt: "Break areas clean; water and sanitation facilities serviced" },
    ],
  },
  {
    name: "Pre-Pour Concrete",
    kind: "quality",
    trade: "Concrete",
    description: "Checklist before authorizing a concrete placement.",
    items: [
      { section: "Formwork", prompt: "Form dimensions, alignment, and elevations match structural drawings" },
      { section: "Formwork", prompt: "Forms braced, oiled, and tight; blockouts and sleeves located per plan" },
      { section: "Subgrade", prompt: "Subgrade compacted, tested where required, and free of standing water" },
      { section: "Subgrade", prompt: "Vapor barrier installed, lapped, and penetrations sealed" },
      { section: "Reinforcing", prompt: "Rebar size, spacing, and grade match structural drawings" },
      { section: "Reinforcing", prompt: "Chairs and bolsters provide specified clearances; laps and hooks per detail" },
      { section: "Embeds", prompt: "Anchor bolts, embed plates, and hold-downs located and secured per layout" },
      { section: "MEP", prompt: "Under-slab plumbing and electrical roughs inspected and protected" },
      { section: "Logistics", prompt: "Pour access, pump location, and finishing crew confirmed" },
      { section: "Logistics", prompt: "Weather forecast acceptable; cold/hot weather measures ready if needed" },
      { section: "Logistics", prompt: "Washout area designated and contained" },
      { section: "Approvals", prompt: "Required municipal / third-party pre-pour inspections signed off" },
    ],
  },
  {
    name: "Drywall Pre-Cover",
    kind: "quality",
    trade: "Drywall",
    description: "Verify everything in the wall before hanging board.",
    items: [
      { prompt: "Framing complete, plumb, and blocking installed for fixtures and accessories" },
      { prompt: "Rough plumbing, electrical, and mechanical inspections approved" },
      { prompt: "Nail plates installed where pipes/wires are within 1.25 in of framing edge" },
      { prompt: "Insulation installed to spec with no gaps or compression; vapor retarder correct" },
      { prompt: "Fireblocking and draftstopping complete at required locations" },
      { prompt: "In-wall backing for cabinets, TV mounts, and handrails documented with photos" },
      { prompt: "Shower/tub blocking and niches framed per plan" },
      { prompt: "Low-voltage, security, and AV rough-in complete and labeled" },
      { prompt: "HVAC ducts sealed and insulated where required" },
      { prompt: "Photo documentation of all walls captured before cover" },
    ],
  },
  {
    name: "MEP Rough-In",
    kind: "quality",
    trade: "MEP",
    description: "Combined mechanical, electrical, plumbing rough review.",
    items: [
      { section: "Plumbing", prompt: "Supply and waste piping supported at required intervals" },
      { section: "Plumbing", prompt: "Drainage slopes correct; cleanouts accessible" },
      { section: "Plumbing", prompt: "Water/air test holding on DWV and supply systems" },
      { section: "Electrical", prompt: "Box heights and locations match plans and ADA requirements" },
      { section: "Electrical", prompt: "Conductors sized per panel schedule; circuits labeled" },
      { section: "Electrical", prompt: "Penetrations through fire-rated assemblies firestopped" },
      { section: "Mechanical", prompt: "Duct runs match design; joints sealed with mastic or approved tape" },
      { section: "Mechanical", prompt: "Equipment clearances and condensate routing per manufacturer" },
      { section: "Coordination", prompt: "No trade conflicts at ceilings/soffits; RFIs resolved before cover" },
      { section: "Coordination", prompt: "As-built deviations marked on drawings" },
    ],
  },
]

/** Idempotent: skips seeding if the org already has any checklist templates. */
export async function seedChecklistTemplates(orgId?: string): Promise<number> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { count, error: countError } = await supabase
    .from("structured_form_templates")
    .select("id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)
  if (countError || count === null || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("Unable to verify the checklist library before seeding. Try again after it reloads.")
  }
  if (count > 0) return 0

  for (const template of STARTER_TEMPLATES) {
    const { data: created, error } = await supabase
      .from("structured_form_templates")
      .insert({
        org_id: resolvedOrgId,
        name: template.name,
        kind: template.kind,
        trade: template.trade,
        description: template.description,
      })
      .select("id")
      .single()
    if (error || !created) throw new Error(`Failed to seed checklist templates: ${error?.message}`)

    const { error: itemsError } = await supabase.from("structured_form_items").insert(
      template.items.map((item, index) => ({
        org_id: resolvedOrgId,
        template_id: created.id,
        section: item.section ?? null,
        prompt: item.prompt,
        response_type: "pass_fail",
        sort_order: index,
      })),
    )
    if (itemsError) throw new Error(`Failed to seed checklist template items: ${itemsError.message}`)
  }

  return STARTER_TEMPLATES.length
}

// ---------------------------------------------------------------------------
// Inspections
// ---------------------------------------------------------------------------

export async function listInspections(projectId: string, orgId?: string): Promise<Inspection[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const [{ data, error }, { data: deficientRows }] = await Promise.all([
    supabase
      .from("inspections")
      .select(INSPECTION_SELECT)
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .order("inspection_number", { ascending: false })
      .limit(250),
    supabase
      .from("inspection_items")
      .select("inspection_id")
      .eq("org_id", resolvedOrgId)
      .eq("is_deficient", true),
  ])
  if (error) throw new Error(`Failed to load inspections: ${error.message}`)
  const deficientCounts = new Map<string, number>()
  for (const row of deficientRows ?? []) {
    deficientCounts.set(row.inspection_id, (deficientCounts.get(row.inspection_id) ?? 0) + 1)
  }
  return (data ?? []).map((row) => ({ ...mapInspection(row), deficient_count: deficientCounts.get(row.id) ?? 0 }))
}

export async function getInspection(inspectionId: string, orgId?: string): Promise<InspectionDetail> {
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId } = context
  const { data: inspection, error } = await supabase.from("inspections").select(INSPECTION_SELECT)
    .eq("org_id", resolvedOrgId).eq("id", inspectionId).single()
  if (error || !inspection) throw new Error("Inspection not found")
  await requireAuthorization({ ...context, permission: "project.read", projectId: inspection.project_id,
    resourceType: "inspection", resourceId: inspectionId, logDecision: true })
  const items = await readAllRowsById<InspectionItem>((afterId, limit) => {
    let query = supabase.from("inspection_items").select(ITEM_SELECT).eq("org_id", resolvedOrgId)
      .eq("inspection_id", inspectionId).order("id").limit(limit)
    if (afterId) query = query.gt("id", afterId)
    return query.returns<InspectionItem[]>()
  }, { cap: 10_000, label: "Unable to read inspection checklist" })
  items.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
  return { ...mapInspection(inspection), items }
}

/** The inspection linked to a scheduled Gantt slot, if one has been started. */
export async function getInspectionForScheduleItem(scheduleItemId: string, orgId?: string): Promise<Inspection | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("inspections")
    .select(INSPECTION_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("schedule_item_id", scheduleItemId)
    .order("inspection_number", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to load linked inspection: ${error.message}`)
  return data ? mapInspection(data) : null
}

export async function createInspection(input: CreateInspectionInput, orgId?: string): Promise<InspectionDetail> {
  const parsed = createInspectionSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("inspection.write", { supabase, orgId: resolvedOrgId, userId })
  const location = await resolveProjectLocation(parsed.project_id, parsed.location_id, resolvedOrgId)

  if (parsed.schedule_item_id) {
    const { data: scheduleItem } = await supabase
      .from("schedule_items")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", parsed.project_id)
      .eq("id", parsed.schedule_item_id)
      .maybeSingle()
    if (!scheduleItem) throw new Error("Scheduled item not found for this project")
  }

  let templateItems: ChecklistTemplateItem[] = []
  if (parsed.template_id) {
    templateItems = await listChecklistTemplateItems(parsed.template_id, resolvedOrgId)
    if (templateItems.length === 0) throw new Error("Selected template has no items")
  }

  const { data: userRow } = await supabase.from("app_users").select("full_name").eq("id", userId).maybeSingle()

  const { data: inspection } = await insertWithProjectNumberRetry<Record<string, any>>({
    supabase,
    table: "inspections",
    numberColumn: "inspection_number",
    rpcName: "next_inspection_number",
    conflictConstraint: "inspections_project_id_inspection_number_key",
    projectId: parsed.project_id,
    payload: {
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      template_id: parsed.template_id ?? null,
      kind: parsed.kind,
      title: parsed.title,
      status: "in_progress",
      location_id: location?.id ?? null,
      location: location?.full_path ?? parsed.location ?? null,
      company_id: parsed.company_id ?? null,
      schedule_item_id: parsed.schedule_item_id ?? null,
      inspector_user_id: userId,
      inspector_name: userRow?.full_name ?? null,
      inspected_at: new Date().toISOString(),
    },
    select: INSPECTION_SELECT,
    entityLabel: "inspection",
  })

  if (templateItems.length > 0) {
    const { error: itemsError } = await supabase.from("inspection_items").insert(
      templateItems.map((item, index) => ({
        org_id: resolvedOrgId,
        inspection_id: inspection.id,
        section: item.section,
        prompt: item.prompt,
        response_type: item.response_type,
        sort_order: index,
      })),
    )
    if (itemsError) throw new Error(`Inspection created but checklist items failed: ${itemsError.message}`)
  }

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "inspection", entityId: inspection.id, after: inspection })
  return getInspection(inspection.id as string, resolvedOrgId)
}

export type InspectionSnapshotInput = {
  projectId: string
  kind: "safety" | "quality"
  title: string
  sourceTemplateId?: string | null
  /** A release's place for this checklist on the home (`checklist:<n>`), unique per home. */
  releaseKey?: string
  items: Array<{
    section?: string | null
    prompt: string
    response_type?: "pass_fail" | "yes_no" | "text" | "number"
    sort_order?: number
  }>
}

/** Seeds a draft inspection from pinned plan-version content without re-reading a live template. */
export async function createInspectionFromSnapshot(
  input: InspectionSnapshotInput,
  orgId?: string,
  authorizationPermission: "inspection.write" | "plan.instantiate" = "inspection.write",
): Promise<InspectionDetail> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission(authorizationPermission, { supabase, orgId: resolvedOrgId, userId })
  if (!input.title.trim()) throw new Error("Inspection title is required")
  if (input.items.length === 0) throw new Error(`Checklist ${input.title} has no items`)
  const { data: inspection } = await insertWithProjectNumberRetry<Record<string, unknown>>({
    supabase,
    table: "inspections",
    numberColumn: "inspection_number",
    rpcName: "next_inspection_number",
    conflictConstraint: "inspections_project_id_inspection_number_key",
    projectId: input.projectId,
    payload: {
      org_id: resolvedOrgId,
      project_id: input.projectId,
      template_id: null,
      kind: input.kind,
      title: input.title.trim(),
      status: "draft",
      metadata: { source_template_id: input.sourceTemplateId ?? null, source: "plan_version_snapshot", ...(input.releaseKey ? { release_key: input.releaseKey } : {}) },
    },
    select: INSPECTION_SELECT,
    entityLabel: "inspection",
  })
  const inspectionId = String(inspection.id)
  const { error } = await supabase.from("inspection_items").insert(input.items.map((item, index) => ({
    org_id: resolvedOrgId,
    inspection_id: inspectionId,
    section: item.section ?? null,
    prompt: item.prompt,
    response_type: item.response_type ?? "pass_fail",
    sort_order: item.sort_order ?? index,
  })))
  if (error) throw new Error(`Inspection created but snapshot items failed: ${error.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "inspection", entityId: inspectionId, after: inspection })
  return getInspection(inspectionId, resolvedOrgId)
}

export async function updateInspection(inspectionId: string, input: UpdateInspectionInput, orgId?: string): Promise<Inspection> {
  const parsed = updateInspectionSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("inspection.write", { supabase, orgId: resolvedOrgId, userId })

  const updateData: Record<string, unknown> = {}
  if (parsed.title !== undefined) updateData.title = parsed.title
  if (parsed.location_id !== undefined) {
    const { data: existing } = await supabase.from("inspections").select("project_id").eq("org_id", resolvedOrgId).eq("id", inspectionId).maybeSingle()
    if (!existing) throw new Error("Inspection not found")
    const location = await resolveProjectLocation(existing.project_id, parsed.location_id, resolvedOrgId)
    updateData.location_id = location?.id ?? null
    updateData.location = location?.full_path ?? null
  } else if (parsed.location !== undefined) updateData.location = parsed.location
  if (parsed.company_id !== undefined) updateData.company_id = parsed.company_id
  if (parsed.inspector_name !== undefined) updateData.inspector_name = parsed.inspector_name
  if (parsed.notes !== undefined) updateData.notes = parsed.notes

  const { data, error } = await supabase
    .from("inspections")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", inspectionId)
    .select(INSPECTION_SELECT)
    .single()
  if (error || !data) throw new Error(`Failed to update inspection: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "inspection", entityId: inspectionId, after: data })
  return mapInspection(data)
}

export async function updateInspectionItem(
  inspectionItemId: string,
  input: InspectionItemResponseInput,
  orgId?: string,
): Promise<InspectionItem> {
  const parsed = inspectionItemResponseSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("inspection.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing } = await supabase
    .from("inspection_items")
    .select("id, inspection_id, response_type")
    .eq("org_id", resolvedOrgId)
    .eq("id", inspectionItemId)
    .maybeSingle()
  if (!existing) throw new Error("Inspection item not found")
  const parent = await getInspection(existing.inspection_id, resolvedOrgId)
  await requireAuthorization({ supabase, orgId: resolvedOrgId, userId, permission: "inspection.write",
    projectId: parent.project_id, resourceType: "inspection", resourceId: parent.id, logDecision: true })
  if (parent.status === "completed") throw new Error("Completed inspection evidence is read-only; record corrections in a new inspection")

  const updateData: Record<string, unknown> = {}
  if (parsed.response !== undefined) {
    updateData.response = parsed.response
    // Deficiency defaults from the response for pass/fail and yes/no prompts;
    // an explicit is_deficient flag always wins (e.g. "no" that's acceptable).
    if (parsed.is_deficient === undefined) {
      updateData.is_deficient = parsed.response === "fail" || (existing.response_type === "yes_no" && parsed.response === "no")
    }
  }
  if (parsed.is_deficient !== undefined) updateData.is_deficient = parsed.is_deficient
  if (parsed.note !== undefined) updateData.note = parsed.note
  if (parsed.photo_file_id !== undefined) updateData.photo_file_id = parsed.photo_file_id

  const { data, error } = await supabase
    .from("inspection_items")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", inspectionItemId)
    .eq("inspection_id", parent.id)
    .select(ITEM_SELECT)
    .single()
  if (error || !data) throw new Error(`Failed to update inspection item: ${error?.message}`)
  return data as InspectionItem
}

export async function completeInspection(inspectionId: string, orgId?: string): Promise<InspectionDetail> {
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await requirePermission("inspection.write", context)
  const detail = await getInspection(inspectionId, resolvedOrgId)
  await requireAuthorization({ ...context, permission: "inspection.write", projectId: detail.project_id,
    resourceType: "inspection", resourceId: inspectionId, logDecision: true })
  const { data, error } = await supabase.rpc("complete_inspection_attempt", {
    p_org: resolvedOrgId, p_home: detail.project_id, p_id: inspectionId, p_actor: userId,
    p_source: inspectionReviewSource(detail),
  })
  if (error) throw new Error(`Unable to complete inspection attempt: ${error.message}`)
  const receipt = inspectionCompletionResponseSchema.parse(data)
  if (receipt.inspectionId !== detail.id) throw new Error("Inspection completion returned another attempt")
  const recorded = await getInspection(inspectionId, resolvedOrgId)
  return recorded.result === "fail" ? raiseCorrectiveWorkForFailedItems(recorded, context) : recorded
}

/**
 * Spawns a punch item from a deficient checklist item. The punch item inherits
 * the photo, location, and description; assigning a company dispatches it to
 * the sub portal like any other punch item.
 */
export async function createPunchItemFromInspectionItem(
  inspectionItemId: string,
  input: InspectionDeficiencyActionInput,
  orgId?: string,
): Promise<InspectionItem> {
  const parsed = inspectionDeficiencyActionSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("inspection.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: item } = await supabase
    .from("inspection_items")
    .select(`${ITEM_SELECT}, inspection:inspections(id, project_id, title, location, location_id, kind)`)
    .eq("org_id", resolvedOrgId)
    .eq("id", inspectionItemId)
    .maybeSingle()
  if (!item) throw new Error("Inspection item not found")
  if (item.punch_item_id) throw new Error("This item already has a punch item")

  const inspection = Array.isArray(item.inspection) ? item.inspection[0] : item.inspection
  if (!inspection) throw new Error("Inspection not found")
  const parent = await getInspection(item.inspection_id, resolvedOrgId)
  await requireAuthorization({ supabase, orgId: resolvedOrgId, userId, permission: "inspection.write", projectId: parent.project_id, logDecision: true })
  if (parent.id !== inspection.id || parent.project_id !== inspection.project_id) throw new Error("Inspection corrective work ancestry changed")
  if (!inspectionItemNeedsCorrection(item)) throw new Error("Corrective punch work requires a deficient inspection item")

  return raiseCorrectivePunch(
    { supabase, orgId: resolvedOrgId, userId },
    { id: inspection.id, project_id: inspection.project_id, title: inspection.title, location: inspection.location, location_id: inspection.location_id, company_id: parent.company_id },
    item,
    { companyId: parsed.company_id ?? null, assignedTo: null, dueDate: parsed.due_date ?? null },
  )
}

type CorrectivePunchOwner = { companyId: string | null; assignedTo: string | null; dueDate: string | null }

/**
 * Corrective work always has an owner: the company chosen for it, else the
 * company that performed the inspected work, else the named person. Work with
 * no one responsible for it is refused rather than left to sit unassigned. The
 * item requires verification, so it closes only on an "after" photo or file.
 */
async function raiseCorrectivePunch(
  context: { supabase: SupabaseClient; orgId: string; userId: string },
  inspection: { id: string; project_id: string; title: string; location: string | null; location_id: string | null; company_id: string | null },
  item: InspectionItem,
  owner: CorrectivePunchOwner,
): Promise<InspectionItem> {
  const { supabase, orgId, userId } = context
  const companyId = owner.companyId ?? (owner.assignedTo ? null : inspection.company_id)
  if (!companyId && !owner.assignedTo) throw new Error("Choose the company or person responsible for this corrective work")

  const punchItem = await createPunchItemFromInspection(context, inspection.project_id, {
    title: item.prompt,
    description: [item.note, `From inspection: ${inspection.title}`].filter(Boolean).join("\n"),
    location: inspection.location ?? null,
    location_id: inspection.location_id ?? null,
    due_date: owner.dueDate,
    assigned_company_id: companyId,
    assigned_to: owner.assignedTo,
    verification_required: true,
  }, inspection.id)

  const { data: updated, error: updateError } = await supabase
    .from("inspection_items")
    .update({ punch_item_id: punchItem.id })
    .eq("org_id", orgId)
    .eq("id", item.id)
    .is("punch_item_id", null)
    .select(ITEM_SELECT)
    .single()
  if (updateError || !updated) throw new Error(`Punch item created but link failed: ${updateError?.message ?? "Inspection item already has a punch item"}`)

  if (item.photo_file_id) {
    const { error: linkError } = await supabase.from("file_links").insert({
      org_id: orgId,
      project_id: inspection.project_id,
      file_id: item.photo_file_id,
      entity_type: "punch_item",
      entity_id: punchItem.id,
      link_role: "before",
      created_by: userId,
    })
    if (linkError) throw new Error(`Punch item created but the inspection photo could not be attached: ${linkError.message}`)
  }
  return updated as InspectionItem
}

/**
 * A failed checklist item gets its corrective punch work the moment the
 * inspection is recorded, not when someone remembers to raise it. Idempotent:
 * items that already have corrective work are left alone, so a retry after a
 * partial failure only creates what is missing.
 */
async function raiseCorrectiveWorkForFailedItems(
  detail: InspectionDetail,
  context: Awaited<ReturnType<typeof requireOrgContext>>,
): Promise<InspectionDetail> {
  const pending = detail.items.filter((item) => inspectionItemNeedsCorrection(item) && !item.punch_item_id)
  if (!pending.length) return detail
  const raised = new Map<string, InspectionItem>()
  for (const item of pending) {
    try {
      raised.set(item.id, await raiseCorrectivePunch(context, detail, item, { companyId: detail.company_id, assignedTo: detail.company_id ? null : context.userId, dueDate: null }))
    } catch (error) {
      throw new Error(`Inspection is recorded; retry completing it to raise the remaining corrective work: ${error instanceof Error ? error.message : "Unknown error"}`)
    }
  }
  return { ...detail, items: detail.items.map((item) => raised.get(item.id) ?? item) }
}

/** Spawns an observation from a deficient checklist item (Part 2 of the doc). */
export async function createObservationFromInspectionItem(
  inspectionItemId: string,
  input: InspectionDeficiencyActionInput,
  orgId?: string,
): Promise<InspectionItem> {
  const parsed = inspectionDeficiencyActionSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("inspection.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: item } = await supabase
    .from("inspection_items")
    .select(`${ITEM_SELECT}, inspection:inspections(id, project_id, title, location, location_id, kind)`)
    .eq("org_id", resolvedOrgId)
    .eq("id", inspectionItemId)
    .maybeSingle()
  if (!item) throw new Error("Inspection item not found")
  if (item.observation_id) throw new Error("This item already has an observation")

  const inspection = Array.isArray(item.inspection) ? item.inspection[0] : item.inspection
  if (!inspection) throw new Error("Inspection not found")
  const parent = await getInspection(item.inspection_id, resolvedOrgId)
  await requireAuthorization({ supabase, orgId: resolvedOrgId, userId, permission: "inspection.write", projectId: parent.project_id, logDecision: true })
  if (parent.id !== inspection.id || parent.project_id !== inspection.project_id) throw new Error("Inspection observation ancestry changed")

  const observation = await createObservation(
    {
      project_id: inspection.project_id,
      kind: inspection.kind,
      category: "deficiency",
      description: [item.prompt, item.note].filter(Boolean).join(" — "),
      location: inspection.location ?? null,
      location_id: inspection.location_id ?? null,
      company_id: parsed.company_id ?? null,
      photo_file_id: item.photo_file_id ?? null,
      due_date: parsed.due_date ?? null,
    },
    resolvedOrgId,
  )

  const { data: updated, error: updateError } = await supabase
    .from("inspection_items")
    .update({ observation_id: observation.id })
    .eq("org_id", resolvedOrgId)
    .eq("id", inspectionItemId)
    .select(ITEM_SELECT)
    .single()
  if (updateError || !updated) throw new Error(`Observation created but link failed: ${updateError?.message}`)
  return updated as InspectionItem
}

/** Required inspections of a home: each obligation with its attempts, newest page first. */
export async function listInspectionObligations(projectId: string, after?: string, orgId?: string, inspectionId?: string) {
  z.string().uuid().parse(projectId)
  if (after) z.string().uuid().parse(after)
  if (inspectionId) z.string().uuid().parse(inspectionId)
  const context = await requireOrgContext(orgId)
  await requireAuthorization({ ...context, permission: "project.read", projectId, logDecision: true })
  const { data, error } = await context.supabase.rpc("read_inspection_obligations", { p_org: context.orgId, p_home: projectId, p_actor: context.userId, p_after: after ?? null, p_limit: 20, p_inspection: inspectionId ?? null })
  if (error) throw new Error(`Unable to read required inspections: ${error.message}`)
  const page = inspectionObligationPageSchema.parse(data)
  if (page.rows.some(row => row.org_id !== context.orgId || row.project_id !== projectId)) throw new Error("Required inspection scope differs from the current home")
  return page
}

export async function mutateInspectionObligation(projectId: string, input: unknown, orgId?: string) {
  z.string().uuid().parse(projectId)
  const parsed = inspectionLifecycleInputSchema.parse(input)
  if (parsed.request.source.project_id !== projectId || parsed.request.source.id !== parsed.request.inspectionId) throw new Error("Inspection request source belongs to another home or attempt")
  const context = await requireOrgContext(orgId)
  await requirePermission(parsed.request.operation === "accept" || parsed.request.operation === "reject" ? "inspection.review" : "inspection.write", context)
  await requireAuthorization({ ...context, permission: parsed.request.operation === "accept" || parsed.request.operation === "reject" ? "inspection.review" : "inspection.write", projectId, logDecision: true })
  const { data, error } = await context.supabase.rpc("mutate_inspection_obligation", { p_org: context.orgId, p_home: projectId, p_actor: context.userId, p_key: parsed.key, p_request: parsed.request })
  if (error) {
    const failure = new Error(`Unable to update required inspection: ${error.message}`) as Error & { code?: string }
    // A PostgreSQL error aborts this RPC statement; transport failures do not
    // establish an uncommitted outcome and retain the original request in UI.
    if (/^[A-Z0-9]{5}$/.test(error.code)) failure.code = "INSPECTION_NOT_COMMITTED"
    throw failure
  }
  return inspectionLifecycleResponseSchema.parse(data)
}
