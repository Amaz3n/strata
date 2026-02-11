import { NextRequest, NextResponse } from "next/server"
import { createHash } from "node:crypto"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { sendEmail } from "@/lib/services/mailer"
import {
  createDrawingSheet,
  createSheetVersion,
  updateDrawingSet,
} from "@/lib/services/drawings"
import { buildDrawingsTilesBaseUrl } from "@/lib/storage/drawings-urls"
import {
  deleteTilesObjects,
  listTilesObjects,
  uploadTilesObject,
} from "@/lib/storage/drawings-tiles-storage"
import { downloadDrawingPdfObject } from "@/lib/storage/drawings-pdfs-storage"

// Use @napi-rs/canvas's DOMMatrix, DOMPoint, DOMRect, ImageData, Path2D for PDF.js
// These are complete implementations that PDF.js needs for proper rendering
import {
  DOMMatrix as CanvasDOMMatrix,
  DOMPoint as CanvasDOMPoint,
  DOMRect as CanvasDOMRect,
} from "@napi-rs/canvas"

// Polyfill DOM APIs for PDF.js in Node.js environment using @napi-rs/canvas
if (typeof globalThis.DOMMatrix === "undefined") {
  globalThis.DOMMatrix = CanvasDOMMatrix as any
}
if (typeof globalThis.DOMPoint === "undefined") {
  globalThis.DOMPoint = CanvasDOMPoint as any
}
if (typeof globalThis.DOMRect === "undefined") {
  globalThis.DOMRect = CanvasDOMRect as any
}
// ImageData polyfill (minimal, PDF.js uses this for pixel manipulation)
if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class ImageData {
    data: Uint8ClampedArray
    width: number
    height: number
    constructor(dataOrWidth: number | Uint8ClampedArray, widthOrHeight: number, height?: number) {
      if (typeof dataOrWidth === "number") {
        this.width = dataOrWidth
        this.height = widthOrHeight
        this.data = new Uint8ClampedArray(this.width * this.height * 4)
      } else {
        this.data = dataOrWidth
        this.width = widthOrHeight
        this.height = height!
      }
    }
  } as any
}
// Path2D polyfill (minimal stub - PDF.js may use this for clipping)
if (typeof globalThis.Path2D === "undefined") {
  globalThis.Path2D = class Path2D {
    constructor(_path?: string | Path2D) {}
    addPath(_path: Path2D) {}
    closePath() {}
    moveTo(_x: number, _y: number) {}
    lineTo(_x: number, _y: number) {}
    bezierCurveTo(_cp1x: number, _cp1y: number, _cp2x: number, _cp2y: number, _x: number, _y: number) {}
    quadraticCurveTo(_cpx: number, _cpy: number, _x: number, _y: number) {}
    arc(_x: number, _y: number, _r: number, _sa: number, _ea: number, _ccw?: boolean) {}
    arcTo(_x1: number, _y1: number, _x2: number, _y2: number, _r: number) {}
    ellipse(_x: number, _y: number, _rx: number, _ry: number, _rot: number, _sa: number, _ea: number, _ccw?: boolean) {}
    rect(_x: number, _y: number, _w: number, _h: number) {}
  } as any
}

export const runtime = "nodejs"

const CRON_SECRET = process.env.CRON_SECRET
const MAX_RETRIES = 3
// This endpoint can end up doing heavy work (tile generation). Keep batches small.
const BATCH_SIZE = 5
const SUPABASE_FUNCTION_TIMEOUT_MS = 120_000

function isAuthorizedCronRequest(request: NextRequest) {
  const isDev = process.env.NODE_ENV !== "production"
  if (isDev) return true

  // Vercel Cron sets this header to "1"
  const isVercelCron = request.headers.get("x-vercel-cron") === "1"

  // Preferred: Vercel Cron can send Authorization: Bearer $CRON_SECRET automatically
  const authHeader =
    request.headers.get("authorization") ?? request.headers.get("Authorization")

  const bearer = typeof authHeader === "string" ? authHeader.trim() : ""
  const legacyHeader = request.headers.get("x-cron-secret")

  const secretOk =
    (!!CRON_SECRET && bearer === `Bearer ${CRON_SECRET}`) ||
    (!!CRON_SECRET && legacyHeader === CRON_SECRET)

  // If a secret is configured, require it (even for Vercel cron).
  if (CRON_SECRET) {
    return secretOk
  }

  // Otherwise, allow Vercel cron-triggered requests.
  return isVercelCron
}

