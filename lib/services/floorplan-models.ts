import "server-only"

/**
 * Floorplan models — interpreting a plan version's sheets into a walkable 3D
 * model, correcting it, and publishing it.
 *
 * Where the sheets come from is the one non-obvious decision here. Plans do
 * not own drawing sheets: `queuePlanDrawings` copies a released version's plan
 * PDF into a PROJECT's canonical drawing set and pipelines it there, tagging
 * the copy with `files.metadata.source_plan_version_id`. Rather than forking
 * the pipeline to run a second time under a plan-scoped path — which would
 * mean a second render, a second tile pyramid, and a `drawing_sets` row with
 * no project — this service follows that tag back: any project set produced
 * from this plan version's PDF is an interpretation source, and the RESULT is
 * stored on the plan version, so it serves every lot built to the plan.
 *
 * The consequence, surfaced honestly in the UI: a plan version whose PDF has
 * never been pipelined has nothing to interpret yet.
 */

import {
  interpretFloorplan,
  selectFloorplanSheets,
  type InterpretLevelInput,
  type SelectedSheet,
  type SheetCandidate,
} from "@/lib/drawings/floorplan-interpret"
import {
  modelConfidence,
  modelFloorAreaSqft,
  applyFloorplanEdit,
  type FloorplanEdit,
  type FloorplanModel,
} from "@/lib/drawings/floorplan-model"
import { parseVectorsBin } from "@/lib/drawings/vector-snap"
import { parseTextRuns, TEXT_RUNS_FILE, type TextRun } from "@/lib/drawings/text-runs"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { drawingsVisionConfigured } from "@/lib/services/drawings-pipeline"
import { assistFloorplanModelWithVision } from "@/lib/services/floorplan-vision-assist"
import { recordEvent } from "@/lib/services/events"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { requirePermission } from "@/lib/services/permissions"
import { downloadTilesObject } from "@/lib/storage/drawings-tiles-storage"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { floorplanEditsSchema, floorplanModelSchema } from "@/lib/validation/floorplan"

/** Bump when interpretation changes in a way that should re-run on existing plans. */
// 2: perimeter-gap bridging, filled-face pairing boost, vision assist.
export const FLOORPLAN_ALGO_VERSION = 2

export const FLOORPLAN_INTERPRET_JOB = "interpret_floorplan"

export type FloorplanModelStatus = "processing" | "draft" | "published" | "failed"

/**
 * What a model hangs off.
 *
 * Two anchors, because two postures answer "which house is this?" differently.
 * A production builder interprets a PLAN VERSION once and every lot built to
 * it inherits the result — that is the whole leverage. A custom home has no
 * plan version; its floorplan sheets live on the PROJECT's own drawing set,
 * and interpreting it serves exactly one house because there is exactly one.
 *
 * Everything downstream of this type is posture-blind: the interpreter, the
 * review UI, the geometry build and the viewer never learn which anchor they
 * came from. Only sheet SOURCING and the surface differ.
 */
export type FloorplanTarget =
  | { kind: "plan"; housePlanVersionId: string }
  | { kind: "project"; projectId: string }

/** The column/value pair an anchor filters and writes on. */
function anchorColumn(target: FloorplanTarget): { column: string; value: string } {
  return target.kind === "plan"
    ? { column: "house_plan_version_id", value: target.housePlanVersionId }
    : { column: "project_id", value: target.projectId }
}

/** Stable string form, for outbox dedupe keys and job payloads. */
export function floorplanTargetKey(target: FloorplanTarget): string {
  return target.kind === "plan" ? `plan:${target.housePlanVersionId}` : `project:${target.projectId}`
}

export interface FloorplanModelDto {
  id: string
  house_plan_version_id: string | null
  project_id: string | null
  drawing_revision_id: string | null
  status: FloorplanModelStatus
  model: FloorplanModel | null
  algo_version: number
  confidence: number | null
  level_count: number
  correction_count: number
  error: string | null
  interpreted_at: string | null
  published_at: string | null
  updated_at: string
  /** True when a newer interpretation algorithm exists than the one that ran. */
  stale: boolean
}

interface ModelRow {
  id: string
  house_plan_version_id: string | null
  project_id: string | null
  drawing_revision_id: string | null
  status: FloorplanModelStatus
  model: unknown
  algo_version: number
  confidence: string | number | null
  level_count: number
  correction_count: number
  error: string | null
  interpreted_at: string | null
  published_at: string | null
  updated_at: string
}

