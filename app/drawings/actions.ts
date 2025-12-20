"use server"

import { revalidatePath } from "next/cache"
import { requireOrgContext } from "@/lib/services/context"
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
} from "@/lib/services/drawing-markups"
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
 * Upload a plan set PDF and create a drawing set
 * This uploads the file and triggers processing
 */
export async function uploadPlanSetAction(formData: FormData): Promise<DrawingSet> {
  const { supabase, orgId, userId } = await requireOrgContext()

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

  // Generate unique storage path
  const timestamp = Date.now()
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = `${orgId}/${projectId}/drawings/sets/${timestamp}_${safeName}`

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from("project-files")
    .upload(storagePath, file, {
      contentType: file.type,
      upsert: false,
    })

  if (uploadError) {
    throw new Error(`Failed to upload file: ${uploadError.message}`)
  }

  // Create file record for the source PDF
  const fileRecord = await createFileRecord({
    project_id: projectId,
    file_name: file.name,
    storage_path: storagePath,
    mime_type: file.type,
    size_bytes: file.size,
    visibility: "private",
    category: "plans",
    source: "upload",
  })

  // Create drawing set record
  const drawingSet = await createDrawingSet({
    project_id: projectId,
    title: title || file.name.replace(/\.pdf$/i, ""),
    source_file_id: fileRecord.id,
  })

  // Trigger processing (this will be done by an edge function)
  // For now, we'll insert into an outbox table or call the edge function directly
  try {
    // Call the edge function to process the PDF
    const { error: fnError } = await supabase.functions.invoke("process-drawing-set", {
      body: {
        drawingSetId: drawingSet.id,
        orgId,
        projectId,
        sourceFileId: fileRecord.id,
        storagePath,
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
  revalidatePath(`/projects/${projectId}`)

  return drawingSet
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
