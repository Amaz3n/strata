"use server"

import { revalidatePath } from "next/cache"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  listDrawingSets,
  getDrawingSet,
  createDrawingSet,
  updateDrawingSet,
  deleteDrawingSet,
  listDrawingRevisions,
  getDrawingRevision,
  createDrawingRevision,
  updateDrawingRevision,
  deleteDrawingRevision,
  listDrawingSheets,
  listDrawingSheetsWithUrls,
  getDrawingSheet,
  createDrawingSheet,
  updateDrawingSheet,
  bulkUpdateSheetSharing,
  deleteDrawingSheet,
  listSheetVersions,
  listSheetVersionsWithUrls,
  createSheetVersion,
  getDisciplineCounts,
  getSheetSignedUrl,
} from "@/lib/services/drawings"
import {
  listDrawingMarkups,
  getDrawingMarkup,
  createDrawingMarkup,
  updateDrawingMarkup,
  deleteDrawingMarkup,
  getMarkupCountsByType,
  listDrawingPins,
  listDrawingPinsWithEntities,
  getDrawingPin,
  getPinsForEntity,
  createDrawingPin,
  updateDrawingPin,
  deleteDrawingPin,
  deletePinForEntity,
  syncPinStatus,
  getPinCountsByStatus,
  getPinCountsByEntityType,
  getSheetStatusCounts,
} from "@/lib/services/drawing-markups"
import type { SheetStatusCounts } from "@/lib/services/drawing-markups"
import type {
  DrawingSet,
  DrawingRevision,
  DrawingSheet,
  DrawingSheetVersion,
} from "@/lib/services/drawings"
import type {
  DrawingMarkup,
  DrawingPin,
} from "@/lib/services/drawing-markups"
import type {
  DrawingSetInput,
  DrawingSetUpdate,
  DrawingRevisionInput,
  DrawingRevisionUpdate,
  DrawingSheetInput,
  DrawingSheetUpdate,
  DrawingSheetVersionInput,
  DrawingSetListFilters,
  DrawingSheetListFilters,
  DrawingRevisionListFilters,
  DrawingDiscipline,
  DrawingMarkupInput,
  DrawingMarkupUpdate,
  DrawingMarkupListFilters,
  DrawingPinInput,
  DrawingPinUpdate,
  DrawingPinListFilters,
  PinEntityType,
  PinStatus,
  MarkupType,
} from "@/lib/validation/drawings"
import { createFileRecord } from "@/lib/services/files"
import { createRfi } from "@/lib/services/rfis"
import { createProjectTaskAction } from "@/app/(app)/projects/[id]/actions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

// Re-export types
export type {
  DrawingSet,
  DrawingRevision,
  DrawingSheet,
  DrawingSheetVersion,
  DrawingMarkup,
  DrawingPin,
  DrawingSetInput,
  DrawingSetUpdate,
  DrawingRevisionInput,
  DrawingRevisionUpdate,
  DrawingSheetInput,
  DrawingSheetUpdate,
  DrawingSheetListFilters,
  DrawingDiscipline,
  DrawingMarkupInput,
  DrawingMarkupUpdate,
  DrawingPinInput,
  DrawingPinUpdate,
  PinEntityType,
  PinStatus,
  MarkupType,
  SheetStatusCounts,
}

// ============================================================================
// DRAWING SET ACTIONS
// ============================================================================

/**
 * List drawing sets with filters
 */
export async function listDrawingSetsAction(
  filters: Partial<DrawingSetListFilters> = {}
): Promise<DrawingSet[]> {
  return listDrawingSets(filters)
}

/**
 * Get a single drawing set
 */
export async function getDrawingSetAction(setId: string): Promise<DrawingSet | null> {
  return getDrawingSet(setId)
}

/**
 * Create a new drawing set
 */
export async function createDrawingSetAction(
  input: DrawingSetInput
): Promise<DrawingSet> {
  const result = await createDrawingSet(input)
  revalidatePath("/drawings")
  revalidatePath(`/projects/${input.project_id}`)
  return result
}

