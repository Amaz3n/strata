import "server-only"

/**
 * Vercel-native drawings processing pipeline.
 *
 * Replaces the Cloud Run drawings worker. Jobs flow through the existing
 * `outbox` table (claimed atomically via the `claim_jobs` RPC) and are
 * processed inside the Next.js app:
 *
 *   process_drawing_set   -> split: count pages, extract text, upload one
 *                            single-page PDF per page, fan out page jobs
 *   process_drawing_page  -> render page (MuPDF WASM), detect title-block
 *                            metadata (regex + AI vision), create the draft
 *                            sheet/version, generate the tile pyramid inline
 *   generate_drawing_tiles-> backfill tiles for an existing sheet version
 *
 * Pages process independently, so a 100-sheet set fans out across
 * invocations instead of running one long sequential loop.
 */

import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import sharp from "sharp"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadDrawingPdfObject } from "@/lib/storage/drawings-pdfs-storage"
import {
  deleteTilesObjects,
  uploadTilesObject,
  downloadTilesObject,
} from "@/lib/storage/drawings-tiles-storage"
import { buildDrawingsTilesBaseUrl } from "@/lib/storage/drawings-urls"
import { triggerDrawingsPipeline } from "@/lib/services/drawings-pipeline-trigger"

// ============================================================================
// Constants (mirrors the retired Cloud Run worker)
// ============================================================================

export const DRAWING_PIPELINE_JOB_TYPES = [
  "process_drawing_set",
  "process_drawing_page",
  "generate_drawing_tiles",
] as const

const SHEET_NUMBER_MAX_LENGTH = 50
const SHEET_TITLE_MAX_LENGTH = 255
const PAGE_TEXT_PAYLOAD_MAX_CHARS = 4000
const RENDER_DPI = Number.parseInt(process.env.DRAWINGS_TILE_RENDER_DPI ?? "96", 10)
const TILE_SIZE = Number.parseInt(process.env.DRAWINGS_TILE_SIZE ?? "512", 10)
const TILE_FORMAT = "png"
const TILE_UPLOAD_CONCURRENCY = Number.parseInt(
  process.env.DRAWINGS_TILE_UPLOAD_CONCURRENCY ?? "12",
  10,
)
const MAX_JOB_RETRIES = 3
const STALE_PROCESSING_MINUTES = 15

const DISCIPLINE_CODES = new Set([
  "A", "S", "M", "E", "P", "C", "L", "I", "FP", "G", "T", "SP", "D", "X",
])

const SHEET_LABEL_PATTERNS = [
  /\b(?:SHEET|SHT)\s*(?:NO|NUMBER|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9./-]{1,19})\b/i,
  /\b(?:DWG|DRAWING)\s*(?:NO|NUMBER|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9./-]{1,19})\b/i,
]

const SHEET_TITLE_LABEL_PATTERNS = [
  /\b(?:SHEET\s+TITLE|DRAWING\s+TITLE)\s*[:\-]\s*(.+)$/i,
  /\bTITLE\s*[:\-]\s*(.+)$/i,
]

const GENERIC_SHEET_NUMBER_PATTERN = /\b(?:FP|SP|[ASMEPCLIGTDX])[-./]?\d{1,4}(?:\.\d{1,3})?[A-Z]?\b/gi

type DetectionMethod = "label" | "pattern" | "fallback"
type DetectionConfidence = "high" | "medium" | "low"

type DetectedSheetMetadata = {
  sheetNumber: string
  sheetTitle: string
  discipline: string
  method: DetectionMethod
  confidence: DetectionConfidence
  sourceLine: string | null
}

type VisionSheetMetadata = {
  sheetNumber?: string | null
  sheetTitle?: string | null
  discipline?: string | null
  confidence?: DetectionConfidence
  notes?: string[]
}

type VisionProvider = "google" | "openai"

interface ClaimedJob {
  job_id: number
  org_id: string
  job_type: string
  payload: Record<string, any>
  retry_count: number
}

// ============================================================================
// MuPDF (WASM) helpers
// ============================================================================

type MupdfModule = typeof import("mupdf")

let mupdfModulePromise: Promise<MupdfModule> | null = null

function loadMupdf(): Promise<MupdfModule> {
  if (!mupdfModulePromise) {
    mupdfModulePromise = import("mupdf")
  }
  return mupdfModulePromise
}

function extractPageTextLines(page: any): string[] {
  try {
    const stext = JSON.parse(page.toStructuredText("preserve-whitespace").asJSON())
    const lines: string[] = []
    for (const block of stext.blocks ?? []) {
      for (const line of block.lines ?? []) {
        if (typeof line.text === "string" && line.text.trim()) {
          lines.push(normalizeWhitespace(line.text).trim())
        } else if (Array.isArray(line.spans)) {
          const text = line.spans.map((span: any) => span.text ?? "").join("")
          if (text.trim()) lines.push(normalizeWhitespace(text).trim())
        }
      }
    }
    return lines.filter(Boolean)
  } catch (error) {
    console.warn("[drawings-pipeline] Failed to extract page text:", error)
    return []
  }
}

function renderPagePng(mupdf: MupdfModule, page: any): { png: Buffer; width: number; height: number } {
  const dpi = Number.isFinite(RENDER_DPI) && RENDER_DPI > 0 ? RENDER_DPI : 96
  const pixmap = page.toPixmap(
    mupdf.Matrix.scale(dpi / 72, dpi / 72),
    mupdf.ColorSpace.DeviceRGB,
    false,
    true,
  )
  try {
    return {
      png: Buffer.from(pixmap.asPNG()),
      width: pixmap.getWidth(),
      height: pixmap.getHeight(),
    }
  } finally {
    pixmap.destroy?.()
  }
}

// ============================================================================
// Public entry points
// ============================================================================

export interface PipelineRunSummary {
  processed: number
  failed: number
  remaining: number
}

/**
 * Claim and process drawing jobs until the queue is drained or the deadline
 * passes. Safe to run concurrently across invocations (claim_jobs uses
 * FOR UPDATE SKIP LOCKED).
 */
export async function runDrawingsPipeline(options: { deadlineMs?: number } = {}): Promise<PipelineRunSummary> {
  const deadline = options.deadlineMs ?? Date.now() + 240_000
  const supabase = createServiceSupabaseClient()
  const summary: PipelineRunSummary = { processed: 0, failed: 0, remaining: 0 }

  await resetStaleProcessingJobs(supabase)

  while (Date.now() < deadline) {
    const { data, error } = await supabase.rpc("claim_jobs", {
      job_types: [...DRAWING_PIPELINE_JOB_TYPES],
      limit_value: 3,
    })

    if (error) {
      console.error("[drawings-pipeline] Failed to claim jobs:", error.message)
      break
    }

    const jobs = (data ?? []) as ClaimedJob[]
    if (jobs.length === 0) break

    for (const job of jobs) {
      const ok = await processJob(supabase, job)
      if (ok) summary.processed += 1
      else summary.failed += 1
      if (Date.now() >= deadline) break
    }
  }

  const { count } = await supabase
    .from("outbox")
    .select("id", { count: "exact", head: true })
    .in("job_type", [...DRAWING_PIPELINE_JOB_TYPES])
    .eq("status", "pending")
    .lte("run_at", new Date().toISOString())
  summary.remaining = count ?? 0

  return summary
}