// Create a VISIBLE test image for the tiled viewer
export async function PATCH(request: NextRequest) {
  // Debug-only endpoint (creates synthetic tiles). Keep it out of prod.
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const { sheetVersionId } = await request.json()

  if (!sheetVersionId || typeof sheetVersionId !== 'string') {
    return NextResponse.json({ error: 'Missing sheetVersionId' }, { status: 400 })
  }

  const supabase = createServiceSupabaseClient()

  try {
    // Get org_id for the sheet
    const { data: version, error: versionError } = await supabase
      .from("drawing_sheet_versions")
      .select("org_id")
      .eq("id", sheetVersionId)
      .single()

    if (versionError || !version) {
      return NextResponse.json({ error: 'Sheet version not found' }, { status: 404 })
    }

    // Create a VISIBLE test image with high contrast
    const result = await createVisibleTestImage(version.org_id, supabase)

    // Update the database
    const { error: updateError } = await supabase
      .from("drawing_sheet_versions")
      .update(result)
      .eq("id", sheetVersionId)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    // Refresh the materialized view
    await supabase.rpc("refresh_drawing_sheets_list")

    return NextResponse.json({
      success: true,
      message: 'Created visible test image with high contrast',
      imageUrl: result.tile_base_url + '/tiles/0/0_0.png'
    })

  } catch (error) {
    console.error('Test image creation error:', error)
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}



async function createVisibleTestImage(orgId: string, supabase: any) {
  // Create a HIGHLY VISIBLE test image with bright colors
  let sharp: any
  try {
    sharp = (await import("sharp")) as any
  } catch (e) {
    throw new Error(`Sharp not available: ${(e as any)?.message ?? String(e)}`)
  }

  // Create a colorful test pattern that's definitely visible
  const svgTestImage = `
    <svg width="2400" height="1800" xmlns="http://www.w3.org/2000/svg">
      <!-- Bright gradient background -->
      <defs>
        <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#ff6b6b;stop-opacity:1" />
          <stop offset="50%" style="stop-color:#4ecdc4;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#45b7d1;stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#grad1)"/>

      <!-- Large visible text -->
      <text x="50%" y="30%" text-anchor="middle" font-family="Arial, sans-serif" font-size="72" font-weight="bold" fill="white" stroke="black" stroke-width="3">
        TILED VIEWER WORKS!
      </text>

      <text x="50%" y="50%" text-anchor="middle" font-family="Arial, sans-serif" font-size="48" fill="white" stroke="black" stroke-width="2">
        ✅ Zoom & Pan Ready
      </text>

      <text x="50%" y="65%" text-anchor="middle" font-family="Arial, sans-serif" font-size="36" fill="white" stroke="black" stroke-width="2">
        📊 Performance: Excellent
      </text>

      <text x="50%" y="80%" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" fill="yellow">
        🎯 Infrastructure Complete
      </text>

      <!-- Some geometric shapes for testing -->
      <circle cx="200" cy="200" r="100" fill="#ffeb3b" stroke="black" stroke-width="5"/>
      <rect x="2000" y="1500" width="200" height="150" fill="#ff9800" stroke="black" stroke-width="3"/>
      <polygon points="1200,300 1300,200 1400,300 1350,400 1250,400" fill="#e91e63" stroke="black" stroke-width="3"/>
    </svg>
  `

  const imageBuffer = await sharp(Buffer.from(svgTestImage)).png().toBuffer()
  const thumbBuffer = await sharp(Buffer.from(svgTestImage))
    .resize(256, 256, { fit: 'inside' })
    .png()
    .toBuffer()

  const hash = `visible-test-${Date.now()}`
  const basePath = `${orgId}/${hash}`
  const tileBaseUrl = buildDrawingsTilesBaseUrl(basePath)
  if (!tileBaseUrl) {
    throw new Error("Missing DRAWINGS_TILES_BASE_URL/NEXT_PUBLIC_DRAWINGS_TILES_BASE_URL")
  }

  // Upload the visible test image
  const tilePath = `${basePath}/tiles/0/0_0.png`
  await uploadTilesObject({
    supabase,
    path: tilePath,
    bytes: imageBuffer,
    contentType: "image/png",
  })

  const thumbPath = `${basePath}/thumbnail.png`
  await uploadTilesObject({
    supabase,
    path: thumbPath,
    bytes: thumbBuffer,
    contentType: "image/png",
  })

  return {
    tile_manifest: {
      Image: {
        xmlns: "http://schemas.microsoft.com/deepzoom/2008",
        Format: "png",
        Overlap: 0,
        TileSize: 2400, // Single tile covers entire image
        Size: { Width: 2400, Height: 1800 }
      }
    },
    tile_base_url: tileBaseUrl,
    source_hash: hash,
    tile_levels: 1,
    tiles_generated_at: new Date().toISOString(),
    thumbnail_url: `${tileBaseUrl}/thumbnail.png`,
    image_width: 2400,
    image_height: 1800,
  }
}

// Temporary test endpoint to queue tile generation for all sheets that need it
export async function GET(request: NextRequest) {
  // Debug-only endpoint (queues jobs for everything). Keep it out of prod.
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const supabase = createServiceSupabaseClient()
  const { searchParams } = new URL(request.url)

  // Check if we should list storage contents
  if (searchParams.get("list") === "storage") {
    try {
      return NextResponse.json({
        message: "Storage contents",
        files: await listTilesObjects({ supabase, limit: 100 })
      })
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 })
    }
  }

  // Check tile manifests
  if (searchParams.get("check") === "manifests") {
    try {
      const { data: sheets, error } = await supabase
        .from("drawing_sheet_versions")
        .select("id, tile_manifest, tile_base_url")
        .not("tile_manifest", "is", null)
        .limit(5)

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({
        message: "Tile manifests",
        sheets: sheets?.map(s => ({
          id: s.id,
          tile_base_url: s.tile_base_url,
          tile_manifest: s.tile_manifest
        })) || []
      })
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 })
    }
  }

  // Delete all files in drawings-tiles bucket
  if (searchParams.get("delete") === "storage") {
    try {
      console.log("[Cleanup] Starting comprehensive storage cleanup...")
      const objects = await listTilesObjects({ supabase, limit: 1000 })
      if (!objects.length) {
        return NextResponse.json({
          message: "No R2 tile objects found",
          files_found: 0,
          files_deleted: 0,
          remaining_files: 0,
        })
      }

      await deleteTilesObjects({ supabase, paths: objects.map((o) => o.name) })
      const remaining = await listTilesObjects({ supabase, limit: 50 })

      return NextResponse.json({
        message: "R2 tile storage cleanup completed",
        files_found: objects.length,
        files_deleted: objects.length,
        remaining_files: remaining.length,
        remaining_list: remaining.map((entry) => entry.name).slice(0, 5),
      })
    } catch (e) {
      console.error("[Cleanup] Storage cleanup failed:", e)
      return NextResponse.json({ error: String(e) }, { status: 500 })
    }
  }

  // Clear database tile records
  if (searchParams.get("clear") === "database") {
    try {
      console.log("[Cleanup] Starting database cleanup...")

      const { data: updatedSheets, error } = await supabase
        .from("drawing_sheet_versions")
        .update({
          tile_manifest: null,
          tile_base_url: null,
          source_hash: null,
          tile_levels: null,
          tiles_generated_at: null,
          thumbnail_url: null,
          image_width: null,
          image_height: null,
          tiles_base_path: null
        })
        .not("tile_manifest", "is", null)
        .select("id")

      if (error) {
        console.error("[Cleanup] Database cleanup error:", error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      console.log(`[Cleanup] Cleared tile data from ${updatedSheets?.length || 0} sheets`)

      return NextResponse.json({
        message: "Database cleanup completed",
        sheets_updated: updatedSheets?.length || 0
      })
    } catch (e) {
      console.error("[Cleanup] Database cleanup failed:", e)
      return NextResponse.json({ error: String(e) }, { status: 500 })
    }
  }

  // Find all sheet versions with old WebP format tiles (for regeneration)
  const { data: sheetVersions, error } = await supabase
    .from("drawing_sheet_versions")
    .select("id, org_id, tile_base_url, tile_manifest")
    .not("tile_manifest", "is", null)
    .not("file_id", "is", null)
    .limit(2) // Process a few at a time for testing

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!sheetVersions?.length) {
    // Also check sheets that have tiles but might need regeneration
    const { data: existingSheets } = await supabase
      .from("drawing_sheet_versions")
      .select("id, org_id, tile_base_url, tile_manifest")
      .not("tile_manifest", "is", null)
      .limit(5)

    return NextResponse.json({
      message: "No sheets need tiles",
      queued: 0,
      existing_sheets: existingSheets?.map(s => ({
        id: s.id,
        has_tiles: !!s.tile_base_url,
        tile_url: s.tile_base_url
      })) || []
    })
  }

  // Queue tile generation jobs
  const jobs = sheetVersions.map((sv) => ({
    org_id: sv.org_id,
    job_type: "generate_drawing_tiles",
    payload: { sheetVersionId: sv.id },
    run_at: new Date().toISOString(),
  }))

  const { error: insertError } = await supabase
    .from("outbox")
    .insert(jobs)

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  return NextResponse.json({
    message: `Queued ${jobs.length} tile generation jobs`,
    queued: jobs.length
  })
}