/**
 * Update a drawing set
 */
export async function updateDrawingSetAction(
  setId: string,
  updates: DrawingSetUpdate
): Promise<DrawingSet> {
  const result = await updateDrawingSet(setId, updates)
  revalidatePath("/drawings")
  revalidatePath(`/projects/${result.project_id}`)
  return result
}

/**
 * Delete a drawing set
 */
export async function deleteDrawingSetAction(setId: string): Promise<void> {
  const set = await getDrawingSet(setId)
  await deleteDrawingSet(setId)
  revalidatePath("/drawings")
  if (set?.project_id) {
    revalidatePath(`/projects/${set.project_id}`)
  }
}

/**
 * Create a drawing set from an already uploaded file
 * This creates the database records after client-side upload
 */
export async function createDrawingSetFromUpload(input: {
  projectId: string
  title?: string
  fileName: string
  storagePath: string
  fileSize: number
  mimeType: string
}): Promise<DrawingSet> {
  const { supabase, orgId, userId } = await requireOrgContext()

  // Create file record for the uploaded PDF
  const fileRecord = await createFileRecord({
    project_id: input.projectId,
    file_name: input.fileName,
    storage_path: input.storagePath,
    mime_type: input.mimeType,
    size_bytes: input.fileSize,
    visibility: "private",
    category: "plans",
    source: "upload",
  })

  // Create drawing set record
  const drawingSet = await createDrawingSet({
    project_id: input.projectId,
    title: input.title || input.fileName.replace(/\.pdf$/i, ""),
    source_file_id: fileRecord.id,
  })

  // Trigger processing (this will be done by an edge function)
  try {
    const useTiles = process.env.NEXT_PUBLIC_FEATURE_TILED_VIEWER === "true"
    // Call the edge function to process the PDF
    const { error: fnError } = await supabase.functions.invoke("process-drawing-set", {
      body: {
        drawingSetId: drawingSet.id,
        orgId,
        projectId: input.projectId,
        sourceFileId: fileRecord.id,
        storagePath: input.storagePath,
        generateImages: !useTiles,
        generateTiles: useTiles,
      },
    })

    if (fnError) {
      console.error("Failed to trigger drawing processing:", fnError)
      // Update set status to failed
      await updateDrawingSet(drawingSet.id, {
        status: "failed",
        error_message: "Failed to start processing",
      })
    }
  } catch (error) {
    console.error("Failed to invoke edge function:", error)
    // The set stays in "processing" status - can be retried manually
  }

  revalidatePath("/drawings")
  revalidatePath(`/projects/${input.projectId}`)

  return drawingSet
}

/**
 * Legacy upload function - kept for backwards compatibility
 * @deprecated Use client-side upload + createDrawingSetFromUpload instead
 */
export async function uploadPlanSetAction(formData: FormData): Promise<DrawingSet> {
  const file = formData.get("file") as File
  const projectId = formData.get("projectId") as string
  const title = formData.get("title") as string

  if (!file) {
    throw new Error("No file provided")
  }

  if (!projectId) {
    throw new Error("Project ID is required")
  }

  // Validate file type
  if (file.type !== "application/pdf") {
    throw new Error("Only PDF files are supported for plan sets")
  }

  // For files > 1MB, suggest using the new approach
  if (file.size > 1024 * 1024) {
    throw new Error("File too large. Please use the updated upload method that uploads directly to storage.")
  }

  return createDrawingSetFromUpload({
    projectId,
    title,
    fileName: file.name,
    storagePath: `temp-${Date.now()}`, // This won't work, but keeping for backwards compatibility message
    fileSize: file.size,
    mimeType: file.type,
  })
}

/**
 * Retry processing a failed drawing set
 */
