"use server"

import { revalidatePath } from "next/cache"
import { buildDrawingsImageUrl } from "@/lib/storage/drawings-urls"
import { ensureOrgScopedPath } from "@/lib/storage/files-storage"
import { getDrawingPdfSignedUrl } from "@/lib/storage/drawings-pdfs-storage"
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
  getDrawingRegisterSnapshot,
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
  getRevisionDiff,
  publishRevision,
  discardRevision,
  getDraftRevisionStatus,
  getPendingDraftRevision,
  getSheetCalibration,
  setSheetVersionCalibration,
  searchSheetContent,
} from "@/lib/services/drawings"
import {
  listRevisionRecipients,
  distributeRevision,
} from "@/lib/services/drawings-distribution"
import type {
  RevisionRecipientList,
  DistributeRevisionResult,
} from "@/lib/services/drawings-distribution"
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
  RevisionDiff,
  RevisionDraftStatus,
  PublishRevisionInput,
  SheetCalibration,
  SheetContentMatch,
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
  DistributeRevisionInput,
  DrawingDiscipline,
  DrawingIssuanceType,
  DrawingMarkupInput,
  DrawingMarkupUpdate,
  DrawingMarkupListFilters,
  DrawingPinInput,
  DrawingPinUpdate,
  DrawingPinListFilters,
  PinEntityType,
  PinStatus,
  MarkupType,
  SetSheetVersionCalibrationInput,
  CreatePhotoFromDrawingInput,
} from "@/lib/validation/drawings"
import { createPhotoFromDrawingInputSchema } from "@/lib/validation/drawings"
import { createFileRecord, buildInternalFileUrl } from "@/lib/services/files"
import { triggerDrawingsPipeline } from "@/lib/services/drawings-pipeline-trigger"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { getPlatformAiFeatureDefaultConfig } from "@/lib/services/ai-config"
import { createRfi } from "@/lib/services/rfis"
import { createProjectTaskAction } from "@/app/(app)/projects/[id]/actions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import type { UploadReviewSheet } from "./types"

import { unwrapAction, actionError, type ActionResult  } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

type TargetDrawingSheet = {
  id: string
  sheet_number: string
  sheet_title: string | null
  discipline: DrawingDiscipline | null
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
): Promise<ActionResult<DrawingSet>> {
  return run(async () => {
      await requireAnyPermission(["drawing.upload", "org.admin"])
      const result = await createDrawingSet(input)
      revalidatePath("/drawings")
      revalidatePath(`/projects/${input.project_id}`)
      return result
  })
}

/**
 * Update a drawing set
 */
export async function updateDrawingSetAction(
  setId: string,
  updates: DrawingSetUpdate
): Promise<ActionResult<DrawingSet>> {
  return run(async () => {
      await requireAnyPermission(["drawing.upload", "org.admin"])
      const result = await updateDrawingSet(setId, updates)
      revalidatePath("/drawings")
      revalidatePath(`/projects/${result.project_id}`)
      return result
  })
}

/**
 * Delete a drawing set
 */
export async function deleteDrawingSetAction(setId: string): Promise<ActionResult<void>> {
  return run(async () => {
      await requireAnyPermission(["docs.delete", "org.admin"])
      const set = await getDrawingSet(setId)
      await deleteDrawingSet(setId)
      revalidatePath("/drawings")
      if (set?.project_id) {
        revalidatePath(`/projects/${set.project_id}`)
      }
  })
}

/**
 * Create a drawing set from an already uploaded file
 * This creates the database records after client-side upload
 */