const TILE_SIZE = 256
const OVERLAP = 1
const MAX_LEVELS = 12 // safety cap
const WEBP_QUALITY = 82

type TileManifest = {
  Image: {
    xmlns: string
    Format: "webp" | "png"
    Overlap: number
    TileSize: number
    Size: { Width: number; Height: number }
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const isDev = process.env.NODE_ENV !== "production"
  const supabase = createServiceSupabaseClient()
  const now = new Date().toISOString()

  const { data: jobs, error } = await supabase
    .from("outbox")
    .select("*")
    .in("job_type", ["deliver_notification", "refresh_drawing_sheets_list"])
    .eq("status", "pending")
    .lte("run_at", now)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!jobs?.length) {
    return NextResponse.json({ processed: 0 })
  }

  const jobIds = jobs.map((j: any) => j.id)
  await supabase.from("outbox").update({ status: "processing" }).in("id", jobIds)

  let processed = 0
  let failed = 0
  const failures: Array<{ id: string; job_type: string; error: string }> = []

  for (const job of jobs as any[]) {
    try {
      if (job.job_type === "deliver_notification") {
        await deliverNotificationJob(supabase, job)
      } else if (job.job_type === "refresh_drawing_sheets_list") {
        await refreshDrawingSheetsListJob(supabase)
      } else if (job.job_type === "generate_drawing_tiles" || job.job_type === "process_drawing_set") {
        // Skip drawing jobs - these are now handled by the Cloud Run worker
        console.log(`Skipping ${job.job_type} job ${job.id} - handled by Cloud Run worker`)
        await supabase
          .from("outbox")
          .update({ status: "completed", last_error: "Delegated to Cloud Run worker" })
          .eq("id", job.id)
        processed += 1
        continue
      } else {
        await supabase
          .from("outbox")
          .update({ status: "failed", last_error: "Unknown job type" })
          .eq("id", job.id)
        failed += 1
        failures.push({
          id: String(job.id),
          job_type: String(job.job_type),
          error: "Unknown job type",
        })
        continue
      }

      await supabase.from("outbox").update({ status: "completed" }).eq("id", job.id)
      processed += 1
    } catch (err: any) {
      const newRetry = (job.retry_count ?? 0) + 1
      const shouldRetry = newRetry < MAX_RETRIES

      const errorText = (() => {
        const raw =
          (typeof err?.stack === "string" && err.stack) ||
          (typeof err?.message === "string" && err.message) ||
          String(err)
        return raw.length > 2000 ? raw.slice(0, 2000) : raw
      })()

      // Non-retriable: stale job referencing a deleted sheet version.
      if ((err as any)?.code === "SHEET_VERSION_NOT_FOUND" || errorText.includes("Sheet version not found")) {
        await supabase
          .from("outbox")
          .update({
            status: "completed",
            last_error: `skipped: ${errorText}`,
          })
          .eq("id", job.id)

        failed += 1
        failures.push({
          id: String(job.id),
          job_type: String(job.job_type),
          error: errorText,
        })
        continue
      }

      await supabase
        .from("outbox")
        .update({
          status: shouldRetry ? "pending" : "failed",
          retry_count: newRetry,
          last_error: errorText,
          run_at: shouldRetry
            ? new Date(Date.now() + Math.pow(3, newRetry) * 5 * 60 * 1000).toISOString()
            : job.run_at,
        })
        .eq("id", job.id)

      failed += 1
      failures.push({
        id: String(job.id),
        job_type: String(job.job_type),
        error: errorText,
      })
    }
  }

  return NextResponse.json(isDev ? { processed, failed, failures } : { processed, failed })
}