export async function retryProcessingAction(setId: string): Promise<DrawingSet> {
  const { supabase, orgId } = await requireOrgContext()

  const set = await getDrawingSet(setId)
  if (!set) {
    throw new Error("Drawing set not found")
  }

  if (set.status !== "failed") {
    throw new Error("Can only retry failed drawing sets")
  }

  // Reset status to processing
  const updated = await updateDrawingSet(setId, {
    status: "processing",
    error_message: null,
    processed_pages: 0,
  })

  // Get the source file path
  if (!set.source_file_id) {
    throw new Error("No source file found for this drawing set")
  }

  const { data: fileData } = await supabase
    .from("files")
    .select("storage_path")
    .eq("id", set.source_file_id)
    .single()

  if (!fileData?.storage_path) {
    throw new Error("Source file not found")
  }

  // Trigger processing again
  try {
    const { error: fnError } = await supabase.functions.invoke("process-drawing-set", {
      body: {
        drawingSetId: set.id,
        orgId,
        projectId: set.project_id,
        sourceFileId: set.source_file_id,
        storagePath: fileData.storage_path,
      },
    })

    if (fnError) {
      console.error("Failed to trigger drawing processing:", fnError)
      await updateDrawingSet(set.id, {
        status: "failed",
        error_message: "Failed to start processing",
      })
    }
  } catch (error) {
    console.error("Failed to invoke edge function:", error)
  }

  revalidatePath("/drawings")
  revalidatePath(`/projects/${set.project_id}`)

  return updated
}

// ============================================================================
// DRAWING REVISION ACTIONS
// ============================================================================

/**
 * List revisions with filters
 */
export async function listDrawingRevisionsAction(
  filters: Partial<DrawingRevisionListFilters> = {}
): Promise<DrawingRevision[]> {
  return listDrawingRevisions(filters)
}

/**
 * Get a single revision
 */
export async function getDrawingRevisionAction(
  revisionId: string
): Promise<DrawingRevision | null> {
  return getDrawingRevision(revisionId)
}

/**
 * Create a new revision
 */
export async function createDrawingRevisionAction(
  input: DrawingRevisionInput
): Promise<DrawingRevision> {
  const result = await createDrawingRevision(input)
  revalidatePath("/drawings")
  revalidatePath(`/projects/${input.project_id}`)
  return result
}

/**
 * Update a revision
 */
export async function updateDrawingRevisionAction(
  revisionId: string,
  updates: DrawingRevisionUpdate
): Promise<DrawingRevision> {
  const result = await updateDrawingRevision(revisionId, updates)
  revalidatePath("/drawings")
  revalidatePath(`/projects/${result.project_id}`)
  return result
}

/**
 * Delete a revision
 */
export async function deleteDrawingRevisionAction(revisionId: string): Promise<void> {
  const revision = await getDrawingRevision(revisionId)
  await deleteDrawingRevision(revisionId)
  revalidatePath("/drawings")
  if (revision?.project_id) {
    revalidatePath(`/projects/${revision.project_id}`)
  }
}

// ============================================================================
// DRAWING SHEET ACTIONS
// ============================================================================

/**
 * List sheets with filters
 */
export async function listDrawingSheetsAction(
  filters: Partial<DrawingSheetListFilters> = {}
): Promise<DrawingSheet[]> {
  return listDrawingSheets(filters)
}

/**
 * List sheets with signed URLs
 */
export async function listDrawingSheetsWithUrlsAction(
  filters: Partial<DrawingSheetListFilters> = {}
): Promise<DrawingSheet[]> {
  return listDrawingSheetsWithUrls(filters)
}

/**
 * Get a single sheet
 */
export async function getDrawingSheetAction(
  sheetId: string
): Promise<DrawingSheet | null> {
  return getDrawingSheet(sheetId)
}

/**
 * Create a new sheet
 */
export async function createDrawingSheetAction(
  input: DrawingSheetInput
): Promise<DrawingSheet> {
  const result = await createDrawingSheet(input)
  revalidatePath("/drawings")
  revalidatePath(`/projects/${input.project_id}`)
  return result
}