/** True when there are runnable drawing jobs waiting in the outbox. */
export async function hasPendingDrawingJobs(): Promise<boolean> {
  const supabase = createServiceSupabaseClient()
  const { count } = await supabase
    .from("outbox")
    .select("id", { count: "exact", head: true })
    .in("job_type", [...DRAWING_PIPELINE_JOB_TYPES])
    .eq("status", "pending")
    .lte("run_at", new Date().toISOString())
  return (count ?? 0) > 0
}

async function resetStaleProcessingJobs(supabase: SupabaseClient) {
  // A crashed invocation can leave claimed jobs stuck in "processing" —
  // return them to the queue after a grace period so nothing is stranded.
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MINUTES * 60_000).toISOString()
  const { error } = await supabase
    .from("outbox")
    .update({ status: "pending" })
    .in("job_type", [...DRAWING_PIPELINE_JOB_TYPES])
    .eq("status", "processing")
    .lt("updated_at", cutoff)
  if (error) {
    console.warn("[drawings-pipeline] Failed to reset stale jobs:", error.message)
  }
}

async function processJob(supabase: SupabaseClient, job: ClaimedJob): Promise<boolean> {
  const startedAt = Date.now()
  try {
    switch (job.job_type) {
      case "process_drawing_set":
        await handleProcessDrawingSet(supabase, job)
        break
      case "process_drawing_page":
        await handleProcessDrawingPage(supabase, job)
        break
      case "generate_drawing_tiles":
        await handleGenerateDrawingTiles(supabase, job)
        break
      default:
        throw new Error(`Unknown drawings job type: ${job.job_type}`)
    }

    await supabase
      .from("outbox")
      .update({ status: "completed", last_error: null })
      .eq("id", job.job_id)

    console.log(
      `[drawings-pipeline] ${job.job_type} #${job.job_id} completed in ${Date.now() - startedAt}ms`,
    )
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const newRetryCount = job.retry_count + 1
    const shouldRetry = newRetryCount < MAX_JOB_RETRIES

    console.error(
      `[drawings-pipeline] ${job.job_type} #${job.job_id} failed (retry ${job.retry_count} -> ${newRetryCount}, willRetry=${shouldRetry}):`,
      message,
    )

    await supabase
      .from("outbox")
      .update({
        status: shouldRetry ? "pending" : "failed",
        retry_count: newRetryCount,
        last_error: message,
        run_at: shouldRetry
          ? new Date(Date.now() + Math.pow(2, newRetryCount) * 60_000).toISOString()
          : undefined,
      })
      .eq("id", job.job_id)

    if (!shouldRetry) {
      await markRevisionFailed(supabase, job, message)
    }
    return false
  }
}

async function markRevisionFailed(supabase: SupabaseClient, job: ClaimedJob, message: string) {
  const revisionId =
    typeof job.payload?.draftRevisionId === "string" ? job.payload.draftRevisionId : null
  if (!revisionId) return
  if (job.job_type !== "process_drawing_set" && job.job_type !== "process_drawing_page") return

  try {
    await supabase
      .from("drawing_revisions")
      .update({ processing_stage: "failed", error_message: message })
      .eq("id", revisionId)
      .neq("status", "published")
  } catch (error) {
    console.warn("[drawings-pipeline] Failed to mark revision failed:", error)
  }
}

// ============================================================================
// Job: process_drawing_set (split + fan out)
// ============================================================================

async function handleProcessDrawingSet(supabase: SupabaseClient, job: ClaimedJob) {
  const payload = job.payload ?? {}
  const drawingSetId = requireString(payload.drawingSetId, "drawingSetId")
  const projectId = requireString(payload.projectId, "projectId")
  const sourceFileId = requireString(payload.sourceFileId, "sourceFileId")
  const orgId = requireString(payload.orgId ?? job.org_id, "orgId")
  const targetSheetId = typeof payload.targetSheetId === "string" ? payload.targetSheetId : null
  let draftRevisionId =
    typeof payload.draftRevisionId === "string" ? payload.draftRevisionId : null

  const { data: drawingSet, error: setError } = await supabase
    .from("drawing_sets")
    .select("id, org_id, project_id, title")
    .eq("id", drawingSetId)
    .eq("org_id", orgId)
    .single()
  if (setError || !drawingSet) {
    throw new Error(`Drawing set not found: ${setError?.message ?? drawingSetId}`)
  }

  const { data: fileRecord, error: fileError } = await supabase
    .from("files")
    .select("id, file_name, storage_path")
    .eq("id", sourceFileId)
    .single()
  if (fileError || !fileRecord?.storage_path) {
    throw new Error(`Source file not found: ${fileError?.message ?? sourceFileId}`)
  }

  // Legacy safety net: uploads always create a draft revision, but keep the
  // fallback the worker had for jobs enqueued without one.
  if (!draftRevisionId) {
    const { count } = await supabase
      .from("drawing_revisions")
      .select("*", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "published")
    const fallbackLabel = !count ? "Initial Set" : `Revision ${count + 1}`
    const { data: created, error: createError } = await supabase
      .from("drawing_revisions")
      .insert({
        org_id: orgId,
        project_id: projectId,
        drawing_set_id: drawingSetId,
        revision_label: fallbackLabel,
        status: "processing",
        processing_stage: "queued",
        source_file_id: sourceFileId,
      })
      .select("id")
      .single()
    if (createError || !created) {
      throw new Error(`Failed to create draft revision: ${createError?.message}`)
    }
    draftRevisionId = created.id as string
  }

  // If this revision already fanned out page jobs (retry of a partially
  // completed split), don't fan out twice.
  const { count: existingPageJobs } = await supabase
    .from("outbox")
    .select("id", { count: "exact", head: true })
    .eq("job_type", "process_drawing_page")
    .contains("payload", { draftRevisionId })
  if ((existingPageJobs ?? 0) > 0) {
    console.log(`[drawings-pipeline] Split already fanned out for revision ${draftRevisionId}, skipping`)
    return
  }

  await updateRevisionStage(supabase, draftRevisionId, {
    status: "processing",
    processing_stage: "downloading_pdf",
    processed_pages: 0,
    error_message: null,
  })

  const pdfBytes = await downloadDrawingPdfObject({
    supabase,
    orgId,
    path: fileRecord.storage_path,
  })
  const sourceHash = createHash("sha256").update(pdfBytes).digest("hex").slice(0, 16)

  const mupdf = await loadMupdf()
  const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf")
  const pageCount = doc.countPages()
  if (!Number.isFinite(pageCount) || pageCount <= 0) {
    throw new Error(`Invalid PDF page count: ${pageCount}`)
  }

  await updateRevisionStage(supabase, draftRevisionId, {
    processing_stage: "extracting_text",
    total_pages: pageCount,
  })

  let targetSheet: { id: string; sheet_number: string; sheet_title?: string | null; discipline?: string | null } | null = null
  if (targetSheetId) {
    const { data, error } = await supabase
      .from("drawing_sheets")
      .select("id, sheet_number, sheet_title, discipline")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("id", targetSheetId)
      .maybeSingle()
    if (error || !data) {
      throw new Error(`Target sheet not found for one-sheet revision: ${error?.message ?? targetSheetId}`)
    }
    targetSheet = data
  }

  const setTitle = (drawingSet.title as string) || "Drawings"
  const usedSheetNumbers = new Set<string>()
  const pageJobs: Array<Record<string, any>> = []

  // Split pages in chunks: grafting is synchronous CPU, but the per-page PDF
  // uploads run in parallel within each chunk (bounded so a huge set doesn't
  // hold every page buffer in memory at once).
  const SPLIT_UPLOAD_CONCURRENCY = 8
  for (let chunkStart = 0; chunkStart < pageCount; chunkStart += SPLIT_UPLOAD_CONCURRENCY) {
    const chunkEnd = Math.min(chunkStart + SPLIT_UPLOAD_CONCURRENCY, pageCount)
    const uploads: Promise<void>[] = []

    for (let pageIndex = chunkStart; pageIndex < chunkEnd; pageIndex++) {
      const page = doc.loadPage(pageIndex)
      const textLines = extractPageTextLines(page)
      const pageText = textLines.join("\n")
      const pageNumber = pageIndex + 1

      const detected = detectSheetMetadata({ pageText, setTitle, pageNumber })

      // Assign a tentative sheet number that is unique within this upload. Page
      // jobs run in parallel, so cross-page uniqueness has to be decided here.
      const isTargetPage = Boolean(targetSheet && pageIndex === 0)
      const tentativeSheetNumber = isTargetPage
        ? truncateValue(targetSheet!.sheet_number || detected.sheetNumber, SHEET_NUMBER_MAX_LENGTH)
        : ensureUniqueSheetNumber(detected.sheetNumber, pageNumber, usedSheetNumbers)
      if (isTargetPage) usedSheetNumbers.add(tentativeSheetNumber.toUpperCase())

      // One single-page PDF per page so page jobs don't re-download the full set.
      const pagePdfPath = `${orgId}/${sourceHash}/temp/page-${pageIndex}.pdf`
      const single = new mupdf.PDFDocument()
      single.graftPage(0, doc as any, pageIndex)
      const singleBytes = single.saveToBuffer("compress").asUint8Array()
      single.destroy?.()
      uploads.push(
        uploadTilesObject({
          supabase,
          path: pagePdfPath,
          bytes: Buffer.from(singleBytes),
          contentType: "application/pdf",
          cacheControl: "private, max-age=3600",
        }),
      )

      pageJobs.push(buildPageJob({
        orgId,
        projectId,
        drawingSetId,
        draftRevisionId,
        sourceFileId,
        sourceHash,
        pageIndex,
        pageCount,
        setTitle,
        pagePdfPath,
        pageText,
        detected,
        tentativeSheetNumber,
        isTargetPage,
        targetSheet,
        aiVision: payload.aiVision ?? null,
      }))
    }

    await Promise.all(uploads)
  }

  const { error: fanoutError } = await supabase.from("outbox").insert(pageJobs)
  if (fanoutError) {
    throw new Error(`Failed to queue page jobs: ${fanoutError.message}`)
  }

  await updateRevisionStage(supabase, draftRevisionId, {
    processing_stage: "rendering_pages",
  })

  console.log(
    `[drawings-pipeline] Split revision ${draftRevisionId}: ${pageCount} page jobs queued (hash ${sourceHash})`,
  )

  // Fan out extra pipeline invocations so page jobs render in parallel across
  // function instances instead of one long sequential drain.
  if (pageCount > 3) {
    const extraRunners = Math.min(6, Math.ceil(pageCount / 4))
    await Promise.allSettled(
      Array.from({ length: extraRunners }, () => triggerDrawingsPipeline()),
    )
  }
}