export async function createDrawingSetFromUpload(input: {
  projectId: string
  title?: string
  setType?: string
  fileName: string
  storagePath: string
  fileSize: number
  mimeType: string
  issuanceLabel?: string
  issuanceType?: DrawingIssuanceType
  issuedDate?: string
  issuedBy?: string
  receivedFrom?: string
  notes?: string
  targetSheetId?: string
}): Promise<ActionResult<{ set: DrawingSet; draftRevisionId: string }>> {
  return run(async () => {
      const { supabase, orgId } = await requireOrgContext()
      await requireAnyPermission(["drawing.upload", "org.admin"])
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id, name")
        .eq("org_id", orgId)
        .eq("id", input.projectId)
        .maybeSingle()

      if (projectError || !project) {
        throw new Error("Invalid project scope for drawing upload")
      }

      const normalizedStoragePath = ensureOrgScopedPath(orgId, input.storagePath)
      const allowedPrefixes = [
        `${orgId}/${input.projectId}/drawings/uploads/`,
        `${orgId}/${input.projectId}/drawings/sets/`,
      ]

      if (!allowedPrefixes.some((prefix) => normalizedStoragePath.startsWith(prefix))) {
        throw new Error("Invalid drawing upload path for project scope")
      }

      let targetSheet: TargetDrawingSheet | null = null
      if (input.targetSheetId) {
        const { data, error } = await supabase
          .from("drawing_sheets")
          .select("id, sheet_number, sheet_title, discipline")
          .eq("org_id", orgId)
          .eq("project_id", input.projectId)
          .eq("id", input.targetSheetId)
          .maybeSingle()

        if (error || !data) {
          throw new Error("Invalid target sheet for drawing revision")
        }
        targetSheet = data as TargetDrawingSheet
      }

      // Create file record for the uploaded PDF
      const fileRecord = await createFileRecord({
        project_id: input.projectId,
        file_name: input.fileName,
        storage_path: normalizedStoragePath,
        mime_type: input.mimeType,
        size_bytes: input.fileSize,
        visibility: "private",
        category: "plans",
        source: "upload",
      })

      // Single register per project: reuse the project's canonical (oldest) set.
      // An upload processes into a DRAFT revision and never mutates the live set or
      // its sheets — nothing changes until the user publishes. So the live set stays
      // 'ready' the whole time; draft progress is tracked on the revision row.
      const { data: existingSets, error: existingSetsError } = await supabase
        .from("drawing_sets")
        .select("id")
        .eq("org_id", orgId)
        .eq("project_id", input.projectId)
        .order("created_at", { ascending: true })
        .limit(1)

      if (existingSetsError) {
        throw new Error(`Failed to load existing drawing sets: ${existingSetsError.message}`)
      }

      // Only one in-flight draft per project: require publishing/discarding first.
      const { data: pendingDrafts, error: pendingError } = await supabase
        .from("drawing_revisions")
        .select("id")
        .eq("org_id", orgId)
        .eq("project_id", input.projectId)
        .in("status", ["processing", "draft"])
        .limit(1)

      if (pendingError) {
        throw new Error(`Failed to check pending revisions: ${pendingError.message}`)
      }
      if (pendingDrafts && pendingDrafts.length > 0) {
        throw new Error("A revision is already pending review. Publish or discard it before uploading another.")
      }

      let drawingSet: DrawingSet

      if (existingSets && existingSets.length > 0) {
        const canonicalSetId = existingSets[0].id as string
        const { error: updateError } = await supabase
          .from("drawing_sets")
          .update({ source_file_id: fileRecord.id, status: "ready", processing_stage: "ready" })
          .eq("org_id", orgId)
          .eq("id", canonicalSetId)

        if (updateError) {
          throw new Error(`Failed to prepare drawing set: ${updateError.message}`)
        }

        const reusedSet = await getDrawingSet(canonicalSetId)
        if (!reusedSet) {
          throw new Error("Prepared drawing set could not be loaded")
        }
        drawingSet = reusedSet
      } else {
        drawingSet = await createDrawingSet({
          project_id: input.projectId,
          title: input.title || `${project.name} Drawings`,
          set_type: input.setType as any,
          source_file_id: fileRecord.id,
        })

        const { error: stageError } = await supabase
          .from("drawing_sets")
          .update({ status: "ready", processing_stage: "ready" })
          .eq("org_id", orgId)
          .eq("id", drawingSet.id)

        if (stageError) {
          console.warn("Failed to set initial set status:", stageError.message)
        }
      }

      // Create the draft revision the worker will process into. Default label is a
      // sensible issuance name the user can rename at publish time.
      const { count: publishedCount } = await supabase
        .from("drawing_revisions")
        .select("*", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("project_id", input.projectId)
        .eq("status", "published")

      const defaultLabel = !publishedCount ? "Initial Set" : `Revision ${publishedCount + 1}`
      const cleanLabel = input.issuanceLabel?.trim() || defaultLabel

      const { data: draftRevision, error: draftError } = await supabase
        .from("drawing_revisions")
        .insert({
          org_id: orgId,
          project_id: input.projectId,
          drawing_set_id: drawingSet.id,
          revision_label: cleanLabel,
          issuance_type: input.issuanceType ?? "revision",
          status: "processing",
          processing_stage: "queued",
          issued_date: input.issuedDate || new Date().toISOString(),
          issued_by: input.issuedBy?.trim() || null,
          received_from: input.receivedFrom?.trim() || null,
          notes: input.notes?.trim() || null,
          source_file_id: fileRecord.id,
        })
        .select("id")
        .single()

      if (draftError || !draftRevision) {
        // The one-pending-draft-per-project unique index can fire on a
        // concurrent-upload race that slips past the pre-check above; surface
        // the same friendly message the pre-check uses.
        if (draftError?.code === "23505") {
          throw new Error("A revision is already pending review. Publish or discard it before uploading another.")
        }
        throw new Error(`Failed to create draft revision: ${draftError?.message}`)
      }

      const draftRevisionId = draftRevision.id as string
      const drawingsVisionConfig = await getPlatformAiFeatureDefaultConfig({
        supabase,
        feature: "drawings_vision",
      })

      // Trigger processing via outbox system
      try {
        console.log(`[Upload] Queueing processing jobs for drawing set: ${drawingSet.id}`)

        // Queue a job to process the drawing set and create individual sheets
        const { error: jobError } = await supabase
          .from("outbox")
          .insert({
            org_id: orgId,
            job_type: "process_drawing_set",
            payload: {
              drawingSetId: drawingSet.id,
              projectId: input.projectId,
              sourceFileId: fileRecord.id,
              storagePath: fileRecord.storage_path,
              draftRevisionId,
              orgId: orgId,
              targetSheetId: targetSheet?.id,
              aiVision: {
                provider: drawingsVisionConfig.provider,
                model: drawingsVisionConfig.model,
                source: drawingsVisionConfig.source,
              },
            },
            run_at: new Date().toISOString(),
          })

        if (jobError) {
          console.error("Failed to queue processing job:", jobError)
          // Mark the draft revision failed so the review UI can react.
          await supabase
            .from("drawing_revisions")
            .update({ processing_stage: "failed", error_message: "Failed to queue processing job" })
            .eq("org_id", orgId)
            .eq("id", draftRevisionId)
        } else {
          console.log(`[Upload] Successfully queued processing job for drawing set: ${drawingSet.id}`)
          // Best-effort fast path; the process-outbox cron drains the queue if
          // this kick fails, so the job is never lost.
          const trigger = await triggerDrawingsPipeline()
          if (!trigger.triggered) {
            console.warn("[Upload] Drawings pipeline kick failed (cron will pick up):", trigger.error)
          }
        }
      } catch (error) {
        console.error("Failed to queue processing job:", error)
        // The draft revision stays in "processing" - the cron retries it.
      }

      revalidatePath("/drawings")
      revalidatePath(`/projects/${input.projectId}`)

      return { set: drawingSet, draftRevisionId }
  })
}

/**
 * Retry a failed draft revision. Resets the failure state and requeues the
 * processing job for the revision (idempotent: already-processed pages are
 * skipped by the pipeline).
 */
export async function retryDraftRevisionAction(revisionId: string): Promise<ActionResult<void>> {
  return run(async () => {
      const { supabase, orgId } = await requireOrgContext()
      await requireAnyPermission(["drawing.upload", "org.admin"])

      const { data: revision, error } = await supabase
        .from("drawing_revisions")
        .select("id, project_id, drawing_set_id, status, processing_stage, source_file_id")
        .eq("org_id", orgId)
        .eq("id", revisionId)
        .maybeSingle()
      if (error || !revision) {
        throw new Error("Revision not found")
      }
      if (revision.status === "published") {
        throw new Error("Revision is already published")
      }

      if (!revision.source_file_id) {
        throw new Error("Revision has no source file to reprocess")
      }

      const { data: fileData } = await supabase
        .from("files")
        .select("storage_path")
        .eq("id", revision.source_file_id)
        .single()
      if (!fileData?.storage_path) {
        throw new Error("Source file not found")
      }

      await supabase
        .from("drawing_revisions")
        .update({ status: "processing", processing_stage: "queued", error_message: null })
        .eq("org_id", orgId)
        .eq("id", revisionId)

      // Clear any stuck jobs for this revision, then requeue the split job. The
      // pipeline skips pages that already have versions, so this is safe.
      await supabase
        .from("outbox")
        .update({ status: "completed", last_error: "Superseded by manual retry" })
        .in("job_type", [
          "process_drawing_set",
          "process_drawing_page",
          "split_drawing_chunk",
          "enrich_drawing_metadata",
        ])
        .in("status", ["pending", "failed"])
        .contains("payload", { draftRevisionId: revisionId })

      const drawingsVisionConfig = await getPlatformAiFeatureDefaultConfig({
        supabase,
        feature: "drawings_vision",
      })

      const { error: jobError } = await supabase.from("outbox").insert({
        org_id: orgId,
        job_type: "process_drawing_set",
        payload: {
          drawingSetId: revision.drawing_set_id,
          orgId,
          projectId: revision.project_id,
          sourceFileId: revision.source_file_id,
          storagePath: fileData.storage_path,
          draftRevisionId: revisionId,
          aiVision: {
            provider: drawingsVisionConfig.provider,
            model: drawingsVisionConfig.model,
            source: drawingsVisionConfig.source,
          },
        },
        run_at: new Date().toISOString(),
      })
      if (jobError) {
        throw new Error(`Failed to requeue processing: ${jobError.message}`)
      }

      await triggerDrawingsPipeline()
      revalidatePath("/drawings")
      revalidatePath(`/projects/${revision.project_id}`)
  })
}

/**
 * Retry processing a failed drawing set. Also handles the common case where
 * the failure lives on the pending draft revision rather than the set row.
 */
export async function retryProcessingAction(setId: string): Promise<ActionResult<DrawingSet>> {
  return run(async () => {
      const { supabase, orgId } = await requireOrgContext()
      await requireAnyPermission(["drawing.upload", "org.admin"])

      const set = await getDrawingSet(setId)
      if (!set) {
        throw new Error("Drawing set not found")
      }

      if (set.status !== "failed") {
        // Single-register flow: the set stays "ready" while a draft revision
        // processes, so look for a failed/stuck draft revision to retry instead.
        const { data: failedRevision } = await supabase
          .from("drawing_revisions")
          .select("id")
          .eq("org_id", orgId)
          .eq("project_id", set.project_id)
          .in("status", ["processing", "draft"])
          .in("processing_stage", ["failed", "worker_unavailable", "queued"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()

        if (failedRevision) {
          unwrapAction(await retryDraftRevisionAction(failedRevision.id))
          return set
        }

        throw new Error("Can only retry failed drawing sets")
      }

      // Reset status to processing
      const updated = await updateDrawingSet(setId, {
        status: "processing",
        error_message: null,
        processed_pages: 0,
      })

      await supabase
        .from("drawing_sets")
        .update({
          processing_stage: "queued",
          total_pages: null,
          processed_at: null,
        })
        .eq("org_id", orgId)
        .eq("id", setId)

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

      const drawingsVisionConfig = await getPlatformAiFeatureDefaultConfig({
        supabase,
        feature: "drawings_vision",
      })

      // Queue processing again (worker path supports R2-backed uploads)
      try {
        const { error: jobError } = await supabase
          .from("outbox")
          .insert({
            org_id: orgId,
            job_type: "process_drawing_set",
            payload: {
              drawingSetId: set.id,
              orgId,
              projectId: set.project_id,
              sourceFileId: set.source_file_id,
              storagePath: fileData.storage_path,
              aiVision: {
                provider: drawingsVisionConfig.provider,
                model: drawingsVisionConfig.model,
                source: drawingsVisionConfig.source,
              },
            },
            run_at: new Date().toISOString(),
          })

        if (jobError) {
          console.error("Failed to queue drawing processing:", jobError)
          await updateDrawingSet(set.id, {
            status: "failed",
            error_message: "Failed to queue processing",
          })
        } else {
          const trigger = await triggerDrawingsPipeline()
          if (!trigger.triggered) {
            console.warn("[Retry] Drawings pipeline kick failed (cron will pick up):", trigger.error)
          }
        }
      } catch (error) {
        console.error("Failed to queue drawing processing:", error)
      }

      revalidatePath("/drawings")
      revalidatePath(`/projects/${set.project_id}`)

      return updated
  })
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
): Promise<ActionResult<DrawingRevision>> {
  return run(async () => {
      await requireAnyPermission(["drawing.upload", "org.admin"])
      const result = await createDrawingRevision(input)
      revalidatePath("/drawings")
      revalidatePath(`/projects/${input.project_id}`)
      return result
  })
}

/**
 * Update a revision
 */
export async function updateDrawingRevisionAction(
  revisionId: string,
  updates: DrawingRevisionUpdate
): Promise<ActionResult<DrawingRevision>> {
  return run(async () => {
      await requireAnyPermission(["drawing.upload", "org.admin"])
      const result = await updateDrawingRevision(revisionId, updates)
      revalidatePath("/drawings")
      revalidatePath(`/projects/${result.project_id}`)
      return result
  })
}

/**
 * Delete a revision
 */
export async function deleteDrawingRevisionAction(revisionId: string): Promise<ActionResult<void>> {
  return run(async () => {
      await requireAnyPermission(["docs.delete", "org.admin"])
      const revision = await getDrawingRevision(revisionId)
      await deleteDrawingRevision(revisionId)
      revalidatePath("/drawings")
      if (revision?.project_id) {
        revalidatePath(`/projects/${revision.project_id}`)
      }
  })
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
      return listDrawingSheetsWithUrls(filters)
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
 * Get the register as it stood at a chosen revision (one version per sheet).
 */
export async function getDrawingRegisterSnapshotAction(
  drawingSetId: string,
  revisionId: string
): Promise<DrawingSheet[]> {
      return getDrawingRegisterSnapshot(drawingSetId, revisionId)
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
): Promise<ActionResult<DrawingSheet>> {
  return run(async () => {
      await requireAnyPermission(["drawing.upload", "org.admin"])
      const result = await createDrawingSheet(input)
      revalidatePath("/drawings")
      revalidatePath(`/projects/${input.project_id}`)
      return result
  })
}

/**
 * Update a sheet
 */
export async function updateDrawingSheetAction(
  sheetId: string,
  updates: DrawingSheetUpdate
): Promise<ActionResult<DrawingSheet>> {
  return run(async () => {
      const changesSharing =
        updates.share_with_clients !== undefined || updates.share_with_subs !== undefined
      await requireAnyPermission(
        changesSharing ? ["docs.share", "org.admin"] : ["drawing.upload", "org.admin"],
      )
      const result = await updateDrawingSheet(sheetId, updates)
      revalidatePath("/drawings")
      revalidatePath(`/projects/${result.project_id}`)
      return result
  })
}

/**
 * Bulk update sheet sharing settings
 */
export async function bulkUpdateSheetSharingAction(
  sheetIds: string[],
  sharing: { share_with_clients?: boolean; share_with_subs?: boolean }
): Promise<ActionResult<void>> {
  return run(async () => {
      await requireAnyPermission(["docs.share", "org.admin"])
      await bulkUpdateSheetSharing(sheetIds, sharing)
      revalidatePath("/drawings")
  })
}

/**
 * Delete a sheet
 */
export async function deleteDrawingSheetAction(sheetId: string): Promise<ActionResult<void>> {
  return run(async () => {
      await requireAnyPermission(["docs.delete", "org.admin"])
      const sheet = await getDrawingSheet(sheetId)
      await deleteDrawingSheet(sheetId)
      revalidatePath("/drawings")
      if (sheet?.project_id) {
        revalidatePath(`/projects/${sheet.project_id}`)
      }
  })
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
      const { supabase, orgId, userId } = await requireOrgContext()
      await requirePermission("drawing.read", { supabase, orgId, userId })
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

      const buildPublicImageUrl = (path?: string | null) => buildDrawingsImageUrl(path)

      const maybeSignLegacy = async (value: string | null | undefined): Promise<string | null> => {
        if (!value) return null
        if (value.includes("token=")) return value
        // If value is already pointing to drawings-images and public, return as-is
        if (value.includes("/drawings-images/")) return value

        const storagePath = extractProjectFilesPath(value)
        if (!storagePath) return value

        try {
          return await getDrawingPdfSignedUrl({
            supabase,
            orgId,
            path: storagePath,
            expiresIn,
          })
        } catch (error) {
          console.error("Failed to sign image URL:", error)
          return null
        }
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

  const markers = [
    "/storage/v1/object/public/project-files/",
    "/project-files/",
  ]

  for (const marker of markers) {
    const idx = urlOrPath.indexOf(marker)
    if (idx === -1) continue
    const path = urlOrPath.slice(idx + marker.length)
    if (path) return decodeURIComponent(path)
  }

  return null
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
 * Get the dimension-tool calibration for a sheet's current version.
 * Null when the sheet has no published version.
 */
export async function getSheetCalibrationAction(
  sheetId: string
): Promise<SheetCalibration | null> {
      return getSheetCalibration(sheetId)
}

/**
 * Save two-point scale calibration on a sheet version
 */
export async function setSheetVersionCalibrationAction(
  input: SetSheetVersionCalibrationInput
): Promise<ActionResult<SheetCalibration>> {
  return run(async () => {
      const result = await setSheetVersionCalibration(input)
      revalidatePath("/drawings")
      return result
  })
}

/**
 * Create a sheet version
 */
export async function createSheetVersionAction(
  input: DrawingSheetVersionInput
): Promise<ActionResult<DrawingSheetVersion>> {
  return run(async () => {
      await requireAnyPermission(["drawing.upload", "org.admin"])
      const result = await createSheetVersion(input)
      revalidatePath("/drawings")
      return result
  })
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
        .in("status", ["active", "on_hold"])
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
export async function queueTileGenerationForExistingSheetsAction(): Promise<ActionResult<{
  queued: number
}>> {
  return run(async () => {
      // Queueing uses service role to avoid RLS/NOT NULL issues.
      const { supabase, orgId } = await requireOrgContext()
      await requireAnyPermission(["org.admin"])
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

      const trigger = await triggerDrawingsPipeline()
      if (!trigger.triggered) {
        console.warn("[TileBackfill] Drawings pipeline kick failed (cron will pick up):", trigger.error)
      }

      revalidatePath("/drawings")
      revalidatePath("/drawings/debug")

      return { queued: jobs.length }
  })
}

/**
 * Refresh the drawing sheets list materialized view
 */
export async function refreshDrawingSheetsListAction(): Promise<ActionResult<void>> {
  return run(async () => {
      await requireOrgContext()
      const supabase = createServiceSupabaseClient()

      const { error } = await supabase.rpc("refresh_drawing_sheets_list")
      if (error) {
        throw new Error(`Failed to refresh drawing sheets list: ${error.message}`)
      }
  })
}

/**
 * Get drawing set processing status
 */
export async function getProcessingStatusAction(setId: string): Promise<{
  status: string
  processed_pages: number
  total_pages?: number
  processing_stage?: string
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
        processing_stage: set.processing_stage,
        error_message: set.error_message,
      }
}

export async function listUploadedSheetsAction(
  sourceFileId: string
): Promise<UploadReviewSheet[]> {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requirePermission("drawing.read", { supabase, orgId, userId })
      const service = createServiceSupabaseClient()

      const { data: versions, error: versionsError } = await service
        .from("drawing_sheet_versions")
        .select("drawing_sheet_id")
        .eq("org_id", orgId)
        .eq("file_id", sourceFileId)

      if (versionsError) {
        throw new Error(`Failed to load uploaded sheets: ${versionsError.message}`)
      }

      const sheetIds = Array.from(
        new Set(
          (versions ?? [])
            .map((row) => row.drawing_sheet_id)
            .filter((value): value is string => typeof value === "string"),
        ),
      )

      if (sheetIds.length === 0) return []

      const { data: sheets, error: sheetsError } = await service
        .from("drawing_sheets")
        .select(
          "id, drawing_set_id, sheet_number, sheet_title, discipline, sort_order, updated_at",
        )
        .eq("org_id", orgId)
        .in("id", sheetIds)
        .order("sort_order", { ascending: true })

      if (sheetsError) {
        throw new Error(`Failed to load uploaded sheet rows: ${sheetsError.message}`)
      }

      return (sheets ?? []).map((sheet) => ({
        id: sheet.id,
        drawing_set_id: sheet.drawing_set_id,
        sheet_number: sheet.sheet_number,
        sheet_title: sheet.sheet_title ?? undefined,
        discipline: sheet.discipline ?? undefined,
        sort_order: sheet.sort_order ?? 0,
        updated_at: sheet.updated_at,
      }))
}

// ============================================================================
// DRAFT REVISION ACTIONS (draft -> publish flow)
// ============================================================================

export async function getDraftRevisionStatusAction(
  revisionId: string,
): Promise<RevisionDraftStatus | null> {
      return getDraftRevisionStatus(revisionId)
}

export async function getPendingDraftRevisionAction(
  projectId: string,
): Promise<RevisionDraftStatus | null> {
      return getPendingDraftRevision(projectId)
}

export async function getRevisionDiffAction(revisionId: string): Promise<RevisionDiff> {
      return getRevisionDiff(revisionId)
}

export async function searchSheetContentAction(
  projectId: string,
  query: string,
): Promise<SheetContentMatch[]> {
      return searchSheetContent(projectId, query)
}

export async function publishRevisionAction(input: PublishRevisionInput): Promise<ActionResult<void>> {
  return run(async () => {
      await requireAnyPermission(["drawing.upload", "org.admin"])
      await publishRevision(input)
      revalidatePath("/drawings")
  })
}

export async function discardRevisionAction(revisionId: string): Promise<ActionResult<void>> {
  return run(async () => {
      await requireAnyPermission(["drawing.upload", "org.admin"])
      await discardRevision(revisionId)
      revalidatePath("/drawings")
  })
}

// ============================================================================
// REVISION DISTRIBUTION ACTIONS
// ============================================================================

export async function listRevisionRecipientsAction(
  revisionId: string,
): Promise<ActionResult<RevisionRecipientList>> {
  return run(() => listRevisionRecipients(revisionId))
}

export async function distributeRevisionAction(
  input: DistributeRevisionInput,
): Promise<ActionResult<DistributeRevisionResult>> {
  return run(async () => {
    await requireAnyPermission(["drawing.upload", "org.admin"])
    return distributeRevision(input)
  })
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
): Promise<ActionResult<DrawingMarkup>> {
  return run(async () => {
      const result = await createDrawingMarkup(input)
      revalidatePath("/drawings")
      return result
  })
}

/**
 * Update a markup
 */
export async function updateDrawingMarkupAction(
  markupId: string,
  updates: DrawingMarkupUpdate
): Promise<ActionResult<DrawingMarkup>> {
  return run(async () => {
      const result = await updateDrawingMarkup(markupId, updates)
      revalidatePath("/drawings")
      return result
  })
}

/**
 * Delete a markup
 */
export async function deleteDrawingMarkupAction(markupId: string): Promise<ActionResult<void>> {
  return run(async () => {
      await deleteDrawingMarkup(markupId)
      revalidatePath("/drawings")
  })
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
): Promise<ActionResult<DrawingPin>> {
  return run(async () => {
      const result = await createDrawingPin(input)
      revalidatePath("/drawings")
      return result
  })
}

/**
 * Update a pin
 */
export async function updateDrawingPinAction(
  pinId: string,
  updates: DrawingPinUpdate
): Promise<ActionResult<DrawingPin>> {
  return run(async () => {
      const result = await updateDrawingPin(pinId, updates)
      revalidatePath("/drawings")
      return result
  })
}

/**
 * Delete a pin
 */
export async function deleteDrawingPinAction(pinId: string): Promise<ActionResult<void>> {
  return run(async () => {
      await deleteDrawingPin(pinId)
      revalidatePath("/drawings")
  })
}

/**
 * Delete pin when entity is deleted
 */
export async function deletePinForEntityAction(
  entityType: PinEntityType,
  entityId: string
): Promise<ActionResult<void>> {
  return run(async () => {
      await deletePinForEntity(entityType, entityId)
      revalidatePath("/drawings")
  })
}

// ============================================================================
// CREATE ENTITY FROM DRAWING (MVP)
// ============================================================================

export async function createTaskFromDrawingAction(projectId: string, input: unknown) {
  return run(async () => {
      const task = unwrapAction(await createProjectTaskAction(projectId, input))
      return task
  })
}

export async function createRfiFromDrawingAction(input: {
  projectId: string
  subject: string
  question: string
  priority?: "low" | "normal" | "high" | "urgent"
}) {
  return run(async () => {
      return createRfi({
        input: {
          project_id: input.projectId,
          subject: input.subject,
          question: input.question,
          status: "open",
          priority: input.priority ?? "normal",
          due_date: null,
          attachment_file_id: null,
        },
      })
  })
}

export async function createPunchItemFromDrawingAction(input: {
  projectId: string
  title: string
  description?: string
  location?: string
  severity?: string
}) {
  return run(async () => {
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
  })
}

/**
 * Attach a photo to a drawing location: the image file is already uploaded
 * via the standard files path; this records the photos row and drops the pin.
 * Mirrors createTaskFromDrawingAction's shape (create entity, then pin).
 */
export async function createPhotoFromDrawingAction(
  input: CreatePhotoFromDrawingInput
): Promise<ActionResult<DrawingPin>> {
  return run(async () => {
      const parsed = createPhotoFromDrawingInputSchema.parse(input)
      const { supabase, orgId, userId } = await requireOrgContext()
      await requirePermission("drawing.markup", { supabase, orgId, userId })

      const { data: file, error: fileError } = await supabase
        .from("files")
        .select("id, file_name")
        .eq("org_id", orgId)
        .eq("id", parsed.file_id)
        .eq("project_id", parsed.project_id)
        .maybeSingle()

      if (fileError || !file) {
        throw new Error("Uploaded photo file not found")
      }

      const { data: photo, error: photoError } = await supabase
        .from("photos")
        .insert({
          org_id: orgId,
          project_id: parsed.project_id,
          file_id: parsed.file_id,
          captured_by: userId,
          taken_at: new Date().toISOString(),
          tags: ["drawing"],
        })
        .select("id")
        .single()

      if (photoError || !photo) {
        throw new Error(`Failed to save photo: ${photoError?.message}`)
      }

      await recordEvent({
        orgId,
        eventType: "photo_created",
        entityType: "photo",
        entityId: photo.id as string,
        payload: {
          project_id: parsed.project_id,
          drawing_sheet_id: parsed.drawing_sheet_id,
        },
      })

      await recordAudit({
        orgId,
        actorId: userId,
        action: "insert",
        entityType: "photo",
        entityId: photo.id as string,
        after: {
          project_id: parsed.project_id,
          file_id: parsed.file_id,
          drawing_sheet_id: parsed.drawing_sheet_id,
        },
      })

      const pin = await createDrawingPin({
        project_id: parsed.project_id,
        drawing_sheet_id: parsed.drawing_sheet_id,
        x_position: parsed.x_position,
        y_position: parsed.y_position,
        entity_type: "photo",
        entity_id: photo.id as string,
        label: parsed.caption?.trim() || file.file_name,
      })

      revalidatePath("/drawings")
      return { ...pin, entity_title: pin.label }
  })
}

/**
 * Load the photo behind a photo pin for the viewer popover. The URL is the
 * authenticated in-app raw route, so no signed URL is minted per pin.
 */
export async function getPhotoForPinAction(photoId: string): Promise<{
  id: string
  file_id: string
  file_name: string | null
  url: string
  taken_at: string | null
} | null> {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requirePermission("drawing.read", { supabase, orgId, userId })

      const { data: photo, error } = await supabase
        .from("photos")
        .select("id, file_id, taken_at")
        .eq("org_id", orgId)
        .eq("id", photoId)
        .maybeSingle()

      if (error) {
        throw new Error(`Failed to load photo: ${error.message}`)
      }
      if (!photo?.file_id) return null

      const { data: file } = await supabase
        .from("files")
        .select("id, file_name")
        .eq("org_id", orgId)
        .eq("id", photo.file_id)
        .maybeSingle()

      return {
        id: photo.id,
        file_id: photo.file_id,
        file_name: file?.file_name ?? null,
        url: buildInternalFileUrl(photo.file_id),
        taken_at: photo.taken_at ?? null,
      }
}

/**
 * Sync pin status with entity status
 */
export async function syncPinStatusAction(
  entityType: PinEntityType,
  entityId: string,
  newStatus: PinStatus
): Promise<ActionResult<void>> {
  return run(async () => {
      await syncPinStatus(entityType, entityId, newStatus)
      revalidatePath("/drawings")
  })
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