/**
 * Update a sheet
 */
export async function updateDrawingSheetAction(
  sheetId: string,
  updates: DrawingSheetUpdate
): Promise<DrawingSheet> {
  const result = await updateDrawingSheet(sheetId, updates)
  revalidatePath("/drawings")
  revalidatePath(`/projects/${result.project_id}`)
  return result
}

/**
 * Bulk update sheet sharing settings
 */
export async function bulkUpdateSheetSharingAction(
  sheetIds: string[],
  sharing: { share_with_clients?: boolean; share_with_subs?: boolean }
): Promise<void> {
  await bulkUpdateSheetSharing(sheetIds, sharing)
  revalidatePath("/drawings")
}

/**
 * Delete a sheet
 */
export async function deleteDrawingSheetAction(sheetId: string): Promise<void> {
  const sheet = await getDrawingSheet(sheetId)
  await deleteDrawingSheet(sheetId)
  revalidatePath("/drawings")
  if (sheet?.project_id) {
    revalidatePath(`/projects/${sheet.project_id}`)
  }
}

/**
 * Get discipline counts for a project
 */
export async function getDisciplineCountsAction(
  projectId: string
): Promise<Record<string, number>> {
  return getDisciplineCounts(projectId)
}

/**
 * Get signed URL for a sheet's current file
 */
export async function getSheetDownloadUrlAction(sheetId: string): Promise<string | null> {
  return getSheetSignedUrl(sheetId)
}

/**
 * Get signed URLs for a sheet's optimized images (thumbnail/medium/full).
 *
 * Why: optimized images are currently stored in the private `project-files` bucket.
 * The DB columns store "public" URLs (via getPublicUrl), but those won't load if the
 * bucket isn't public. We sign them on-demand when opening the viewer to avoid the
 * N-per-sheet signed URL explosion in list views.
 */