function buildPageJob(input: {
  orgId: string
  projectId: string
  drawingSetId: string
  draftRevisionId: string
  sourceFileId: string
  sourceHash: string
  pageIndex: number
  pageCount: number
  setTitle: string
  pagePdfPath: string
  pageText: string
  detected: DetectedSheetMetadata
  tentativeSheetNumber: string
  isTargetPage: boolean
  targetSheet: { id: string; sheet_number: string; sheet_title?: string | null; discipline?: string | null } | null
  aiVision: unknown
}) {
  return {
    org_id: input.orgId,
    job_type: "process_drawing_page",
    payload: {
      orgId: input.orgId,
      projectId: input.projectId,
      drawingSetId: input.drawingSetId,
      draftRevisionId: input.draftRevisionId,
      sourceFileId: input.sourceFileId,
      sourceHash: input.sourceHash,
      pageIndex: input.pageIndex,
      pageCount: input.pageCount,
      setTitle: input.setTitle,
      pagePdfPath: input.pagePdfPath,
      pageText: input.pageText.slice(0, PAGE_TEXT_PAYLOAD_MAX_CHARS),
      detected: input.detected,
      tentativeSheetNumber: input.tentativeSheetNumber,
      isTargetPage: input.isTargetPage,
      targetSheet: input.isTargetPage && input.targetSheet
        ? {
            id: input.targetSheet.id,
            sheet_number: input.targetSheet.sheet_number,
            sheet_title: input.targetSheet.sheet_title ?? null,
            discipline: input.targetSheet.discipline ?? null,
          }
        : null,
      aiVision: input.aiVision ?? null,
    },
    run_at: new Date().toISOString(),
  }
}

// ============================================================================
// Job: process_drawing_page (render + detect + version + tiles)
// ============================================================================