const MODEL_COLUMNS =
  "id, house_plan_version_id, project_id, drawing_revision_id, status, model, algo_version, confidence, level_count, correction_count, error, interpreted_at, published_at, updated_at"
/** Everything but the geometry — for chips and lists, which never need it. */
const MODEL_STATUS_COLUMNS =
  "id, house_plan_version_id, project_id, drawing_revision_id, status, algo_version, confidence, level_count, correction_count, error, interpreted_at, published_at, updated_at"

/**
 * Parse a stored model document.
 *
 * A row whose geometry no longer validates is reported as having no model
 * rather than crashing the viewer — the workbench then offers a re-interpret,
 * which is the only useful thing to do about it.
 */
function parseModel(raw: unknown): FloorplanModel | null {
  if (!raw || typeof raw !== "object") return null
  const parsed = floorplanModelSchema.safeParse(raw)
  return parsed.success ? (parsed.data as FloorplanModel) : null
}

function mapModel(row: ModelRow): FloorplanModelDto {
  return {
    id: row.id,
    house_plan_version_id: row.house_plan_version_id,
    project_id: row.project_id,
    drawing_revision_id: row.drawing_revision_id,
    status: row.status,
    model: parseModel(row.model),
    algo_version: row.algo_version,
    confidence: row.confidence === null ? null : Number(row.confidence),
    level_count: row.level_count,
    correction_count: row.correction_count,
    error: row.error,
    interpreted_at: row.interpreted_at,
    published_at: row.published_at,
    updated_at: row.updated_at,
    stale: row.algo_version < FLOORPLAN_ALGO_VERSION,
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getFloorplanModel(
  target: FloorplanTarget,
  orgId?: string,
): Promise<FloorplanModelDto | null> {
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.read", context)

  const anchor = anchorColumn(target)
  const { data, error } = await context.supabase
    .from("floorplan_models")
    .select(MODEL_COLUMNS)
    .eq("org_id", context.orgId)
    .eq(anchor.column, anchor.value)
    .maybeSingle()
  if (error) throw new Error(`Failed to load floorplan model: ${error.message}`)
  return data ? mapModel(data as ModelRow) : null
}

/** Status per plan version, for the library's model chips. */
export async function listFloorplanModelStatuses(
  housePlanVersionIds: string[],
  orgId?: string,
): Promise<Map<string, FloorplanModelDto>> {
  const result = new Map<string, FloorplanModelDto>()
  if (housePlanVersionIds.length === 0) return result
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.read", context)

  const { data, error } = await context.supabase
    .from("floorplan_models")
    // The document itself is megabytes; a chip only needs the status.
    .select(MODEL_STATUS_COLUMNS)
    .eq("org_id", context.orgId)
    .in("house_plan_version_id", housePlanVersionIds.slice(0, 500))
  if (error) throw new Error(`Failed to load floorplan model statuses: ${error.message}`)

  for (const row of (data ?? []) as unknown as ModelRow[]) {
    if (row.house_plan_version_id) result.set(row.house_plan_version_id, mapModel({ ...row, model: null }))
  }
  return result
}

/**
 * The published model for a plan, for read-only surfaces (offering page, buyer
 * portal). Resolves through the plan's released version, because that is the
 * edition a buyer is actually being sold.
 */
export async function getPublishedFloorplanModelForPlan(
  housePlanId: string,
  orgId?: string,
): Promise<FloorplanModelDto | null> {
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.read", context)

  const { data: version } = await context.supabase
    .from("house_plan_versions")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("house_plan_id", housePlanId)
    .eq("status", "released")
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!version) return null

  const { data, error } = await context.supabase
    .from("floorplan_models")
    .select(MODEL_COLUMNS)
    .eq("org_id", context.orgId)
    .eq("house_plan_version_id", version.id)
    .eq("status", "published")
    .maybeSingle()
  if (error) throw new Error(`Failed to load published floorplan model: ${error.message}`)
  return data ? mapModel(data as ModelRow) : null
}

/**
 * The source sheet behind each level, so review can put the interpretation
 * back on top of the drawing it came from. Correcting a wall graph without
 * the linework underneath is guesswork.
 */
export interface FloorplanSheetView {
  sheetVersionId: string
  tileBaseUrl: string | null
  tileManifest: Record<string, unknown> | null
  thumbnailUrl: string | null
  imageWidth: number
  imageHeight: number
  sheetNumber: string | null
  sheetTitle: string | null
}

/**
 * Which of these plans have a published, buyer-visible model.
 *
 * The offering page and the buyer portal ask this for a whole price sheet at
 * once, so it answers with ids rather than documents — a "View in 3D" button
 * only needs to know whether there is anything to open.
 */
export async function listPlansWithPublishedModels(
  housePlanIds: string[],
  orgId?: string,
): Promise<Set<string>> {
  const result = new Set<string>()
  if (housePlanIds.length === 0) return result
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.read", context)

  const { data, error } = await context.supabase
    .from("floorplan_models")
    .select("house_plan_versions!inner(house_plan_id, status)")
    .eq("org_id", context.orgId)
    .eq("status", "published")
    .eq("house_plan_versions.status", "released")
    .in("house_plan_versions.house_plan_id", housePlanIds.slice(0, 500))
  if (error) throw new Error(`Failed to load published models: ${error.message}`)

  for (const row of (data ?? []) as unknown as Array<{ house_plan_versions: { house_plan_id: string } | null }>) {
    if (row.house_plan_versions?.house_plan_id) result.add(row.house_plan_versions.house_plan_id)
  }
  return result
}

/**
 * A model document plus the sheets it was traced from.
 *
 * The workbench loads this lazily per edition rather than shipping every
 * edition's geometry with the page: a model is hundreds of kilobytes of JSON
 * and only the edition on screen needs it.
 */
export async function getFloorplanModelWithSheets(
  target: FloorplanTarget,
  orgId?: string,
): Promise<{ record: FloorplanModelDto | null; sheets: FloorplanSheetView[] }> {
  const record = await getFloorplanModel(target, orgId)
  if (!record?.model) return { record, sheets: [] }
  const sheetIds = [...new Set(record.model.levels.map((level) => level.source.sheetVersionId))]
  const sheets = await listFloorplanSheetViews(sheetIds, orgId)
  return { record, sheets }
}

export async function listFloorplanSheetViews(
  sheetVersionIds: string[],
  orgId?: string,
): Promise<FloorplanSheetView[]> {
  if (sheetVersionIds.length === 0) return []
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.read", context)

  const { data, error } = await context.supabase
    .from("drawing_sheet_versions")
    .select(
      "id, tile_base_url, tile_manifest, thumbnail_url, image_width, image_height, drawing_sheets!inner(sheet_number, sheet_title)",
    )
    .eq("org_id", context.orgId)
    .in("id", sheetVersionIds.slice(0, 20))
  if (error) throw new Error(`Failed to load floorplan sheets: ${error.message}`)

  return (data ?? []).map((row: any) => ({
    sheetVersionId: row.id as string,
    tileBaseUrl: (row.tile_base_url as string | null) ?? null,
    tileManifest: (row.tile_manifest as Record<string, unknown> | null) ?? null,
    thumbnailUrl: (row.thumbnail_url as string | null) ?? null,
    imageWidth: Number(row.image_width ?? 0),
    imageHeight: Number(row.image_height ?? 0),
    sheetNumber: row.drawing_sheets?.sheet_number ?? null,
    sheetTitle: row.drawing_sheets?.sheet_title ?? null,
  }))
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Check the anchor exists and actually has drawings behind it.
 *
 * Failing here — before a row is written and a job queued — is what turns "the
 * model never appeared" into a sentence the user can act on.
 */
async function assertInterpretable(
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  target: FloorplanTarget,
): Promise<void> {
  if (target.kind === "plan") {
    const { data: version, error } = await context.supabase
      .from("house_plan_versions")
      .select("id, drawing_source_file_id")
      .eq("org_id", context.orgId)
      .eq("id", target.housePlanVersionId)
      .maybeSingle()
    if (error) throw new Error(`Failed to load plan version: ${error.message}`)
    if (!version) throw new Error("Plan version not found")
    if (!version.drawing_source_file_id) {
      throw new Error("This edition has no plan-set PDF to interpret. Attach one first.")
    }
    return
  }

  const { data: project, error } = await context.supabase
    .from("projects")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("id", target.projectId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load project: ${error.message}`)
  if (!project) throw new Error("Project not found")

  const { count } = await context.supabase
    .from("drawing_revisions")
    .select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId)
    .eq("project_id", target.projectId)
    .eq("status", "published")
  if (!count) {
    throw new Error("This project has no published drawings yet. Upload and publish a set first.")
  }
}

/**
 * Queue interpretation for a plan version or a project.
 *
 * `force` is the re-interpret path: it is the only way to overwrite a model
 * that carries corrections, and the caller must have told the user how many
 * it discards before calling with it.
 */
export async function requestFloorplanInterpretation(
  input: { target: FloorplanTarget; force?: boolean },
  orgId?: string,
): Promise<FloorplanModelDto> {
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.write", context)
  await assertInterpretable(context, input.target)

  const existing = await getFloorplanModel(input.target, context.orgId)
  if (existing?.status === "processing") return existing
  if (existing && existing.correction_count > 0 && !input.force) {
    throw new Error(
      `Re-interpreting discards ${existing.correction_count} correction${existing.correction_count === 1 ? "" : "s"}.`,
    )
  }

  const anchor = anchorColumn(input.target)
  const { data, error } = await context.supabase
    .from("floorplan_models")
    .upsert(
      {
        org_id: context.orgId,
        [anchor.column]: anchor.value,
        status: "processing" as const,
        model: null,
        confidence: null,
        level_count: 0,
        correction_count: 0,
        error: null,
        algo_version: FLOORPLAN_ALGO_VERSION,
        created_by: context.userId,
      },
      { onConflict: anchor.column },
    )
    .select(MODEL_COLUMNS)
    .single()
  if (error) throw new Error(`Failed to queue interpretation: ${error.message}`)

  await enqueueOutboxJob({
    orgId: context.orgId,
    jobType: FLOORPLAN_INTERPRET_JOB,
    payload: { orgId: context.orgId, target: input.target, targetKey: floorplanTargetKey(input.target) },
    dedupeByPayloadKeys: ["targetKey"],
  })

  await recordAudit({
    orgId: context.orgId,
    action: "update",
    entityType: "floorplan_model",
    entityId: data.id,
    after: { status: "processing", target: floorplanTargetKey(input.target) },
    source: "floorplan.interpret",
  })

  return mapModel(data as ModelRow)
}

/**
 * Apply review corrections. Every edit runs through the same pure reducer the
 * UI previews with, so what a reviewer sees is what gets stored.
 */
export async function applyFloorplanCorrections(
  input: { target: FloorplanTarget; edits: FloorplanEdit[] },
  orgId?: string,
): Promise<FloorplanModelDto> {
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.write", context)
  const edits = floorplanEditsSchema.parse(input.edits) as FloorplanEdit[]

  const existing = await getFloorplanModel(input.target, context.orgId)
  if (!existing) throw new Error("There is no model to correct yet")
  if (!existing.model) throw new Error("This model has no geometry to correct")

  let model = existing.model
  let applied = 0
  for (const edit of edits) {
    const next = applyFloorplanEdit(model, edit)
    if (next === model) continue
    model = next
    applied++
  }
  if (applied === 0) return existing

  const { data, error } = await context.supabase
    .from("floorplan_models")
    .update({
      model,
      // A corrected model is a draft again: publishing is a deliberate act.
      status: "draft" as const,
      published_at: null,
      published_by: null,
      confidence: modelConfidence(model),
      correction_count: model.correctionCount,
      level_count: model.levels.length,
    })
    .eq("org_id", context.orgId)
    .eq("id", existing.id)
    .select(MODEL_COLUMNS)
    .single()
  if (error) throw new Error(`Failed to save corrections: ${error.message}`)

  await recordAudit({
    orgId: context.orgId,
    action: "update",
    entityType: "floorplan_model",
    entityId: existing.id,
    before: { correction_count: existing.correction_count },
    after: { correction_count: model.correctionCount },
    source: "floorplan.correct",
  })

  return mapModel(data as ModelRow)
}

export async function publishFloorplanModel(
  input: { target: FloorplanTarget },
  orgId?: string,
): Promise<FloorplanModelDto> {
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.write", context)

  const existing = await getFloorplanModel(input.target, context.orgId)
  if (!existing) throw new Error("There is no model to publish")
  if (!existing.model || existing.model.levels.every((level) => level.walls.length === 0)) {
    throw new Error("This model has no geometry to publish")
  }

  const { data, error } = await context.supabase
    .from("floorplan_models")
    .update({
      status: "published" as const,
      published_at: new Date().toISOString(),
      published_by: context.userId,
    })
    .eq("org_id", context.orgId)
    .eq("id", existing.id)
    .select(MODEL_COLUMNS)
    .single()
  if (error) throw new Error(`Failed to publish model: ${error.message}`)

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      eventType: "floorplan.published",
      entityType: "floorplan_model",
      entityId: existing.id,
      payload: {
        target: floorplanTargetKey(input.target),
        house_plan_version_id: existing.house_plan_version_id,
        project_id: existing.project_id,
        level_count: existing.level_count,
        floor_area_sqft: modelFloorAreaSqft(existing.model),
      },
    }),
    recordAudit({
      orgId: context.orgId,
      action: "update",
      entityType: "floorplan_model",
      entityId: existing.id,
      before: { status: existing.status },
      after: { status: "published" },
      source: "floorplan.publish",
    }),
  ])

  return mapModel(data as ModelRow)
}

export async function unpublishFloorplanModel(
  input: { target: FloorplanTarget },
  orgId?: string,
): Promise<FloorplanModelDto> {
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.write", context)

  const existing = await getFloorplanModel(input.target, context.orgId)
  if (!existing) throw new Error("There is no model to unpublish")

  const { data, error } = await context.supabase
    .from("floorplan_models")
    .update({ status: "draft" as const, published_at: null, published_by: null })
    .eq("org_id", context.orgId)
    .eq("id", existing.id)
    .select(MODEL_COLUMNS)
    .single()
  if (error) throw new Error(`Failed to unpublish model: ${error.message}`)
  return mapModel(data as ModelRow)
}

/**
 * Queue interpretation for every active plan's released edition.
 *
 * Editions that already carry corrections are skipped rather than force-run:
 * a bulk action must never silently destroy somebody's review work.
 */
export async function interpretAllActivePlans(orgId?: string): Promise<{ queued: number; skipped: number }> {
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.write", context)

  const { data: versions, error } = await context.supabase
    .from("house_plan_versions")
    .select("id, house_plans!inner(status)")
    .eq("org_id", context.orgId)
    .eq("status", "released")
    .eq("house_plans.status", "active")
    .not("drawing_source_file_id", "is", null)
    .limit(300)
  if (error) throw new Error(`Failed to list plan editions: ${error.message}`)

  const versionIds = (versions ?? []).map((row) => row.id as string)
  const existing = await listFloorplanModelStatuses(versionIds, context.orgId)

  let queued = 0
  let skipped = 0
  for (const versionId of versionIds) {
    const model = existing.get(versionId)
    if (model && (model.status === "processing" || model.correction_count > 0)) {
      skipped++
      continue
    }
    if (model?.status === "published" && !model.stale) {
      skipped++
      continue
    }
    try {
      await requestFloorplanInterpretation(
        { target: { kind: "plan", housePlanVersionId: versionId } },
        context.orgId,
      )
      queued++
    } catch {
      skipped++
    }
  }
  return { queued, skipped }
}

// ---------------------------------------------------------------------------
// Portal read
// ---------------------------------------------------------------------------

export interface PortalFloorplanModel {
  model: FloorplanModel
  planLabel: string
  levelCount: number
  floorAreaSqft: number
}

/**
 * The published model for a client's own house, whichever way it was built.
 *
 * Both anchors resolve here, and the project one wins: a custom home's model
 * hangs off the project directly, while a production buyer's hangs off the
 * plan version their lot was released on. `app/p` is the client portal for
 * BOTH, so a single lookup is what keeps a mixed org working — the alternative
 * is a residential client staring at a portal that quietly has no 3D tab.
 *
 * Portals authenticate by token, not by org membership, so this runs on the
 * service client behind the caller's own gate — every query is pinned to the
 * org AND project the token resolved to, and only a PUBLISHED model is ever
 * returned. The document is pure geometry: no price, no cost, no client data,
 * which is what makes it safe on a portal at all.
 */
export async function getPortalFloorplanModel(input: {
  orgId: string
  projectId: string
}): Promise<PortalFloorplanModel | null> {
  const supabase = createServiceSupabaseClient()

  const published = async (column: string, value: string) => {
    const { data } = await supabase
      .from("floorplan_models")
      .select("model")
      .eq("org_id", input.orgId)
      .eq(column, value)
      .eq("status", "published")
      .maybeSingle()
    return parseModel(data?.model)
  }

  const describe = (model: FloorplanModel, planLabel: string): PortalFloorplanModel | null => {
    if (!model.levels.some((level) => level.walls.length > 0)) return null
    return {
      model,
      planLabel,
      levelCount: model.levels.length,
      floorAreaSqft: modelFloorAreaSqft(model),
    }
  }

  const projectModel = await published("project_id", input.projectId)
  if (projectModel) return describe(projectModel, "Your home")

  const { data: lot } = await supabase
    .from("lots")
    .select("house_plan_version_id, house_plans:house_plan_id(code, name)")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId)
    .not("house_plan_version_id", "is", null)
    .limit(1)
    .maybeSingle()
  if (!lot?.house_plan_version_id) return null

  const planModel = await published("house_plan_version_id", lot.house_plan_version_id as string)
  if (!planModel) return null

  const plan = lot.house_plans as unknown as { code: string | null; name: string | null } | null
  return describe(planModel, [plan?.code, plan?.name].filter(Boolean).join(" — ") || "Your home")
}

// ---------------------------------------------------------------------------
// The interpretation job
// ---------------------------------------------------------------------------

interface SheetRow {
  id: string
  page_index: number
  image_width: number | null
  image_height: number | null
  tiles_base_path: string | null
  extracted_metadata: Record<string, any> | null
  drawing_sheets: { sheet_number: string | null; sheet_title: string | null; discipline: string | null; current_revision_id: string | null } | null
  drawing_revision_id: string | null
}

/**
 * Every sheet version processed from this plan version's PDF.
 *
 * Two routes in, because a plan set reaches the pipeline two ways: through
 * `queuePlanDrawings` (which stamps the project copy with
 * `source_plan_version_id`), or by somebody uploading the very same file to a
 * project's drawings directly.
 */
async function loadPlanSheetVersions(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  housePlanVersionId: string,
  drawingSourceFileId: string | null,
): Promise<SheetRow[]> {
  const { data: derived } = await supabase
    .from("files")
    .select("id")
    .eq("org_id", orgId)
    .contains("metadata", { source_plan_version_id: housePlanVersionId })
    .limit(50)

  const fileIds = new Set<string>((derived ?? []).map((row) => row.id as string))
  if (drawingSourceFileId) fileIds.add(drawingSourceFileId)
  if (fileIds.size === 0) return []

  const { data: revisions } = await supabase
    .from("drawing_revisions")
    .select("id")
    .eq("org_id", orgId)
    .in("source_file_id", [...fileIds])
    .limit(100)
  const revisionIds = (revisions ?? []).map((row) => row.id as string)
  if (revisionIds.length === 0) return []

  const { data, error } = await supabase
    .from("drawing_sheet_versions")
    .select(
      "id, page_index, image_width, image_height, tiles_base_path, extracted_metadata, drawing_revision_id, drawing_sheets!inner(sheet_number, sheet_title, discipline, current_revision_id)",
    )
    .eq("org_id", orgId)
    .in("drawing_revision_id", revisionIds)
    .not("tiles_base_path", "is", null)
    .order("page_index")
    .limit(400)
  if (error) throw new Error(`Failed to load plan sheets: ${error.message}`)

  // Only the sheet's CURRENT revision describes the house as it is built now.
  return ((data ?? []) as unknown as SheetRow[]).filter(
    (row) => row.drawing_sheets?.current_revision_id === row.drawing_revision_id,
  )
}

function feetPerImagePxOf(metadata: Record<string, any> | null): number | null {
  const calibrated = metadata?.calibration?.feet_per_image_px
  if (typeof calibrated === "number" && calibrated > 0) return calibrated
  // An unconfirmed proposal is still measured evidence, and a model built at
  // a slightly wrong scale is far more useful than no model — the review UI
  // shows real dimensions, so a bad scale is immediately visible.
  const proposed = metadata?.calibration_proposal?.feet_per_image_px
  if (typeof proposed === "number" && proposed > 0) return proposed
  return null
}

/**
 * Every sheet version on a project's own published drawings.
 *
 * The residential path, and the shorter one: a custom home's floorplan sheets
 * are simply the current sheets of the project's drawing set. No plan version
 * to indirect through, because there is no plan.
 */
async function loadProjectSheetVersions(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  projectId: string,
): Promise<{ sheets: SheetRow[]; revisionId: string | null }> {
  const { data: revision } = await supabase
    .from("drawing_revisions")
    .select("id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("status", "published")
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  const { data, error } = await supabase
    .from("drawing_sheet_versions")
    .select(
      "id, page_index, image_width, image_height, tiles_base_path, extracted_metadata, drawing_revision_id, drawing_sheets!inner(sheet_number, sheet_title, discipline, current_revision_id, project_id)",
    )
    .eq("org_id", orgId)
    .eq("drawing_sheets.project_id", projectId)
    .not("tiles_base_path", "is", null)
    .order("page_index")
    .limit(400)
  if (error) throw new Error(`Failed to load project sheets: ${error.message}`)

  // The sheet's CURRENT version is the one that describes the house being
  // built; superseded versions describe a house that changed.
  const sheets = ((data ?? []) as unknown as SheetRow[]).filter(
    (row) => row.drawing_sheets?.current_revision_id === row.drawing_revision_id,
  )
  return { sheets, revisionId: (revision?.id as string | undefined) ?? null }
}

/**
 * Run interpretation for one target. Called by the outbox worker with the
 * service client — no user context, so it writes directly.
 */
export async function runFloorplanInterpretation(input: {
  orgId: string
  target: FloorplanTarget
}): Promise<void> {
  const supabase = createServiceSupabaseClient()
  const { orgId, target } = input
  const anchor = anchorColumn(target)

  const fail = async (message: string) => {
    await supabase
      .from("floorplan_models")
      .update({ status: "failed", error: message, interpreted_at: new Date().toISOString() })
      .eq("org_id", orgId)
      .eq(anchor.column, anchor.value)
  }

  let sheets: SheetRow[] = []
  let revisionId: string | null = null

  if (target.kind === "plan") {
    const { data: version } = await supabase
      .from("house_plan_versions")
      .select("id, drawing_source_file_id")
      .eq("org_id", orgId)
      .eq("id", target.housePlanVersionId)
      .maybeSingle()
    if (!version) {
      await fail("Plan edition no longer exists")
      return
    }
    sheets = await loadPlanSheetVersions(supabase, orgId, target.housePlanVersionId, version.drawing_source_file_id)
    if (sheets.length === 0) {
      await fail(
        "No processed drawings for this edition yet. Release it to a lot, or upload the plan set to a project, then try again.",
      )
      return
    }
  } else {
    const loaded = await loadProjectSheetVersions(supabase, orgId, target.projectId)
    sheets = loaded.sheets
    revisionId = loaded.revisionId
    if (sheets.length === 0) {
      await fail("No processed drawings on this project yet. Upload and publish a drawing set, then try again.")
      return
    }
  }

  const candidates: SheetCandidate[] = sheets.map((sheet) => ({
    sheetVersionId: sheet.id,
    sheetNumber: sheet.drawing_sheets?.sheet_number ?? null,
    sheetTitle: sheet.drawing_sheets?.sheet_title ?? null,
    discipline: sheet.drawing_sheets?.discipline ?? null,
    pageIndex: sheet.page_index ?? 0,
    roomSizedLoopCount: Number(sheet.extracted_metadata?.vector_stats?.room_sized_loop_count ?? 0),
    hasVectors: sheet.extracted_metadata?.vector_stats?.aligned === true,
  }))

  const selected = selectFloorplanSheets(candidates)
  if (selected.length === 0) {
    await fail(
      "No floorplan sheets found in this plan set. Interpretation needs an architectural sheet titled as a floor plan with traceable linework.",
    )
    return
  }

  const byId = new Map(sheets.map((sheet) => [sheet.id, sheet]))
  const inputs: InterpretLevelInput[] = []
  // Why each candidate sheet was dropped. A sheet that LOOKS like a floor plan
  // and still produces nothing is the single most confusing outcome here, so
  // the reason is carried all the way to the panel instead of being swallowed.
  const skipped: Array<{ sheet: string; reason: "scale" | "vectors" }> = []
  const nameOf = (sheet: SelectedSheet) => sheet.sheetNumber || sheet.sheetTitle || "a sheet"
  // Sheets with no vector linework (scans) can still be traced by the vision
  // assist below — flagged loudly, because a traced level is a proposal.
  const visionAvailable = drawingsVisionConfigured()
  const scanTraced: string[] = []
  const tilesBasePathBySheet = new Map<string, string>()

  for (const sheet of selected) {
    const row = byId.get(sheet.sheetVersionId)
    if (!row?.tiles_base_path) {
      skipped.push({ sheet: nameOf(sheet), reason: "vectors" })
      continue
    }
    const feetPerImagePx = feetPerImagePxOf(row.extracted_metadata)
    if (!feetPerImagePx) {
      skipped.push({ sheet: nameOf(sheet), reason: "scale" })
      continue
    }

    let segments: Float32Array | null = null
    let flags: Uint8Array | null = null
    try {
      const buffer = await downloadTilesObject({ supabase, path: `${row.tiles_base_path}/vectors.bin` })
      const parsed = parseVectorsBin(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
      )
      if (parsed) {
        segments = parsed.segments
        flags = parsed.flags
      }
    } catch {
      // No vectors.bin stored — fall through: a scan has none, and the vision
      // assist may still be able to trace it from the rendered tiles.
    }
    if (!segments || segments.length === 0) {
      if (!visionAvailable) {
        skipped.push({ sheet: nameOf(sheet), reason: "vectors" })
        continue
      }
      // A scanned sheet: no vector evidence at all. The level goes in empty
      // and vision traces it below, at vision confidence, for review.
      segments = new Float32Array(0)
      flags = null
      scanTraced.push(nameOf(sheet))
    }

    let textRuns: TextRun[] = []
    try {
      const body = await downloadTilesObject({ supabase, path: `${row.tiles_base_path}/${TEXT_RUNS_FILE}` })
      textRuns = parseTextRuns(body.toString("utf8"))
    } catch {
      // Sheets extracted before algo 4 have no positioned text: rooms simply
      // come out unlabelled for a human to name.
      textRuns = []
    }

    tilesBasePathBySheet.set(sheet.sheetVersionId, row.tiles_base_path)
    inputs.push({
      sheetVersionId: sheet.sheetVersionId,
      sheetNumber: sheet.sheetNumber,
      sheetTitle: sheet.sheetTitle,
      name: sheet.levelName,
      order: sheet.order,
      imageWidth: Number(row.image_width ?? 0),
      imageHeight: Number(row.image_height ?? 0),
      feetPerImagePx,
      segments,
      flags,
      textRuns,
    })
  }

  if (inputs.length === 0) {
    // "No calibrated vector geometry" conflated two very different problems and
    // named neither the sheet nor the fix. Missing SCALE is the common one, and
    // it is a two-click repair in the drawings viewer.
    const unscaled = skipped.filter((entry) => entry.reason === "scale").map((entry) => entry.sheet)
    if (unscaled.length > 0) {
      const list = unscaled.join(", ")
      await fail(
        `${list} ${unscaled.length === 1 ? "has" : "have"} no scale set, so the model would have no real dimensions. ` +
          `Open ${unscaled.length === 1 ? "it" : "them"} in the drawings viewer, set the scale, then interpret again.`,
      )
      return
    }
    const list = skipped.map((entry) => entry.sheet).join(", ")
    await fail(
      list
        ? `No vector linework could be read from ${list}. The sheet may be a scan rather than a vector PDF.`
        : "The floorplan sheets in this set have no vector geometry to interpret.",
    )
    return
  }

  const model = interpretFloorplan(inputs)
  // Vision assist: confirm what the vectors found, add what they missed, name
  // what the text runs could not — and trace scans outright. Best-effort; the
  // vector-only model stands if it fails.
  const vision = await assistFloorplanModelWithVision({ supabase, model, tilesBasePathBySheet })
  // A sheet that looked like a floor plan but could not be used is a MISSING
  // STOREY, and the geometry alone will never reveal it. Say so on the record.
  const warnings = skipped.map((entry) =>
    entry.reason === "scale"
      ? `${entry.sheet} was skipped — no scale is set on that sheet.`
      : `${entry.sheet} was skipped — no vector linework could be read from it.`,
  )
  for (const sheet of scanTraced) {
    warnings.push(
      `${sheet} has no vector linework; its level was traced by AI vision and needs review before publishing.`,
    )
  }
  if (warnings.length > 0) model.warnings = warnings
  const usable = model.levels.some((level) => level.walls.length > 0)
  if (!usable) {
    await fail("No walls could be traced on the floorplan sheets. The linework may be a scan rather than vectors.")
    return
  }

  const { data: saved } = await supabase
    .from("floorplan_models")
    .update({
      status: "draft",
      model,
      algo_version: FLOORPLAN_ALGO_VERSION,
      confidence: modelConfidence(model),
      level_count: model.levels.length,
      correction_count: 0,
      error: null,
      interpreted_at: new Date().toISOString(),
      // Null on the plan path: a released plan version IS the revision.
      drawing_revision_id: revisionId,
    })
    .eq("org_id", orgId)
    .eq(anchor.column, anchor.value)
    .select("id")
    .maybeSingle()

  await recordEvent({
    orgId,
    eventType: "floorplan.interpreted",
    entityType: "floorplan_model",
    entityId: saved?.id,
    payload: {
      target: floorplanTargetKey(target),
      level_count: model.levels.length,
      wall_count: model.levels.reduce((total, level) => total + level.walls.length, 0),
      room_count: model.levels.reduce((total, level) => total + level.rooms.length, 0),
      floor_area_sqft: modelFloorAreaSqft(model),
      confidence: modelConfidence(model),
      ...(vision ? { vision_assist: vision } : {}),
    },
  })
}