export async function getSheetOptimizedImageUrlsAction(
  sheetId: string,
  expiresIn: number = 3600
): Promise<{
  thumbnailUrl: string | null
  mediumUrl: string | null
  fullUrl: string | null
  width: number | null
  height: number | null
} | null> {
  // Use the scoped client for authorization checks (RLS + org membership),
  // but use service role for storage signing to avoid Storage RLS edge cases.
  const { supabase, orgId } = await requireOrgContext()
  const service = createServiceSupabaseClient()
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL

  const { data: sheet, error: sheetError } = await supabase
    .from("drawing_sheets")
    .select("id, current_revision_id")
    .eq("org_id", orgId)
    .eq("id", sheetId)
    .single()

  if (sheetError) {
    throw new Error(`Failed to load sheet: ${sheetError.message}`)
  }

  if (!sheet?.current_revision_id) return null

  const { data: version, error: versionError } = await supabase
    .from("drawing_sheet_versions")
    .select(
      "thumb_path, medium_path, full_path, tile_manifest_path, tiles_base_path, thumbnail_url, medium_url, full_url, image_width, image_height, created_at"
    )
    .eq("org_id", orgId)
    .eq("drawing_sheet_id", sheetId)
    .eq("drawing_revision_id", sheet.current_revision_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (versionError) {
    throw new Error(`Failed to load sheet version: ${versionError.message}`)
  }

  const buildPublicImageUrl = (path?: string | null) => {
    if (!path || !supabaseUrl) return null
    const normalized = path.startsWith("/") ? path.slice(1) : path
    return `${supabaseUrl}/storage/v1/object/public/drawings-images/${encodeURI(normalized)}`
  }

  const maybeSignLegacy = async (value: string | null | undefined): Promise<string | null> => {
    if (!value) return null
    if (value.includes("token=")) return value
    // If value is already pointing to drawings-images and public, return as-is
    if (value.includes("/drawings-images/")) return value

    const storagePath = extractProjectFilesPath(value)
    if (!storagePath) return value

    const { data, error } = await service.storage
      .from("project-files")
      .createSignedUrl(storagePath, expiresIn)

    if (error) {
      console.error("Failed to sign image URL:", error)
      return null
    }

    return data?.signedUrl ?? null
  }

  const [thumbnailUrl, mediumUrl, fullUrl] = await Promise.all([
    buildPublicImageUrl((version as any)?.thumb_path) ??
      buildPublicImageUrl((version as any)?.thumbnail_path) ??
      maybeSignLegacy((version as any)?.thumbnail_url),
    buildPublicImageUrl((version as any)?.medium_path) ??
      maybeSignLegacy((version as any)?.medium_url),
    buildPublicImageUrl((version as any)?.full_path) ?? maybeSignLegacy((version as any)?.full_url),
  ])

  return {
    thumbnailUrl,
    mediumUrl,
    fullUrl,
    width: (version as any)?.image_width ?? null,
    height: (version as any)?.image_height ?? null,
  }
}

function extractProjectFilesPath(urlOrPath: string): string | null {
  // If it's already a raw storage path (no protocol), assume it's valid.
  if (!urlOrPath.startsWith("http://") && !urlOrPath.startsWith("https://")) {
    return urlOrPath
  }

  // Expected public URL format:
  // https://<ref>.supabase.co/storage/v1/object/public/project-files/<path>
  const marker = "/storage/v1/object/public/project-files/"
  const idx = urlOrPath.indexOf(marker)
  if (idx === -1) return null

  const path = urlOrPath.slice(idx + marker.length)
  return path ? decodeURIComponent(path) : null
}

// ============================================================================
// SHEET VERSION ACTIONS
// ============================================================================

/**
 * List versions for a sheet
 */
export async function listSheetVersionsAction(
  sheetId: string
): Promise<DrawingSheetVersion[]> {
  return listSheetVersions(sheetId)
}

/**
 * List versions for a sheet with signed URLs (for comparison mode)
 */
export async function listSheetVersionsWithUrlsAction(
  sheetId: string
): Promise<DrawingSheetVersion[]> {
  return listSheetVersionsWithUrls(sheetId)
}

/**
 * Create a sheet version
 */
export async function createSheetVersionAction(
  input: DrawingSheetVersionInput
): Promise<DrawingSheetVersion> {
  const result = await createSheetVersion(input)
  revalidatePath("/drawings")
  return result
}

// ============================================================================
// HELPER ACTIONS
// ============================================================================

/**
 * List projects for the project filter dropdown
 */
export async function listProjectsForDrawingsAction(): Promise<
  Array<{ id: string; name: string }>
> {
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("projects")
    .select("id, name")
    .eq("org_id", orgId)
    .in("status", ["planning", "bidding", "active", "on_hold"])
    .order("name", { ascending: true })

  if (error) {
    console.error("Failed to list projects:", error.message)
    return []
  }

  return data ?? []
}

/**
 * Queue tile generation for sheets that don't have tiles yet
 */
export async function queueTileGenerationForExistingSheetsAction(): Promise<{
  queued: number
}> {
  // Caller must be authorized (org member), but queueing uses service role to avoid RLS/NOT NULL issues.
  const { supabase, orgId } = await requireOrgContext()
  const service = createServiceSupabaseClient()

  // Find sheet versions that don't have tiles generated yet
  const { data: sheetVersions, error } = await supabase
    .from("drawing_sheet_versions")
    .select("id")
    .eq("org_id", orgId)
    .is("tile_manifest", null)
    .not("file_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(500)

  if (error) {
    throw new Error(`Failed to find sheets needing tiles: ${error.message}`)
  }

  if (!sheetVersions?.length) {
    return { queued: 0 }
  }

  // Queue tile generation jobs
  const jobs = sheetVersions.map((sv) => ({
    org_id: orgId,
    event_id: null,
    job_type: "generate_drawing_tiles",
    status: "pending",
    retry_count: 0,
    last_error: "",
    payload: { sheetVersionId: sv.id },
    run_at: new Date().toISOString(),
  }))

  const { error: insertError } = await service
    .from("outbox")
    .insert(jobs)

  if (insertError) {
    throw new Error(`Failed to queue tile generation jobs: ${insertError.message}`)
  }

  revalidatePath("/drawings")
  revalidatePath("/drawings/debug")

  return { queued: jobs.length }
}

/**
 * Refresh the drawing sheets list materialized view
 */
export async function refreshDrawingSheetsListAction(): Promise<void> {
  const supabase = createServiceSupabaseClient()

  const { error } = await supabase.rpc("refresh_drawing_sheets_list")
  if (error) {
    throw new Error(`Failed to refresh drawing sheets list: ${error.message}`)
  }
}

/**
 * Get drawing set processing status
 */
export async function getProcessingStatusAction(setId: string): Promise<{
  status: string
  processed_pages: number
  total_pages?: number
  error_message?: string
}> {
  const set = await getDrawingSet(setId)
  if (!set) {
    throw new Error("Drawing set not found")
  }

  return {
    status: set.status,
    processed_pages: set.processed_pages,
    total_pages: set.total_pages,
    error_message: set.error_message,
  }
}

// ============================================================================
// DRAWING MARKUP ACTIONS (Phase 4)
// ============================================================================

/**
 * List markups with filters
 */
export async function listDrawingMarkupsAction(
  filters: Partial<DrawingMarkupListFilters> = {}
): Promise<DrawingMarkup[]> {
  return listDrawingMarkups(filters)
}

/**
 * Get a single markup
 */
export async function getDrawingMarkupAction(
  markupId: string
): Promise<DrawingMarkup | null> {
  return getDrawingMarkup(markupId)
}

/**
 * Create a new markup
 */
export async function createDrawingMarkupAction(
  input: DrawingMarkupInput
): Promise<DrawingMarkup> {
  const result = await createDrawingMarkup(input)
  revalidatePath("/drawings")
  return result
}

/**
 * Update a markup
 */
export async function updateDrawingMarkupAction(
  markupId: string,
  updates: DrawingMarkupUpdate
): Promise<DrawingMarkup> {
  const result = await updateDrawingMarkup(markupId, updates)
  revalidatePath("/drawings")
  return result
}

/**
 * Delete a markup
 */
export async function deleteDrawingMarkupAction(markupId: string): Promise<void> {
  await deleteDrawingMarkup(markupId)
  revalidatePath("/drawings")
}

/**
 * Get markup counts by type for a sheet
 */
export async function getMarkupCountsByTypeAction(
  sheetId: string
): Promise<Record<MarkupType, number>> {
  return getMarkupCountsByType(sheetId)
}

// ============================================================================
// DRAWING PIN ACTIONS (Phase 4)
// ============================================================================

/**
 * List pins with filters
 */
export async function listDrawingPinsAction(
  filters: Partial<DrawingPinListFilters> = {}
): Promise<DrawingPin[]> {
  return listDrawingPins(filters)
}

/**
 * List pins for a sheet with entity details
 */
export async function listDrawingPinsWithEntitiesAction(
  sheetId: string
): Promise<DrawingPin[]> {
  return listDrawingPinsWithEntities(sheetId)
}

/**
 * Get a single pin
 */
export async function getDrawingPinAction(
  pinId: string
): Promise<DrawingPin | null> {
  return getDrawingPin(pinId)
}

/**
 * Get pins for a specific entity
 */
export async function getPinsForEntityAction(
  entityType: PinEntityType,
  entityId: string
): Promise<DrawingPin[]> {
  return getPinsForEntity(entityType, entityId)
}

/**
 * Create a new pin
 */
export async function createDrawingPinAction(
  input: DrawingPinInput
): Promise<DrawingPin> {
  const result = await createDrawingPin(input)
  revalidatePath("/drawings")
  return result
}

/**
 * Update a pin
 */
export async function updateDrawingPinAction(
  pinId: string,
  updates: DrawingPinUpdate
): Promise<DrawingPin> {
  const result = await updateDrawingPin(pinId, updates)
  revalidatePath("/drawings")
  return result
}

/**
 * Delete a pin
 */
export async function deleteDrawingPinAction(pinId: string): Promise<void> {
  await deleteDrawingPin(pinId)
  revalidatePath("/drawings")
}

/**
 * Delete pin when entity is deleted
 */
export async function deletePinForEntityAction(
  entityType: PinEntityType,
  entityId: string
): Promise<void> {
  await deletePinForEntity(entityType, entityId)
  revalidatePath("/drawings")
}

// ============================================================================
// CREATE ENTITY FROM DRAWING (MVP)
// ============================================================================

export async function createTaskFromDrawingAction(projectId: string, input: unknown) {
  const task = await createProjectTaskAction(projectId, input)
  return task
}

export async function createRfiFromDrawingAction(input: {
  projectId: string
  subject: string
  question: string
  priority?: "low" | "medium" | "high" | "urgent"
}) {
  const { supabase, orgId } = await requireOrgContext()

  const { data: last } = await supabase
    .from("rfis")
    .select("rfi_number")
    .eq("org_id", orgId)
    .eq("project_id", input.projectId)
    .order("rfi_number", { ascending: false })
    .limit(1)
    .maybeSingle()

  const nextNumber = (last?.rfi_number ?? 0) + 1

  return createRfi({
    input: {
      project_id: input.projectId,
      rfi_number: nextNumber,
      subject: input.subject,
      question: input.question,
      status: "open",
      priority: input.priority ?? "medium",
      due_date: null,
      attachment_file_id: null,
    },
  })
}

export async function createPunchItemFromDrawingAction(input: {
  projectId: string
  title: string
  description?: string
  location?: string
  severity?: string
}) {
  const { supabase, orgId, userId } = await requireOrgContext()

  const payload = {
    org_id: orgId,
    project_id: input.projectId,
    title: input.title,
    description: input.description ?? null,
    location: input.location ?? null,
    severity: input.severity ?? null,
    status: "open",
  }

  const { data, error } = await supabase
    .from("punch_items")
    .insert(payload)
    .select("id, org_id, project_id, title, description, status, due_date, severity, location, resolved_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create punch item: ${error?.message}`)
  }

  await recordEvent({
    orgId,
    eventType: "punch_item_created",
    entityType: "punch_item",
    entityId: data.id,
    payload: { title: input.title, project_id: input.projectId },
  })

  await recordAudit({
    orgId,
    actorId: userId,
    action: "insert",
    entityType: "punch_item",
    entityId: data.id,
    after: payload as any,
  })

  revalidatePath(`/projects/${input.projectId}`)

  return data
}

/**
 * Sync pin status with entity status
 */
export async function syncPinStatusAction(
  entityType: PinEntityType,
  entityId: string,
  newStatus: PinStatus
): Promise<void> {
  await syncPinStatus(entityType, entityId, newStatus)
  revalidatePath("/drawings")
}

/**
 * Get pin counts by status for a sheet
 */
export async function getPinCountsByStatusAction(
  sheetId: string
): Promise<Record<string, number>> {
  return getPinCountsByStatus(sheetId)
}

/**
 * Get pin counts by entity type for a sheet
 */
export async function getPinCountsByEntityTypeAction(
  sheetId: string
): Promise<Record<PinEntityType, number>> {
  return getPinCountsByEntityType(sheetId)
}

/**
 * Get aggregated status counts for multiple sheets.
 * Used for displaying status indicator dots on sheet cards.
 */
export async function getSheetStatusCountsAction(
  sheetIds: string[]
): Promise<Record<string, SheetStatusCounts>> {
  return getSheetStatusCounts({ sheetIds })
}