async function handleProcessDrawingPage(supabase: SupabaseClient, job: ClaimedJob) {
  const payload = job.payload ?? {}
  const orgId = requireString(payload.orgId ?? job.org_id, "orgId")
  const projectId = requireString(payload.projectId, "projectId")
  const drawingSetId = requireString(payload.drawingSetId, "drawingSetId")
  const draftRevisionId = requireString(payload.draftRevisionId, "draftRevisionId")
  const sourceFileId = requireString(payload.sourceFileId, "sourceFileId")
  const sourceHash = requireString(payload.sourceHash, "sourceHash")
  const pageIndex = requireNumber(payload.pageIndex, "pageIndex")
  const pageCount = requireNumber(payload.pageCount, "pageCount")
  const setTitle = typeof payload.setTitle === "string" ? payload.setTitle : "Drawings"
  const pagePdfPath = typeof payload.pagePdfPath === "string" ? payload.pagePdfPath : null
  const pageText = typeof payload.pageText === "string" ? payload.pageText : ""
  const pageNumber = pageIndex + 1

  // If the draft was discarded while jobs were queued, exit quietly.
  const { data: revision } = await supabase
    .from("drawing_revisions")
    .select("id, status, processing_stage")
    .eq("id", draftRevisionId)
    .eq("org_id", orgId)
    .maybeSingle()
  if (!revision) {
    console.log(`[drawings-pipeline] Revision ${draftRevisionId} gone; skipping page ${pageNumber}`)
    return
  }

  // Idempotency: if this page already produced a version (retry after a late
  // failure), skip the work but still make sure progress accounting is right.
  const { data: existingVersion } = await supabase
    .from("drawing_sheet_versions")
    .select("id, extracted_metadata")
    .eq("org_id", orgId)
    .eq("drawing_revision_id", draftRevisionId)
    .eq("page_index", pageIndex)
    .maybeSingle()
  if (existingVersion) {
    console.log(`[drawings-pipeline] Page ${pageNumber} already processed for revision ${draftRevisionId}`)
    return
  }

  // ---- Render ----
  const mupdf = await loadMupdf()
  let pdfBytes: Buffer | null = null
  if (pagePdfPath) {
    try {
      pdfBytes = await downloadTilesObject({ supabase, path: pagePdfPath })
    } catch (error) {
      console.warn(`[drawings-pipeline] Missing page PDF ${pagePdfPath}; falling back to full PDF`, error)
    }
  }

  let pageDocIndex = 0
  if (!pdfBytes) {
    const { data: fileRecord, error: fileError } = await supabase
      .from("files")
      .select("storage_path")
      .eq("id", sourceFileId)
      .single()
    if (fileError || !fileRecord?.storage_path) {
      throw new Error(`Source file not found: ${fileError?.message ?? sourceFileId}`)
    }
    pdfBytes = await downloadDrawingPdfObject({ supabase, orgId, path: fileRecord.storage_path })
    pageDocIndex = pageIndex
  }

  const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf")
  const page = doc.loadPage(pageDocIndex)
  const { png, width, height } = renderPagePng(mupdf, page)

  // ---- Detection (text guess from the split job + optional vision) ----
  const detected: DetectedSheetMetadata =
    payload.detected && typeof payload.detected === "object"
      ? (payload.detected as DetectedSheetMetadata)
      : detectSheetMetadata({ pageText, setTitle, pageNumber })

  const visionSheet = shouldUseVisionFallback(detected, pageText, payload)
    ? await detectSheetMetadataWithVision({
        pngBuffer: png,
        pageText,
        setTitle,
        pageNumber,
        initial: detected,
        payload,
      })
    : null

  const resolvedSheet = mergeDetectedSheetMetadata(detected, visionSheet, setTitle, pageNumber)
  const tentativeSheetNumber =
    typeof payload.tentativeSheetNumber === "string" && payload.tentativeSheetNumber
      ? payload.tentativeSheetNumber
      : truncateValue(resolvedSheet.sheetNumber, SHEET_NUMBER_MAX_LENGTH)

  const isTargetPage = Boolean(payload.isTargetPage && payload.targetSheet)
  const targetSheet = isTargetPage ? (payload.targetSheet as Record<string, any>) : null

  const proposedSheetNumber = isTargetPage
    ? truncateValue(String(targetSheet!.sheet_number || resolvedSheet.sheetNumber), SHEET_NUMBER_MAX_LENGTH)
    : truncateValue(resolvedSheet.sheetNumber || tentativeSheetNumber, SHEET_NUMBER_MAX_LENGTH)
  const proposedSheetTitle = isTargetPage
    ? truncateValue(String(targetSheet!.sheet_title || resolvedSheet.sheetTitle || `${setTitle} - Page ${pageNumber}`), SHEET_TITLE_MAX_LENGTH)
    : truncateValue(resolvedSheet.sheetTitle || `${setTitle} - Page ${pageNumber}`, SHEET_TITLE_MAX_LENGTH)
  const proposedDiscipline = isTargetPage
    ? normalizeDiscipline(String(targetSheet!.discipline || resolvedSheet.discipline))
    : normalizeDiscipline(resolvedSheet.discipline)

  // ---- Find or create the sheet, then attach the draft version ----
  const sheetDetection = {
    method: resolvedSheet.method,
    confidence: resolvedSheet.confidence,
    source_line: resolvedSheet.sourceLine,
    vision_used: Boolean(visionSheet),
    vision_notes: visionSheet?.notes ?? [],
  }

  // Persist the rendered PNG so tile generation can run as a background job.
  // Review readiness only needs the thumbnail; the pyramid trails behind.
  const tempPngPath = `${orgId}/${sourceHash}/temp/page-${pageIndex}.png`
  await uploadTilesObject({
    supabase,
    path: tempPngPath,
    bytes: png,
    contentType: "image/png",
    cacheControl: "private, max-age=3600",
  })

  const versionMetadata = (isNewSheet: boolean) => ({
    source_hash: sourceHash,
    page_index: pageIndex,
    is_new_sheet: isNewSheet,
    temp_png_path: tempPngPath,
    proposed: {
      sheet_number: proposedSheetNumber,
      sheet_title: proposedSheetTitle,
      discipline: proposedDiscipline,
    },
    sheet_detection: sheetDetection,
  })

  const findSheetByNumber = async (sheetNumber: string) => {
    const { data } = await supabase
      .from("drawing_sheets")
      .select("id, current_revision_id")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("sheet_number", sheetNumber)
      .maybeSingle()
    return data ?? null
  }

  const createDraftSheet = async (sheetNumber: string) => {
    const { data, error } = await supabase
      .from("drawing_sheets")
      .insert({
        org_id: orgId,
        project_id: projectId,
        drawing_set_id: drawingSetId,
        sheet_number: sheetNumber,
        sheet_title: proposedSheetTitle,
        discipline: proposedDiscipline,
        current_revision_id: null,
        sort_order: pageIndex,
        share_with_clients: false,
        share_with_subs: false,
      })
      .select("id, current_revision_id")
      .single()
    if (error || !data) {
      throw new Error(`Failed to create sheet for page ${pageNumber}: ${error?.message}`)
    }
    return data
  }

  const insertVersion = async (sheetId: string, isNewSheet: boolean) => {
    return supabase
      .from("drawing_sheet_versions")
      .insert({
        org_id: orgId,
        drawing_sheet_id: sheetId,
        drawing_revision_id: draftRevisionId,
        file_id: sourceFileId,
        page_index: pageIndex,
        extracted_metadata: versionMetadata(isNewSheet),
      })
      .select("id")
      .single()
  }

  let sheet = isTargetPage
    ? { id: String(targetSheet!.id), current_revision_id: "existing" }
    : await findSheetByNumber(proposedSheetNumber)
  let isNewSheet = false
  if (!sheet) {
    sheet = await createDraftSheet(proposedSheetNumber)
    isNewSheet = true
  }

  let { data: version, error: versionError } = await insertVersion(sheet.id, isNewSheet)

  // Unique violation on (sheet, revision): another page of this upload already
  // claimed that sheet. Fall back to the tentative number (unique per upload).
  if (versionError && versionError.code === "23505" && !isTargetPage) {
    const fallbackNumber = tentativeSheetNumber
    let fallbackSheet = fallbackNumber === proposedSheetNumber ? null : await findSheetByNumber(fallbackNumber)
    if (!fallbackSheet) {
      fallbackSheet = await createDraftSheet(
        fallbackNumber === proposedSheetNumber
          ? truncateForSuffix(fallbackNumber, `-P${pageNumber}`, SHEET_NUMBER_MAX_LENGTH)
          : fallbackNumber,
      )
      isNewSheet = true
    }
    sheet = fallbackSheet
    ;({ data: version, error: versionError } = await insertVersion(sheet.id, isNewSheet))
  }

  if (versionError || !version) {
    throw new Error(`Failed to create version for page ${pageNumber}: ${versionError?.message}`)
  }

  // ---- Thumbnail now (review works off it), tile pyramid in the background ----
  const basePath = `${orgId}/${sourceHash}/page-${pageIndex}`
  const tileBaseUrl = buildDrawingsTilesBaseUrl(basePath)
  const thumbBuffer = await sharp(png, { limitInputPixels: false })
    .resize(256, 256, { fit: "inside" })
    .png({ compressionLevel: 9 })
    .toBuffer()
  const thumbPath = `${basePath}/thumbnail.${TILE_FORMAT}`
  await uploadTilesObject({ supabase, path: thumbPath, bytes: thumbBuffer, contentType: "image/png" })
  // Note: thumbnail_url (not thumb_path) — thumb_path is resolved against the
  // images base URL by the mappers, but this thumbnail lives in tiles storage.
  await supabase
    .from("drawing_sheet_versions")
    .update({
      thumbnail_url: tileBaseUrl ? `${tileBaseUrl}/thumbnail.${TILE_FORMAT}` : null,
      image_width: width,
      image_height: height,
      tiles_base_path: basePath,
    })
    .eq("id", version.id)

  await supabase.from("outbox").insert({
    org_id: orgId,
    job_type: "generate_drawing_tiles",
    payload: { sheetVersionId: version.id },
    run_at: new Date().toISOString(),
  })

  // ---- Cleanup + progress ----
  if (pagePdfPath) {
    try {
      await deleteTilesObjects({ supabase, paths: [pagePdfPath] })
    } catch (error) {
      console.warn(`[drawings-pipeline] Failed to delete temp page PDF ${pagePdfPath}:`, error)
    }
  }

  const progress = await incrementRevisionProgress(supabase, draftRevisionId)
  const processed = progress?.processed ?? null
  const total = progress?.total ?? pageCount

  if (processed !== null && total !== null && processed >= total) {
    await updateRevisionStage(supabase, draftRevisionId, {
      status: "draft",
      processing_stage: "ready",
    })
    console.log(`[drawings-pipeline] Revision ${draftRevisionId} ready for review (${total} pages)`)
  }
}