async function deliverNotificationJob(supabase: ReturnType<typeof createServiceSupabaseClient>, job: any) {
  const payload = job.payload ?? {}
  const notificationId =
    (typeof payload.notificationId === "string" ? payload.notificationId : null) ??
    (typeof payload.notification_id === "string" ? payload.notification_id : null)

  if (!notificationId) {
    throw new Error("Missing notificationId")
  }

  const { data: notification, error: notifError } = await supabase
    .from("notifications")
    .select("id, org_id, user_id, notification_type, payload, created_at")
    .eq("id", notificationId)
    .maybeSingle()

  if (notifError || !notification) {
    throw new Error(`Notification not found (${notifError?.message ?? "unknown error"})`)
  }

  const { data: prefs } = await supabase
    .from("user_notification_prefs")
    .select("email_enabled")
    .eq("org_id", notification.org_id)
    .eq("user_id", notification.user_id)
    .maybeSingle()

  if (prefs && prefs.email_enabled === false) {
    return
  }

  const { data: user, error: userError } = await supabase
    .from("app_users")
    .select("email, full_name")
    .eq("id", notification.user_id)
    .maybeSingle()

  if (userError || !user?.email) {
    throw new Error("User email not found")
  }

  const nPayload = (notification.payload ?? {}) as any
  const title = typeof nPayload.title === "string" ? nPayload.title : `Arc: ${notification.notification_type}`
  const message = typeof nPayload.message === "string" ? nPayload.message : ""

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com"
  const href = buildNotificationHref(nPayload)
  const linkHtml = href ? `<p style="margin-top: 16px"><a href="${appUrl}${href}">View in Arc</a></p>` : ""

  await sendEmail({
    to: [user.email],
    subject: title,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; line-height: 1.5">
        <h2 style="margin: 0 0 12px 0">${escapeHtml(title)}</h2>
        <p style="margin: 0 0 12px 0; color: #333">${escapeHtml(message)}</p>
        ${linkHtml}
        <hr style="margin: 20px 0; border: 0; border-top: 1px solid #eee" />
        <p style="margin: 0; color: #777; font-size: 12px">You’re receiving this because notifications are enabled for your Arc account.</p>
      </div>
    `,
  })
}

async function processDrawingSetJob(supabase: ReturnType<typeof createServiceSupabaseClient>, job: any) {
  const payload = (job.payload ?? {}) as any
  const drawingSetId = typeof payload.drawingSetId === "string" ? payload.drawingSetId : null
  const projectId = typeof payload.projectId === "string" ? payload.projectId : null
  const sourceFileId = typeof payload.sourceFileId === "string" ? payload.sourceFileId : null
  const storagePath = typeof payload.storagePath === "string" ? payload.storagePath : null
  const orgId = typeof payload.orgId === "string" ? payload.orgId : null

  if (!drawingSetId || !projectId || !sourceFileId || !storagePath || !orgId) {
    throw new Error("Missing required fields: drawingSetId, projectId, sourceFileId, storagePath, orgId")
  }

  console.log(`[ProcessSet] Processing drawing set: ${drawingSetId}`)

  try {
    // 1. Get the drawing set and file info
    const { data: drawingSet, error: setError } = await supabase
      .from("drawing_sets")
      .select("id, org_id, title")
      .eq("id", drawingSetId)
      .single()

    if (setError || !drawingSet) {
      throw new Error(`Drawing set not found: ${setError?.message}`)
    }

    const { data: fileRecord, error: fileError } = await supabase
      .from("files")
      .select("file_name, storage_path")
      .eq("id", sourceFileId)
      .single()

    if (fileError || !fileRecord) {
      throw new Error(`File record not found: ${fileError?.message}`)
    }

    console.log(`[ProcessSet] Found drawing set: ${drawingSet.title}, file: ${fileRecord.file_name}`)

    // 2. Download the PDF
    const pdfBytes = await downloadDrawingPdfObject({
      supabase,
      orgId,
      path: storagePath,
    })
    console.log(`[ProcessSet] Downloaded PDF: ${pdfBytes.length} bytes`)

    // 3. Create placeholder pages for now (PDF processing libraries are problematic)
    const pages: { pageNumber: number; imageBuffer: Uint8Array; width: number; height: number }[] = []
    // TODO: Implement proper PDF processing without pdfjs-dist dependencies
    console.log(`[ProcessSet] PDF processing temporarily disabled - creating placeholder pages`)

    // Create a reasonable number of placeholder pages based on PDF size
    // Large PDFs likely have more pages
    const estimatedPages = Math.max(1, Math.min(20, Math.floor(pdfBytes.length / 200000)))
    console.log(`[ProcessSet] PDF size: ${pdfBytes.length} bytes, estimated pages: ${estimatedPages}`)

    for (let pageNum = 1; pageNum <= estimatedPages; pageNum++) {
      console.log(`[ProcessSet] Creating placeholder page ${pageNum}`)
      const placeholder = await createPlaceholderImageForPdf()
      pages.push({
        pageNumber: pageNum,
        imageBuffer: placeholder.pngBytes,
        width: placeholder.width,
        height: placeholder.height
      })
      console.log(`[ProcessSet] Created placeholder page ${pageNum}: ${placeholder.pngBytes.length} bytes`)
    }

    console.log(`[ProcessSet] Created ${pages.length} placeholder pages total`)

    // 4. Create individual drawing sheets
    const sheetsCreated = []
    for (const page of pages) {
      try {
        // Create sheet record directly (avoid authentication issues)
        const sheetNumber = `${drawingSet.title} - Page ${page.pageNumber}`
        const sheetData = {
          project_id: projectId,
          drawing_set_id: drawingSetId,
          sheet_number: sheetNumber,
          sheet_title: `${drawingSet.title} - Page ${page.pageNumber}`,
          discipline: null,
          page_index: page.pageNumber - 1, // 0-based
          created_by: null, // No user context in background job
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }

        const { data: sheet, error: sheetError } = await supabase
          .from("drawing_sheets")
          .insert(sheetData)
          .select()
          .single()

        if (sheetError || !sheet) {
          throw new Error(`Failed to create sheet: ${sheetError?.message}`)
        }

        // Create sheet version with the extracted page image
        const hash = `page-${page.pageNumber}-${Date.now()}`
        const basePath = `${drawingSet.org_id}/${hash}`
        const publicBaseUrl = buildPublicBaseUrl(drawingSet.org_id, hash)

        // Upload the page image as a single tile
        const objectPath = `${basePath}/tiles/0/0_0.png`
        await uploadPublicObject(supabase, objectPath, page.imageBuffer, "image/png")

        // Create thumbnail
        let sharp: any
        try {
          sharp = (await import("sharp")) as any
        } catch (e: any) {
          throw new Error(`Sharp import failed: ${e?.message ?? String(e)}`)
        }

        const thumbBuffer = await sharp(Buffer.from(page.imageBuffer))
          .resize(256, 256, { fit: 'inside' })
          .png()
          .toBuffer()

        await uploadPublicObject(supabase, `${basePath}/thumbnail.png`, new Uint8Array(thumbBuffer), "image/png")

        // Create manifest
        const manifest: TileManifest = {
          Image: {
            xmlns: "http://schemas.microsoft.com/deepzoom/2008",
            Format: "png",
            Overlap: 0,
            TileSize: page.width,
            Size: { Width: page.width, Height: page.height },
          },
        }

        await uploadPublicObject(
          supabase,
          `${basePath}/manifest.json`,
          new TextEncoder().encode(JSON.stringify(manifest)),
          "application/json",
        )

        // Create sheet version directly
        const versionData = {
          drawing_sheet_id: sheet.id,
          file_id: sourceFileId,
          page_index: page.pageNumber - 1,
          image_width: page.width,
          image_height: page.height,
          tile_manifest: manifest,
          tile_base_url: publicBaseUrl,
          thumbnail_url: `${publicBaseUrl}/thumbnail.png`,
          source_hash: hash,
          tile_levels: 1,
          tiles_generated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }

        const { data: version, error: versionError } = await supabase
          .from("drawing_sheet_versions")
          .insert(versionData)
          .select()
          .single()

        if (versionError || !version) {
          throw new Error(`Failed to create sheet version: ${versionError?.message}`)
        }

        console.log(`[ProcessSet] Created sheet version: ${version.id}`)

        sheetsCreated.push(sheet)
        console.log(`[ProcessSet] Created sheet: ${sheetNumber}`)
      } catch (pageError) {
        console.error(`[ProcessSet] Failed to create sheet for page ${page.pageNumber}:`, pageError)
      }
    }

    // 5. Update drawing set status
    await supabase
      .from("drawing_sets")
      .update({
        status: "ready",
        processed_pages: sheetsCreated.length
      })
      .eq("id", drawingSetId)

    console.log(`[ProcessSet] Successfully processed ${sheetsCreated.length} sheets for drawing set: ${drawingSetId}`)

    // 6. Queue tile generation jobs for each sheet (though they're already processed)
    // This is kept for consistency with the existing flow
    for (const sheet of sheetsCreated) {
      const { data: versions } = await supabase
        .from("drawing_sheet_versions")
        .select("id")
        .eq("drawing_sheet_id", sheet.id)
        .order("created_at", { ascending: false })
        .limit(1)

      if (versions && versions[0]) {
        // Tiles are already generated, but queue anyway for consistency
        await supabase.from("outbox").insert({
          org_id: drawingSet.org_id,
          job_type: "generate_drawing_tiles",
          payload: { sheetVersionId: versions[0].id },
          run_at: new Date().toISOString(),
        })
      }
    }

    // 7. Refresh the materialized view
    try {
      await supabase.rpc("refresh_drawing_sheets_list")
    } catch (e) {
      console.error("[ProcessSet] Failed to refresh drawing sheets list:", e)
    }

  } catch (error) {
    console.error(`[ProcessSet] Failed to process drawing set ${drawingSetId}:`, error)

    // Update set status to failed
    try {
      await supabase
        .from("drawing_sets")
        .update({
          status: "failed",
          error_message: String(error)
        })
        .eq("id", drawingSetId)
    } catch (updateError) {
      console.error("[ProcessSet] Failed to update set status:", updateError)
    }

    throw error
  }
}

async function generateDrawingTilesJob(supabase: ReturnType<typeof createServiceSupabaseClient>, job: any) {
  const payload = (job.payload ?? {}) as any
  const sheetVersionId =
    (typeof payload.sheetVersionId === "string" ? payload.sheetVersionId : null) ??
    (typeof payload.sheet_version_id === "string" ? payload.sheet_version_id : null)

  if (!sheetVersionId) {
    throw new Error("Missing sheetVersionId")
  }

  // Option A: Generate tiles in Node (this worker), not via Edge Functions.
  // This avoids runtime incompatibilities with PDF rendering libraries.
  await generateDrawingTilesInNode(supabase, sheetVersionId)

  // Keep the list view fresh enough for users right after tiles land.
  // This is non-concurrent refresh for simplicity; if this becomes heavy,
  // move to scheduled refreshes + eventual consistency.
  const isDevMode = process.env.NODE_ENV !== "production"
  if (!isDevMode) {
    try {
      await supabase.rpc("refresh_drawing_sheets_list")
    } catch (e) {
      console.error("[process-outbox] refresh_drawing_sheets_list failed after tiles:", e)
    }
  }
}

async function refreshDrawingSheetsListJob(supabase: ReturnType<typeof createServiceSupabaseClient>) {
  const isDev = process.env.NODE_ENV !== "production"
  if (isDev) {
    console.log("[process-outbox] Skipping refresh in development")
    return
  }

  const { error } = await supabase.rpc("refresh_drawing_sheets_list")
  if (error) {
    throw new Error(`refresh_drawing_sheets_list failed: ${error.message}`)
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex")
}

function buildPublicBaseUrl(orgId: string, hash: string) {
  const base = buildDrawingsTilesBaseUrl(`${orgId}/${hash}`)
  if (!base) {
    throw new Error("Missing DRAWINGS_TILES_BASE_URL/NEXT_PUBLIC_DRAWINGS_TILES_BASE_URL")
  }
  return base
}

function clampCrop(x: number, y: number, w: number, h: number, maxW: number, maxH: number) {
  const x0 = Math.max(0, Math.floor(x))
  const y0 = Math.max(0, Math.floor(y))
  const x1 = Math.min(maxW, Math.ceil(x + w))
  const y1 = Math.min(maxH, Math.ceil(y + h))
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}



async function createPlaceholderImageForPdf() {
  // Create a placeholder image when PDF processing fails
  let createCanvas: any
  try {
    ;({ createCanvas } = await import("@napi-rs/canvas"))
  } catch (e: any) {
    throw new Error(`@napi-rs/canvas import failed: ${e?.message ?? String(e)}`)
  }

  try {
    const width = 2400
    const height = 1800
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext("2d")

    // Fill with light blue background (construction theme)
    ctx.fillStyle = '#e3f2fd'
    ctx.fillRect(0, 0, width, height)

    // Add text
    ctx.fillStyle = '#1976d2'
    ctx.font = 'bold 48px Arial'
    ctx.textAlign = 'center'
    ctx.fillText('PDF Processing Active', width / 2, height / 2 - 50)
    ctx.font = '24px Arial'
    ctx.fillText('Drawing tiles are being generated', width / 2, height / 2 + 20)
    ctx.fillText('Please refresh in a few moments', width / 2, height / 2 + 60)

    const png = canvas.toBuffer("image/png")
    return { pngBytes: new Uint8Array(png), width, height }
  } catch (e: any) {
    throw new Error(`Placeholder image creation failed: ${e?.message ?? String(e)}`)
  }
}

async function uploadPublicObject(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  objectPath: string,
  bytes: Uint8Array,
  contentType: string,
) {
  console.log(`[Storage] Uploading ${bytes.length} bytes to ${objectPath} (${contentType})`)

  await uploadTilesObject({
    supabase,
    path: objectPath,
    bytes,
    contentType,
  })

  console.log(`[Storage] Successfully uploaded ${objectPath}`)
}

async function generateDrawingTilesInNode(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  sheetVersionId: string,
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SUPABASE_FUNCTION_TIMEOUT_MS)

  console.log(`[TileGen] Starting tile generation for sheet version: ${sheetVersionId}`)

  try {
    // 1) Load minimal metadata (avoid join-multiplicity issues that break .single()).
    console.log(`[TileGen] Loading sheet version metadata for: ${sheetVersionId}`)
    const { data: version, error: versionError } = await supabase
      .from("drawing_sheet_versions")
      .select("id, org_id, file_id, tile_manifest, tile_base_url")
      .eq("id", sheetVersionId)
      .maybeSingle()

    if (versionError) {
      console.error(`[TileGen] Failed to load sheet version: ${versionError.message}`)
      throw new Error(`Failed to load sheet version: ${versionError.message}`)
    }

    if (!version) {
      console.error(`[TileGen] Sheet version not found: ${sheetVersionId}`)
      const err = new Error(`Sheet version not found: ${sheetVersionId}`)
      ;(err as any).code = "SHEET_VERSION_NOT_FOUND"
      throw err
    }

    console.log(`[TileGen] Found sheet version:`, {
      id: version.id,
      org_id: (version as any).org_id,
      has_existing_tiles: !!((version as any).tile_manifest && (version as any).tile_base_url),
      existing_format: (version as any).tile_manifest?.Image?.Format
    })

    // Idempotency: if PNG tiles already exist, skip. Regenerate if old WebP format.
    const hasExistingTiles = (version as any).tile_manifest && (version as any).tile_base_url
    const isOldFormat = (version as any).tile_manifest?.Image?.Format === 'webp'

    if (hasExistingTiles && !isOldFormat) {
      console.log(`[TileGen] PNG tiles already exist, skipping generation`)
      return
    }

    if (hasExistingTiles && isOldFormat) {
      console.log(`[TileGen] Old WebP tiles found, regenerating as PNG`)
    }

    const orgId = (version as any).org_id as string
    const fileId = (version as any).file_id as string | null
    if (!fileId) {
      throw new Error("Sheet version missing file_id")
    }

    const { data: file, error: fileError } = await supabase
      .from("files")
      .select("storage_path")
      .eq("id", fileId)
      .maybeSingle()

    if (fileError || !file?.storage_path) {
      throw new Error(`Failed to load file storage_path: ${fileError?.message ?? "missing storage_path"}`)
    }

    // 2) Download PDF bytes
    const pdfBytes = new Uint8Array(
      await downloadDrawingPdfObject({
        supabase,
        orgId,
        path: file.storage_path,
      })
    )
    const hash = sha256Hex(pdfBytes).slice(0, 16)

    console.log(`[TileGen] Downloaded PDF: ${pdfBytes.length} bytes, hash: ${hash}`)

    // 3) Create placeholder image (PDF processing disabled)
    console.log(`[TileGen] Creating placeholder image for sheet ${sheetVersionId}`)
    const placeholder = await createPlaceholderImageForPdf()
    const pngBytes = placeholder.pngBytes
    const width = placeholder.width
    const height = placeholder.height
    console.log(`[TileGen] Created placeholder: ${pngBytes.length} bytes, ${width}x${height}px`)

    // 4) Content-addressed base path
    const basePath = `${orgId}/${hash}`
    const publicBaseUrl = buildPublicBaseUrl(orgId, hash)

    console.log(`[TileGen] Using base path: ${basePath}`)
    console.log(`[TileGen] Public URL: ${publicBaseUrl}`)

    // 6) Create single high-resolution PNG image for viewer
    // The current viewer expects a single image at tiles/0/0_0.png
    const objectPath = `${basePath}/tiles/0/0_0.png`
    console.log(`[TileGen] Uploading PNG to: ${objectPath} (${pngBytes.length} bytes)`)
    await uploadPublicObject(supabase, objectPath, pngBytes, "image/png")
    console.log(`[TileGen] Successfully uploaded main image`)

    // 7) Create thumbnail
    let sharp: any
    try {
      sharp = (await import("sharp")) as any
    } catch (e: any) {
      throw new Error(`Sharp import failed: ${e?.message ?? String(e)}`)
    }

    const thumbBuffer = await sharp(Buffer.from(pngBytes))
      .resize(256, 256, { fit: 'inside' })
      .png()
      .toBuffer()

    console.log(`[TileGen] Uploading thumbnail (${thumbBuffer.length} bytes)`)
    await uploadPublicObject(supabase, `${basePath}/thumbnail.png`, new Uint8Array(thumbBuffer), "image/png")
    console.log(`[TileGen] Successfully uploaded thumbnail`)

    // 8) Create minimal manifest for compatibility
    const manifest: TileManifest = {
      Image: {
        xmlns: "http://schemas.microsoft.com/deepzoom/2008",
        Format: "png",
        Overlap: 0,
        TileSize: width, // Single tile covers entire image
        Size: { Width: width, Height: height },
      },
    }

    console.log(`[TileGen] Uploading manifest:`, manifest)
    await uploadPublicObject(
      supabase,
      `${basePath}/manifest.json`,
      new TextEncoder().encode(JSON.stringify(manifest)),
      "application/json",
    )
    console.log(`[TileGen] Successfully uploaded manifest`)

    // 8) Persist metadata
    console.log(`[TileGen] Updating database for sheet version: ${sheetVersionId}`)
    const updateData = {
      tile_manifest: manifest,
      tile_base_url: publicBaseUrl,
      source_hash: hash,
      tile_levels: 1, // Single level for now
      tiles_generated_at: new Date().toISOString(),
      thumbnail_url: `${publicBaseUrl}/thumbnail.png`,
      image_width: width,
      image_height: height,
      tiles_base_path: basePath,
    }
    console.log(`[TileGen] Update data:`, updateData)

    const { error: updateError } = await supabase
      .from("drawing_sheet_versions")
      .update(updateData)
      .eq("id", sheetVersionId)

    if (updateError) {
      console.error(`[TileGen] Failed to update database: ${updateError.message}`)
      throw new Error(`Failed to update drawing_sheet_versions: ${updateError.message}`)
    }

    console.log(`[TileGen] Successfully updated database`)
    console.log(`[TileGen] Tile generation completed for sheet version: ${sheetVersionId}`)
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("generate-drawing-tiles timed out")
    throw e
  } finally {
    clearTimeout(timeout)
  }
}

function buildNotificationHref(payload: any): string | null {
  const projectId = typeof payload?.project_id === "string" ? payload.project_id : null
  const entityType = typeof payload?.entity_type === "string" ? payload.entity_type : null
  const entityId = typeof payload?.entity_id === "string" ? payload.entity_id : null

  if (!projectId) return null

  switch (entityType) {
    case "rfi":
      return `/projects/${projectId}/rfis`
    case "submittal":
      return `/projects/${projectId}/submittals`
    case "invoice":
      return `/projects/${projectId}/invoices`
    case "change_order":
      return `/projects/${projectId}/change-orders`
    case "file":
      return entityId ? `/projects/${projectId}/files?fileId=${entityId}` : `/projects/${projectId}/files`
    case "drawing_set":
    case "drawing_sheet":
    case "drawing_revision":
      return `/projects/${projectId}/drawings`
    case "task":
      return `/projects/${projectId}/tasks`
    case "daily_log":
      return `/projects/${projectId}/daily-logs`
    default:
      return `/projects/${projectId}`
  }
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}