async function incrementRevisionProgress(
  supabase: SupabaseClient,
  revisionId: string,
): Promise<{ processed: number; total: number | null } | null> {
  const { data, error } = await supabase.rpc("increment_drawing_revision_progress", {
    p_revision_id: revisionId,
  })

  if (!error) {
    const row = Array.isArray(data) ? data[0] : data
    if (row && typeof row.processed === "number") {
      return { processed: row.processed, total: row.total ?? null }
    }
    return null
  }

  // Fallback while the migration hasn't been pushed yet (non-atomic, but the
  // ready-check below tolerates an off-by-one by re-reading the row).
  console.warn("[drawings-pipeline] increment RPC unavailable, using fallback:", error.message)
  const { data: revision } = await supabase
    .from("drawing_revisions")
    .select("processed_pages, total_pages")
    .eq("id", revisionId)
    .maybeSingle()
  if (!revision) return null
  const processed = (revision.processed_pages ?? 0) + 1
  await supabase
    .from("drawing_revisions")
    .update({ processed_pages: processed })
    .eq("id", revisionId)
  return { processed, total: revision.total_pages ?? null }
}

// ============================================================================
// Job: generate_drawing_tiles (backfill / legacy)
// ============================================================================

async function handleGenerateDrawingTiles(supabase: SupabaseClient, job: ClaimedJob) {
  const payload = job.payload ?? {}
  const sheetVersionId =
    (typeof payload.sheetVersionId === "string" ? payload.sheetVersionId : null) ??
    (typeof payload.sheet_version_id === "string" ? payload.sheet_version_id : null)
  if (!sheetVersionId) {
    throw new Error("Missing sheetVersionId in payload")
  }

  const { data: version, error: versionError } = await supabase
    .from("drawing_sheet_versions")
    .select("id, org_id, file_id, page_index, extracted_metadata, tile_manifest, tile_base_url")
    .eq("id", sheetVersionId)
    .maybeSingle()
  if (versionError || !version) {
    throw new Error(`Sheet version not found: ${versionError?.message ?? sheetVersionId}`)
  }

  if (version.tile_manifest && version.tile_base_url) {
    console.log(`[drawings-pipeline] Tiles already exist for version ${sheetVersionId}, skipping`)
    return
  }

  const orgId = version.org_id as string
  const metadata = (version.extracted_metadata ?? {}) as Record<string, any>
  const tempPngPath = typeof metadata.temp_png_path === "string" ? metadata.temp_png_path : null
  const pageIndex =
    typeof version.page_index === "number" && Number.isFinite(version.page_index)
      ? version.page_index
      : 0

  let pngBuffer: Buffer
  let sourceHash = typeof metadata.source_hash === "string" ? metadata.source_hash : null

  if (tempPngPath) {
    pngBuffer = await downloadTilesObject({ supabase, path: tempPngPath })
  } else {
    if (!version.file_id) {
      throw new Error("Sheet version has neither temp PNG nor file_id")
    }
    const { data: file, error: fileError } = await supabase
      .from("files")
      .select("storage_path")
      .eq("id", version.file_id)
      .maybeSingle()
    if (fileError || !file?.storage_path) {
      throw new Error(`Failed to load file storage_path: ${fileError?.message ?? "missing"}`)
    }
    const pdfBytes = await downloadDrawingPdfObject({ supabase, orgId, path: file.storage_path })
    sourceHash = sourceHash ?? createHash("sha256").update(pdfBytes).digest("hex").slice(0, 16)
    const mupdf = await loadMupdf()
    const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf")
    const page = doc.loadPage(Math.min(pageIndex, Math.max(0, doc.countPages() - 1)))
    pngBuffer = renderPagePng(mupdf, page).png
  }

  if (!sourceHash) {
    sourceHash = createHash("sha256").update(pngBuffer).digest("hex").slice(0, 16)
  }

  const image = sharp(pngBuffer, { limitInputPixels: false })
  const meta = await image.metadata()
  if (!meta.width || !meta.height) {
    throw new Error("Failed to read rendered image dimensions")
  }

  await generateTilesForVersion(supabase, {
    versionId: sheetVersionId,
    orgId,
    sourceHash,
    pageIndex,
    pngBuffer,
    width: meta.width,
    height: meta.height,
  })

  if (tempPngPath) {
    try {
      await deleteTilesObjects({ supabase, paths: [tempPngPath] })
    } catch (error) {
      console.warn("[drawings-pipeline] Failed to delete temp PNG:", error)
    }
  }

  // When the tile queue drains, refresh the register view so freshly published
  // sheets pick up their tile URLs (drafts are hidden by the MV either way).
  const { count: pendingTiles } = await supabase
    .from("outbox")
    .select("id", { count: "exact", head: true })
    .eq("job_type", "generate_drawing_tiles")
    .in("status", ["pending", "processing"])
  if ((pendingTiles ?? 0) <= 1) {
    try {
      await supabase.rpc("refresh_drawing_sheets_list")
    } catch (error) {
      console.warn("[drawings-pipeline] MV refresh after tiles failed:", error)
    }
  }
}

// ============================================================================
// Tiling (DZI pyramid, ported from the Cloud Run worker)
// ============================================================================

async function generateTilesForVersion(
  supabase: SupabaseClient,
  input: {
    versionId: string
    orgId: string
    sourceHash: string
    pageIndex: number
    pngBuffer: Buffer
    width: number
    height: number
  },
) {
  const { versionId, orgId, sourceHash, pageIndex, pngBuffer, width, height } = input
  const basePath = `${orgId}/${sourceHash}/page-${pageIndex}`

  const maxLevel = Math.ceil(Math.log2(Math.max(width, height)))
  const levels = maxLevel + 1

  const tileManifest = {
    Image: {
      xmlns: "http://schemas.microsoft.com/deepzoom/2008",
      Format: TILE_FORMAT,
      Overlap: 0,
      TileSize: TILE_SIZE,
      Size: { Width: width, Height: height },
    },
    Levels: levels,
  }

  const tileBaseUrl = buildDrawingsTilesBaseUrl(basePath)
  if (!tileBaseUrl) {
    throw new Error("Missing DRAWINGS_TILES_BASE_URL/NEXT_PUBLIC_DRAWINGS_TILES_BASE_URL")
  }

  for (let level = 0; level <= maxLevel; level++) {
    const scaleDivisor = 2 ** (maxLevel - level)
    const levelWidth = Math.max(1, Math.ceil(width / scaleDivisor))
    const levelHeight = Math.max(1, Math.ceil(height / scaleDivisor))
    const cols = Math.ceil(levelWidth / TILE_SIZE)
    const rows = Math.ceil(levelHeight / TILE_SIZE)

    const levelImageBuffer = await sharp(pngBuffer, { limitInputPixels: false })
      .resize(levelWidth, levelHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 9 })
      .toBuffer()

    const tiles: Array<{ col: number; row: number }> = []
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        tiles.push({ col, row })
      }
    }

    for (let i = 0; i < tiles.length; i += TILE_UPLOAD_CONCURRENCY) {
      const chunk = tiles.slice(i, i + TILE_UPLOAD_CONCURRENCY)
      await Promise.all(
        chunk.map(async ({ col, row }) => {
          const left = col * TILE_SIZE
          const top = row * TILE_SIZE
          const tileWidth = Math.min(TILE_SIZE, levelWidth - left)
          const tileHeight = Math.min(TILE_SIZE, levelHeight - top)

          const tileBuffer = await sharp(levelImageBuffer, { limitInputPixels: false })
            .extract({ left, top, width: tileWidth, height: tileHeight })
            .png({ compressionLevel: 9 })
            .toBuffer()

          await uploadTilesObject({
            supabase,
            path: `${basePath}/tiles/${level}/${col}_${row}.${TILE_FORMAT}`,
            bytes: tileBuffer,
            contentType: "image/png",
          })
        }),
      )
    }
  }

  const thumbBuffer = await sharp(pngBuffer, { limitInputPixels: false })
    .resize(256, 256, { fit: "inside" })
    .png({ compressionLevel: 9 })
    .toBuffer()
  const thumbPath = `${basePath}/thumbnail.${TILE_FORMAT}`
  await uploadTilesObject({ supabase, path: thumbPath, bytes: thumbBuffer, contentType: "image/png" })

  const manifestPath = `${basePath}/manifest.json`
  await uploadTilesObject({
    supabase,
    path: manifestPath,
    bytes: Buffer.from(JSON.stringify(tileManifest)),
    contentType: "application/json",
  })

  const { error: updateError } = await supabase
    .from("drawing_sheet_versions")
    .update({
      tile_manifest: tileManifest,
      tile_base_url: tileBaseUrl,
      source_hash: sourceHash,
      tile_levels: levels,
      tiles_generated_at: new Date().toISOString(),
      thumbnail_url: `${tileBaseUrl}/thumbnail.${TILE_FORMAT}`,
      image_width: width,
      image_height: height,
      tile_manifest_path: manifestPath,
      tiles_base_path: basePath,
      page_index: pageIndex,
    })
    .eq("id", versionId)
  if (updateError) {
    throw new Error(`Failed to persist tile metadata: ${updateError.message}`)
  }
}

// ============================================================================
// Revision helpers
// ============================================================================

async function updateRevisionStage(
  supabase: SupabaseClient,
  revisionId: string,
  updates: {
    status?: "processing" | "draft" | "published"
    total_pages?: number | null
    processed_pages?: number
    processing_stage?: string | null
    error_message?: string | null
  },
) {
  const payload: Record<string, unknown> = {}
  if (updates.status !== undefined) payload.status = updates.status
  if (updates.total_pages !== undefined) payload.total_pages = updates.total_pages
  if (updates.processed_pages !== undefined) payload.processed_pages = updates.processed_pages
  if (updates.processing_stage !== undefined) payload.processing_stage = updates.processing_stage
  if (updates.error_message !== undefined) payload.error_message = updates.error_message

  await supabase.from("drawing_revisions").update(payload).eq("id", revisionId)
}

// ============================================================================
// Title-block detection (regex, ported verbatim from the worker)
// ============================================================================

function detectSheetMetadata(input: {
  pageText: string
  setTitle: string
  pageNumber: number
}): DetectedSheetMetadata {
  const { pageText, setTitle, pageNumber } = input
  const lines = pageText
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => normalizeWhitespace(line).trim())
    .filter(Boolean)

  const labeledMatch = detectSheetNumberFromLabel(lines)
  if (labeledMatch) {
    const titleFromLabel = detectSheetTitleFromLabels(lines)
    const titleFromNearby = titleFromLabel || detectSheetTitleNearLine(lines, labeledMatch.sourceLine)
    return {
      sheetNumber: truncateValue(labeledMatch.sheetNumber, SHEET_NUMBER_MAX_LENGTH),
      sheetTitle: truncateValue(titleFromNearby || `${setTitle} - Page ${pageNumber}`, SHEET_TITLE_MAX_LENGTH),
      discipline: detectDiscipline(labeledMatch.sheetNumber),
      method: "label",
      confidence: "high",
      sourceLine: labeledMatch.sourceLine,
    }
  }

  const patternMatch = detectSheetNumberByPattern(lines)
  if (patternMatch) {
    const title = detectSheetTitleNearLine(lines, patternMatch.sourceLine)
    return {
      sheetNumber: truncateValue(patternMatch.sheetNumber, SHEET_NUMBER_MAX_LENGTH),
      sheetTitle: truncateValue(title || `${setTitle} - Page ${pageNumber}`, SHEET_TITLE_MAX_LENGTH),
      discipline: detectDiscipline(patternMatch.sheetNumber),
      method: "pattern",
      confidence: "medium",
      sourceLine: patternMatch.sourceLine,
    }
  }

  return {
    sheetNumber: truncateValue(`${setTitle} - Page ${pageNumber}`, SHEET_NUMBER_MAX_LENGTH),
    sheetTitle: truncateValue(`${setTitle} - Page ${pageNumber}`, SHEET_TITLE_MAX_LENGTH),
    discipline: "X",
    method: "fallback",
    confidence: "low",
    sourceLine: null,
  }
}

function detectSheetNumberFromLabel(lines: string[]): { sheetNumber: string; sourceLine: string } | null {
  for (const line of lines) {
    for (const pattern of SHEET_LABEL_PATTERNS) {
      const match = line.match(pattern)
      if (!match) continue
      const sheetNumber = normalizeSheetNumberCandidate(match[1])
      if (sheetNumber) {
        return { sheetNumber, sourceLine: line }
      }
    }
  }
  return null
}

function detectSheetNumberByPattern(lines: string[]): { sheetNumber: string; sourceLine: string } | null {
  let best: { sheetNumber: string; sourceLine: string; score: number } | null = null

  for (const line of lines) {
    const candidates = line.match(GENERIC_SHEET_NUMBER_PATTERN) || []
    for (const candidate of candidates) {
      const normalized = normalizeSheetNumberCandidate(candidate)
      if (!normalized) continue

      let score = 0
      if (/[-./]/.test(normalized)) score += 2
      if (/\b(SHEET|SHT|DWG|DRAWING)\b/i.test(line)) score += 4
      if (line.length <= 40) score += 1
      if (/\b(DETAIL|SCALE|DATE|ISSUED|REVISION|PROJECT)\b/i.test(line)) score -= 1

      const numeric = parseInt(normalized.replace(/^[A-Z]+[-./]?/, ""), 10)
      if (Number.isFinite(numeric) && numeric >= 1900 && numeric <= 2100 && !/[-./]/.test(normalized)) {
        score -= 3
      }

      if (!best || score > best.score) {
        best = { sheetNumber: normalized, sourceLine: line, score }
      }
    }
  }

  if (!best || best.score < 2) return null
  return { sheetNumber: best.sheetNumber, sourceLine: best.sourceLine }
}

function detectSheetTitleFromLabels(lines: string[]): string | null {
  for (const line of lines) {
    for (const pattern of SHEET_TITLE_LABEL_PATTERNS) {
      const match = line.match(pattern)
      if (!match) continue
      const title = sanitizeTitle(match[1])
      if (title) return title
    }
  }
  return null
}

function detectSheetTitleNearLine(lines: string[], sourceLine: string): string | null {
  const index = lines.findIndex((line) => line === sourceLine)
  if (index === -1) return null

  const nearbyIndexes = [index + 1, index + 2, index - 1, index - 2]
  for (const i of nearbyIndexes) {
    if (i < 0 || i >= lines.length) continue
    const title = sanitizeTitle(lines[i])
    if (title) return title
  }
  return null
}

function sanitizeTitle(raw: string): string | null {
  const value = normalizeWhitespace(raw).trim()
  if (!value) return null
  if (value.length < 3 || value.length > SHEET_TITLE_MAX_LENGTH) return null
  if (!/[A-Za-z]/.test(value)) return null
  if (/^(SHEET|SHT|DWG|DRAWING|REVISION|PROJECT|SCALE)\b/i.test(value)) return null
  return truncateValue(value, SHEET_TITLE_MAX_LENGTH)
}

function normalizeSheetNumberCandidate(raw: string): string | null {
  const value = raw
    .toUpperCase()
    .replace(/[^A-Z0-9./-]/g, "")
    .replace(/^[./-]+|[./-]+$/g, "")

  if (!value) return null

  const valid = /^(?:FP|SP|[ASMEPCLIGTDX])[-./]?\d{1,4}(?:\.\d{1,3})?[A-Z]?$/.test(value)
  return valid ? truncateValue(value, SHEET_NUMBER_MAX_LENGTH) : null
}

function detectDiscipline(sheetNumber: string): string {
  const normalized = sheetNumber.toUpperCase()
  if (normalized.startsWith("FP")) return "FP"
  if (normalized.startsWith("SP")) return "SP"
  const single = normalized[0]
  return DISCIPLINE_CODES.has(single) ? single : "X"
}

function normalizeDiscipline(value: string | null | undefined): string {
  const normalized = (value || "").toUpperCase()
  return DISCIPLINE_CODES.has(normalized) ? normalized : "X"
}

function ensureUniqueSheetNumber(baseSheetNumber: string, pageNumber: number, used: Set<string>): string {
  const base = truncateValue(baseSheetNumber, SHEET_NUMBER_MAX_LENGTH)
  const baseKey = base.toUpperCase()
  if (!used.has(baseKey)) {
    used.add(baseKey)
    return base
  }

  const firstSuffix = `-P${pageNumber}`
  const firstCandidate = truncateForSuffix(base, firstSuffix, SHEET_NUMBER_MAX_LENGTH)
  const firstKey = firstCandidate.toUpperCase()
  if (!used.has(firstKey)) {
    used.add(firstKey)
    return firstCandidate
  }

  let attempt = 2
  while (attempt < 1000) {
    const suffix = `-${attempt}`
    const candidate = truncateForSuffix(base, suffix, SHEET_NUMBER_MAX_LENGTH)
    const key = candidate.toUpperCase()
    if (!used.has(key)) {
      used.add(key)
      return candidate
    }
    attempt += 1
  }

  const finalFallback = truncateValue(`PAGE-${pageNumber}`, SHEET_NUMBER_MAX_LENGTH)
  used.add(finalFallback.toUpperCase())
  return finalFallback
}

function truncateForSuffix(base: string, suffix: string, maxLength: number): string {
  const roomForBase = Math.max(1, maxLength - suffix.length)
  return `${base.slice(0, roomForBase)}${suffix}`
}

function truncateValue(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength).trim()
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ")
}

// ============================================================================
// AI vision fallback (ported from the worker; buffer-based instead of files)
// ============================================================================

function shouldUseVisionFallback(
  detected: DetectedSheetMetadata,
  pageText: string,
  payload?: Record<string, any>,
): boolean {
  const provider = getVisionProvider(payload)
  if (!getVisionApiKey(provider)) return false
  if (!pageText.trim()) return true
  return detected.method !== "label" || detected.confidence === "low"
}

async function detectSheetMetadataWithVision(input: {
  pngBuffer: Buffer
  pageText: string
  setTitle: string
  pageNumber: number
  initial: DetectedSheetMetadata
  payload?: Record<string, any>
}): Promise<VisionSheetMetadata | null> {
  const { pngBuffer, pageText, setTitle, pageNumber, initial, payload } = input
  const provider = getVisionProvider(payload)
  const apiKey = getVisionApiKey(provider)
  if (!apiKey) return null

  try {
    const images = await buildVisionInputs(pngBuffer)
    if (images.length === 0) return null

    const model = getVisionModel(provider, payload)
    const prompt = [
      "You are extracting metadata from one construction drawing page.",
      `Project set title: ${setTitle}`,
      `Page number in upload order: ${pageNumber}`,
      `Current text-based guess: sheet_number=${initial.sheetNumber}; sheet_title=${initial.sheetTitle}; discipline=${initial.discipline}; method=${initial.method}; confidence=${initial.confidence}`,
      pageText.trim()
        ? `Extracted PDF text (may be partial): ${truncateValue(pageText, 4000)}`
        : "Extracted PDF text is empty, so rely on the image.",
      "Return only JSON with these keys: sheet_number, sheet_title, discipline, confidence, notes.",
      "discipline must be one of: A, S, M, E, P, FP, C, L, I, G, T, SP, D, X.",
      "confidence must be one of: high, medium, low.",
      "If uncertain, preserve the existing guess unless the image clearly shows a better answer.",
      "Prefer title block values like E1.1, A-101, S2.0, etc.",
    ].join("\n")

    const rawText = await generateVisionResponseText({ provider, apiKey, model, prompt, images, pageNumber })
    if (!rawText) return null

    const parsed = parseVisionJson(rawText)
    if (!parsed) return null

    const sheetNumber = normalizeSheetNumberCandidate(parsed.sheet_number ?? "")
    const discipline =
      typeof parsed.discipline === "string" && DISCIPLINE_CODES.has(parsed.discipline.toUpperCase())
        ? parsed.discipline.toUpperCase()
        : sheetNumber
          ? detectDiscipline(sheetNumber)
          : null
    const sheetTitle = sanitizeTitle(parsed.sheet_title ?? "")
    const confidence = normalizeConfidence(parsed.confidence)
    const notes = Array.isArray(parsed.notes)
      ? parsed.notes.filter((note: unknown): note is string => typeof note === "string").slice(0, 6)
      : []

    return { sheetNumber, sheetTitle, discipline, confidence, notes }
  } catch (error) {
    console.warn(`[drawings-pipeline] Vision failed for page ${pageNumber}:`, error)
    return null
  }
}

function getPayloadVisionConfig(payload?: Record<string, any>): { provider?: VisionProvider; model?: string } {
  const raw = payload?.aiVision ?? payload?.ai_vision
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}

  const record = raw as Record<string, unknown>
  const providerValue = typeof record.provider === "string" ? record.provider.trim().toLowerCase() : ""
  const modelValue = typeof record.model === "string" ? record.model.trim() : ""
  const provider = providerValue === "openai" || providerValue === "google" ? providerValue : undefined

  return { provider, model: modelValue || undefined }
}

function getVisionProvider(payload?: Record<string, any>): VisionProvider {
  const payloadProvider = getPayloadVisionConfig(payload).provider
  if (payloadProvider) return payloadProvider

  const configured = (
    process.env.DRAWINGS_VISION_PROVIDER ||
    process.env.AI_DRAWINGS_VISION_PROVIDER ||
    process.env.AI_VISION_PROVIDER ||
    "google"
  )
    .trim()
    .toLowerCase()

  return configured === "openai" ? "openai" : "google"
}

function getVisionApiKey(provider: VisionProvider): string | null {
  if (provider === "openai") {
    return process.env.OPENAI_API_KEY?.trim() || null
  }
  return (
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    null
  )
}

function getVisionModel(provider: VisionProvider, payload?: Record<string, any>): string {
  const payloadModel = getPayloadVisionConfig(payload).model
  if (payloadModel) return payloadModel

  if (provider === "openai") {
    return (
      process.env.DRAWINGS_VISION_MODEL ||
      process.env.AI_DRAWINGS_VISION_MODEL ||
      process.env.OPENAI_DRAWINGS_VISION_MODEL ||
      process.env.OPENAI_VISION_MODEL ||
      "gpt-4.1-mini"
    )
  }

  return (
    process.env.DRAWINGS_VISION_MODEL ||
    process.env.AI_DRAWINGS_VISION_MODEL ||
    process.env.GOOGLE_DRAWINGS_VISION_MODEL ||
    process.env.GEMINI_VISION_MODEL ||
    process.env.GOOGLE_VISION_MODEL ||
    "gemini-2.5-flash-lite"
  )
}

async function generateVisionResponseText(input: {
  provider: VisionProvider
  apiKey: string
  model: string
  prompt: string
  images: Array<{ dataUrl: string }>
  pageNumber: number
}): Promise<string | null> {
  const { provider, apiKey, model, prompt, images, pageNumber } = input

  if (provider === "openai") {
    const baseUrl = (process.env.OPENAI_BASE_URL || process.env.OPENAI_COMPAT_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              ...images.map((image, index) => ({
                type: "input_image",
                image_url: image.dataUrl,
                detail: index === 0 ? "low" : "high",
              })),
            ],
          },
        ],
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      console.warn(`[drawings-pipeline] OpenAI vision failed for page ${pageNumber}: ${response.status} ${body}`)
      return null
    }

    const payload = (await response.json()) as any
    return extractOpenAiResponseText(payload)
  }

  const normalizedModel = model.startsWith("models/") ? model : `models/${model}`
  const endpoint =
    process.env.GEMINI_BASE_URL?.replace(/\/$/, "") ||
    "https://generativelanguage.googleapis.com/v1beta"

  const response = await fetch(
    `${endpoint}/${normalizedModel}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              ...images.map((image) => {
                const [, mimeType = "image/webp", data = ""] =
                  image.dataUrl.match(/^data:(.*?);base64,(.*)$/) || []
                return { inline_data: { mime_type: mimeType, data } }
              }),
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      }),
    },
  )

  if (!response.ok) {
    const body = await response.text()
    console.warn(`[drawings-pipeline] Gemini vision failed for page ${pageNumber}: ${response.status} ${body}`)
    return null
  }

  const payload = (await response.json()) as any
  return extractGeminiResponseText(payload)
}

async function buildVisionInputs(pngBuffer: Buffer): Promise<Array<{ dataUrl: string }>> {
  const metadata = await sharp(pngBuffer, { limitInputPixels: false }).metadata()
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width <= 0 || height <= 0) return []

  const full = await sharp(pngBuffer, { limitInputPixels: false })
    .resize({ width: Math.min(width, 1600), withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer()

  const cornerWidth = Math.max(300, Math.round(width * 0.34))
  const cornerHeight = Math.max(220, Math.round(height * 0.24))

  const crops = await Promise.all([
    sharp(pngBuffer, { limitInputPixels: false })
      .extract({ left: Math.max(0, width - cornerWidth), top: 0, width: Math.min(cornerWidth, width), height: Math.min(cornerHeight, height) })
      .resize({ width: 1200, withoutEnlargement: false })
      .webp({ quality: 90 })
      .toBuffer(),
    sharp(pngBuffer, { limitInputPixels: false })
      .extract({ left: Math.max(0, width - cornerWidth), top: Math.max(0, height - cornerHeight), width: Math.min(cornerWidth, width), height: Math.min(cornerHeight, height) })
      .resize({ width: 1200, withoutEnlargement: false })
      .webp({ quality: 90 })
      .toBuffer(),
    sharp(pngBuffer, { limitInputPixels: false })
      .extract({ left: 0, top: Math.max(0, height - cornerHeight), width: Math.min(cornerWidth, width), height: Math.min(cornerHeight, height) })
      .resize({ width: 1200, withoutEnlargement: false })
      .webp({ quality: 90 })
      .toBuffer(),
  ])

  return [full, ...crops].map((buffer) => ({
    dataUrl: `data:image/webp;base64,${buffer.toString("base64")}`,
  }))
}

function extractOpenAiResponseText(payload: any): string {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim()
  }

  const output = Array.isArray(payload?.output) ? payload.output : []
  const texts: string[] = []
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : []
    for (const entry of content) {
      if (entry?.type === "output_text" && typeof entry?.text === "string") {
        texts.push(entry.text)
      }
    }
  }
  return texts.join("\n").trim()
}

function extractGeminiResponseText(payload: any): string {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : []
  const texts: string[] = []

  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
    for (const part of parts) {
      if (typeof part?.text === "string" && part.text.trim()) {
        texts.push(part.text.trim())
      }
    }
  }

  return texts.join("\n").trim()
}

function parseVisionJson(raw: string): any | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = fenced?.[1] ?? raw
  const jsonMatch = candidate.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null

  try {
    return JSON.parse(jsonMatch[0])
  } catch {
    return null
  }
}

function normalizeConfidence(value: unknown): DetectionConfidence {
  if (value === "high" || value === "medium" || value === "low") return value
  return "low"
}

function mergeDetectedSheetMetadata(
  detected: DetectedSheetMetadata,
  vision: VisionSheetMetadata | null,
  setTitle: string,
  pageNumber: number,
): DetectedSheetMetadata {
  if (!vision) return detected

  const useVisionSheetNumber = Boolean(vision.sheetNumber) && (
    detected.method !== "label" ||
    detected.confidence === "low" ||
    detected.sheetNumber === `${setTitle} - Page ${pageNumber}`
  )

  const sheetNumber = useVisionSheetNumber ? vision.sheetNumber! : detected.sheetNumber
  const sheetTitle = vision.sheetTitle || detected.sheetTitle || `${setTitle} - Page ${pageNumber}`
  const discipline = vision.discipline || detected.discipline || detectDiscipline(sheetNumber)
  const confidence = confidenceRank(vision.confidence) > confidenceRank(detected.confidence)
    ? vision.confidence!
    : detected.confidence

  return {
    sheetNumber,
    sheetTitle,
    discipline,
    method: useVisionSheetNumber ? "pattern" : detected.method,
    confidence,
    sourceLine: detected.sourceLine,
  }
}

function confidenceRank(value: DetectionConfidence | undefined): number {
  if (value === "high") return 3
  if (value === "medium") return 2
  return 1
}

// ============================================================================
// Payload validation helpers
// ============================================================================

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing required payload field: ${field}`)
  }
  return value
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Missing required payload field: ${field}`)
  }
  return value
}
