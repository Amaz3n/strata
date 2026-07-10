import { NextRequest, NextResponse } from "next/server"
import { createHash } from "node:crypto"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { withCronRun } from "@/lib/services/job-runs"
import {
  sendEmail,
  getOrgSenderEmail,
  renderEmailTemplate,
  renderStandardEmailLayout,
  sendBidInviteEmail,
  sendBidAddendumEmail,
  sendBidDateUpdateEmail,
} from "@/lib/services/mailer"
import { SignatureEmail } from "@/lib/emails/signature-email"
import { createExecutedFileAccessToken } from "@/lib/services/esign-executed-links"
import { approveChangeOrderFromEnvelopeExecution } from "@/lib/services/change-orders"
import { markCommitmentChangeOrderExecutedFromEnvelope } from "@/lib/services/commitment-change-orders"
import { markCommitmentExecutedFromEnvelope } from "@/lib/services/commitments"
import { executeEstimateFromEnvelopeExecution } from "@/lib/services/estimate-portal"
import { acceptProposalFromEnvelopeExecution } from "@/lib/services/proposals"
import { confirmSelectionFromEnvelopeExecution } from "@/lib/services/selections"
import { isEmailNotificationTypeEnabled, isEmailEligibleNotificationType } from "@/lib/services/notifications"
import { isApnsConfigured, sendApnsNotification } from "@/lib/services/apns"
import { buildDrawingsTilesBaseUrl } from "@/lib/storage/drawings-urls"
import {
  deleteTilesObjects,
  listTilesObjects,
  uploadTilesObject,
} from "@/lib/storage/drawings-tiles-storage"
import { runDrawingsPipeline } from "@/lib/services/drawings-pipeline"
import { downloadFilesObject, uploadFilesObject } from "@/lib/storage/files-storage"
import { reindexEntity, removeFromIndex } from "@/lib/services/search-index"
import { processInboundBillEmail } from "@/lib/services/payables-email-ingest"
import type { SearchEntityType } from "@/lib/services/search-config"

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
// Lightweight jobs (emails, indexing) run first; drawing pipeline jobs are
// drained afterwards with the remaining time budget.
const BATCH_SIZE = 50

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
async function handleGet(request: NextRequest) {
  // Vercel Cron invokes this route with GET in production — run the outbox
  // processor. (The block below is a local-dev-only debug surface.)
  if (process.env.NODE_ENV === "production") {
    return processOutboxQueue(request)
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

async function processOutboxQueue(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const isDev = process.env.NODE_ENV !== "production"
  const supabase = createServiceSupabaseClient()
  const now = new Date().toISOString()

  const { data: jobs, error } = await supabase
    .from("outbox")
    .select("*")
    .in("job_type", ["deliver_notification", "deliver_push", "send_daily_log_mention_email", "send_esign_executed_email", "send_bid_email", "process_esign_execution_side_effects", "refresh_drawing_sheets_list", "index_file", "generate_file_preview", "reindex_search", "remove_search_index", "process_inbound_bill_email"])
    .eq("status", "pending")
    .lte("run_at", now)
    .order("created_at", { ascending: false })
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
      } else if (job.job_type === "deliver_push") {
        await deliverPushJob(supabase, job)
      } else if (job.job_type === "send_daily_log_mention_email") {
        await sendDailyLogMentionEmailJob(supabase, job)
      } else if (job.job_type === "send_esign_executed_email") {
        await sendESignExecutedEmailJob(supabase, job)
      } else if (job.job_type === "send_bid_email") {
        await sendBidEmailJob(supabase, job)
      } else if (job.job_type === "process_esign_execution_side_effects") {
        await processESignExecutionSideEffectsJob(supabase, job)
      } else if (job.job_type === "refresh_drawing_sheets_list") {
        await refreshDrawingSheetsListJob(supabase)
      } else if (job.job_type === "index_file") {
        await indexFileJob(supabase, job)
      } else if (job.job_type === "generate_file_preview") {
        await generateFilePreviewJob(supabase, job)
      } else if (job.job_type === "reindex_search") {
        await reindexSearchJob(supabase, job)
      } else if (job.job_type === "remove_search_index") {
        await removeSearchIndexJob(supabase, job)
      } else if (job.job_type === "process_inbound_bill_email") {
        await processInboundBillEmailJob(job)
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

  // Drain drawing pipeline jobs (process_drawing_set / process_drawing_page /
  // generate_drawing_tiles) with whatever time budget remains. The dedicated
  // /api/jobs/drawings-pipeline kick route handles the fast path after
  // uploads; this is the cron safety net so nothing stays stuck.
  const drawings = await runDrawingsPipeline({ deadlineMs: Date.now() + 120_000 })

  return NextResponse.json(
    isDev ? { processed, failed, failures, drawings } : { processed, failed, drawings },
  )
}

export const GET = withCronRun("process-outbox", handleGet)
export const POST = withCronRun("process-outbox", processOutboxQueue)

async function deliverPushJob(supabase: ReturnType<typeof createServiceSupabaseClient>, job: any) {
  if (!isApnsConfigured()) return // env-gated: nothing to do until APNs is configured

  const payload = job.payload ?? {}
  const notificationId =
    (typeof payload.notificationId === "string" ? payload.notificationId : null) ??
    (typeof payload.notification_id === "string" ? payload.notification_id : null)
  if (!notificationId) throw new Error("Missing notificationId")

  const { data: notification, error: notifError } = await supabase
    .from("notifications")
    .select("id, org_id, user_id, notification_type, payload")
    .eq("id", notificationId)
    .maybeSingle()
  if (notifError || !notification) throw new Error(`Notification not found (${notifError?.message ?? "unknown error"})`)

  const { data: tokens } = await supabase
    .from("device_tokens")
    .select("id, token")
    .eq("user_id", notification.user_id)
  if (!tokens?.length) return

  const nPayload = (notification.payload ?? {}) as any
  const title = typeof nPayload.title === "string" ? nPayload.title : "Arc"
  const body = typeof nPayload.message === "string" ? nPayload.message : ""

  const staleTokenIds: string[] = []
  for (const row of tokens as Array<{ id: string; token: string }>) {
    const result = await sendApnsNotification({
      deviceToken: row.token,
      title,
      body,
      data: {
        notification_id: notification.id,
        type: notification.notification_type,
        project_id: typeof nPayload.project_id === "string" ? nPayload.project_id : undefined,
      },
    })
    if (result.unregistered) staleTokenIds.push(row.id)
  }

  // Prune tokens Apple reports as no longer valid so the table stays clean.
  if (staleTokenIds.length) {
    await supabase.from("device_tokens").delete().in("id", staleTokenIds)
  }
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

  // Email is an allowlist: non-eligible types are in-app only, regardless of
  // whether the user has a prefs row. Bail before sending anything.
  if (!isEmailEligibleNotificationType(notification.notification_type)) {
    return
  }

  const { data: prefs } = await supabase
    .from("user_notification_prefs")
    .select("email_enabled, email_type_settings")
    .eq("org_id", notification.org_id)
    .eq("user_id", notification.user_id)
    .maybeSingle()

  if (prefs && prefs.email_enabled === false) {
    return
  }
  if (prefs && !isEmailNotificationTypeEnabled(prefs.email_type_settings, notification.notification_type)) {
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

  const { data: org } = await supabase
    .from("orgs")
    .select("name, logo_url, slug")
    .eq("id", notification.org_id)
    .maybeSingle()

  const nPayload = (notification.payload ?? {}) as any
  const title = typeof nPayload.title === "string" ? nPayload.title : `Arc: ${notification.notification_type}`
  const message = typeof nPayload.message === "string" ? nPayload.message : ""

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com"
  const href = buildNotificationHref(nPayload)
  const buttonUrl = href ? `${appUrl}${href}` : undefined

  const html = renderStandardEmailLayout({
    title,
    messageHtml: `Hi ${escapeHtml(user.full_name || "there")},<br/><br/>${escapeHtml(message)}`,
    buttonText: "View in Arc",
    buttonUrl,
    orgName: org?.name,
    orgLogoUrl: org?.logo_url,
    appUrl,
  })

  await sendEmail({
    to: [user.email],
    subject: title,
    html,
    from: getOrgSenderEmail(org?.slug, org?.name),
  })
}

async function sendDailyLogMentionEmailJob(supabase: ReturnType<typeof createServiceSupabaseClient>, job: any) {
  const payload = job.payload ?? {}
  const userId = typeof payload.user_id === "string" ? payload.user_id : null
  const projectId = typeof payload.project_id === "string" ? payload.project_id : null
  const dailyLogId = typeof payload.daily_log_id === "string" ? payload.daily_log_id : null
  const title = typeof payload.title === "string" ? payload.title : "You were mentioned in a daily log"
  const message = typeof payload.message === "string" ? payload.message : "A teammate mentioned you in a daily log."

  if (!userId || !projectId || !dailyLogId) {
    throw new Error("Missing daily log mention email payload")
  }

  const { data: prefs } = await supabase
    .from("user_notification_prefs")
    .select("email_enabled, email_type_settings")
    .eq("org_id", job.org_id)
    .eq("user_id", userId)
    .maybeSingle()

  if (prefs && prefs.email_enabled === false) {
    return
  }
  if (prefs && !isEmailNotificationTypeEnabled(prefs.email_type_settings, "daily_log_mentioned")) {
    return
  }

  const { data: user, error: userError } = await supabase
    .from("app_users")
    .select("email, full_name")
    .eq("id", userId)
    .maybeSingle()

  if (userError || !user?.email) {
    throw new Error("User email not found")
  }

  const { data: org } = await supabase
    .from("orgs")
    .select("name, logo_url, slug")
    .eq("id", job.org_id)
    .maybeSingle()

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com"
  const buttonUrl = `${appUrl}/projects/${projectId}/daily-logs?logId=${dailyLogId}`
  const html = renderStandardEmailLayout({
    title,
    messageHtml: `Hi ${escapeHtml(user.full_name || "there")},<br/><br/>${escapeHtml(message)}`,
    buttonText: "View daily log",
    buttonUrl,
    orgName: org?.name,
    orgLogoUrl: org?.logo_url,
    appUrl,
  })

  await sendEmail({
    to: [user.email],
    subject: title,
    html,
    from: getOrgSenderEmail(org?.slug, org?.name),
  })
}

function buildExecutedDocumentUrl(token: string) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  return appUrl ? `${appUrl}/api/esign/executed/${token}` : `/api/esign/executed/${token}`
}

async function sendESignExecutedEmailJob(supabase: ReturnType<typeof createServiceSupabaseClient>, job: any) {
  const payload = job.payload ?? {}
  const executedFileId = typeof payload.executed_file_id === "string" ? payload.executed_file_id : null
  const recipientEmail = typeof payload.recipient_email === "string" ? payload.recipient_email : null
  const recipientName = typeof payload.recipient_name === "string" ? payload.recipient_name : ""
  const payloadDocumentTitle = typeof payload.document_title === "string" ? payload.document_title : null

  if (!executedFileId || !recipientEmail) {
    throw new Error("Missing executed_file_id or recipient_email")
  }

  const { data: file, error: fileError } = await supabase
    .from("files")
    .select("id, org_id, storage_path, file_name, mime_type, size_bytes")
    .eq("id", executedFileId)
    .maybeSingle()

  if (fileError || !file) {
    throw new Error(`Executed file not found (${fileError?.message ?? "missing"})`)
  }

  const { data: org } = await supabase
    .from("orgs")
    .select("name, logo_url, slug")
    .eq("id", file.org_id)
    .maybeSingle()

  const documentTitle = payloadDocumentTitle ?? file.file_name ?? "Document"
  const executedUrl = buildExecutedDocumentUrl(createExecutedFileAccessToken(file.id))
  const bytes = await downloadFilesObject({
    supabase,
    orgId: file.org_id,
    path: file.storage_path,
  })

  const html = await renderEmailTemplate(
    SignatureEmail({
      documentTitle,
      signingLink: executedUrl,
      recipientName,
      orgName: org?.name ?? null,
      orgLogoUrl: org?.logo_url ?? null,
      eventLabel: "Document Executed",
      headline: "Document fully executed",
      bodyText: `${documentTitle} has been fully executed.`,
      detailLabel: "Executed Copy",
      detailText: "Open the executed PDF to review the completed document. A copy is also attached to this email.",
      buttonText: "Open Executed PDF",
      previewText: `Document executed: ${documentTitle}`,
    }),
  )

  await sendEmail({
    to: [recipientEmail],
    subject: `Document executed: ${documentTitle}`,
    html,
    from: getOrgSenderEmail(org?.slug, org?.name),
    attachments: [
      {
        filename: file.file_name ?? "executed.pdf",
        content: Buffer.from(bytes).toString("base64"),
        contentType: file.mime_type ?? "application/pdf",
      },
    ],
  })
}

async function sendBidEmailJob(supabase: ReturnType<typeof createServiceSupabaseClient>, job: any) {
  const payload = job.payload ?? {}
  const kind = typeof payload.kind === "string" ? payload.kind : null
  const to = typeof payload.to === "string" ? payload.to : null
  if (!kind || !to) {
    throw new Error("Missing bid email kind or recipient")
  }

  if (kind === "invite") {
    await sendBidInviteEmail({
      to,
      companyName: typeof payload.companyName === "string" ? payload.companyName : undefined,
      contactName: typeof payload.contactName === "string" ? payload.contactName : undefined,
      projectName: typeof payload.projectName === "string" ? payload.projectName : undefined,
      bidPackageTitle: String(payload.bidPackageTitle ?? "Bid package"),
      trade: typeof payload.trade === "string" ? payload.trade : undefined,
      dueDate: typeof payload.dueDate === "string" ? payload.dueDate : null,
      orgName: typeof payload.orgName === "string" ? payload.orgName : undefined,
      orgLogoUrl: typeof payload.orgLogoUrl === "string" ? payload.orgLogoUrl : undefined,
      bidLink: String(payload.bidLink ?? ""),
      orgSlug: typeof payload.orgSlug === "string" ? payload.orgSlug : undefined,
    })
    return
  }

  if (kind === "addendum") {
    await sendBidAddendumEmail({
      to,
      companyName: typeof payload.companyName === "string" ? payload.companyName : undefined,
      contactName: typeof payload.contactName === "string" ? payload.contactName : undefined,
      projectName: typeof payload.projectName === "string" ? payload.projectName : undefined,
      bidPackageTitle: String(payload.bidPackageTitle ?? "Bid package"),
      addendumNumber: Number(payload.addendumNumber ?? 0),
      addendumTitle: typeof payload.addendumTitle === "string" ? payload.addendumTitle : null,
      addendumMessage: typeof payload.addendumMessage === "string" ? payload.addendumMessage : null,
      orgName: typeof payload.orgName === "string" ? payload.orgName : undefined,
      orgLogoUrl: typeof payload.orgLogoUrl === "string" ? payload.orgLogoUrl : undefined,
      bidLink: String(payload.bidLink ?? ""),
      orgSlug: typeof payload.orgSlug === "string" ? payload.orgSlug : undefined,
    })
    return
  }

  if (kind === "date_update") {
    await sendBidDateUpdateEmail({
      to,
      companyName: typeof payload.companyName === "string" ? payload.companyName : undefined,
      contactName: typeof payload.contactName === "string" ? payload.contactName : undefined,
      projectName: typeof payload.projectName === "string" ? payload.projectName : undefined,
      bidPackageTitle: String(payload.bidPackageTitle ?? "Bid package"),
      oldDueDate: typeof payload.oldDueDate === "string" ? payload.oldDueDate : null,
      newDueDate: String(payload.newDueDate ?? ""),
      orgName: typeof payload.orgName === "string" ? payload.orgName : undefined,
      orgLogoUrl: typeof payload.orgLogoUrl === "string" ? payload.orgLogoUrl : undefined,
      bidLink: String(payload.bidLink ?? ""),
      orgSlug: typeof payload.orgSlug === "string" ? payload.orgSlug : undefined,
    })
    return
  }

  if (kind === "award_notice") {
    const outcome = payload.outcome === "winner" ? "winner" : "not_selected"
    const orgName = typeof payload.orgName === "string" ? payload.orgName : undefined
    const orgLogoUrl = typeof payload.orgLogoUrl === "string" ? payload.orgLogoUrl : undefined
    const contactName = typeof payload.contactName === "string" ? payload.contactName : ""
    const projectName = typeof payload.projectName === "string" ? payload.projectName : null
    const bidPackageTitle = String(payload.bidPackageTitle ?? "Bid package")
    const title = outcome === "winner" ? `Bid awarded: ${bidPackageTitle}` : `Bid update: ${bidPackageTitle}`
    const message = outcome === "winner"
      ? `Your bid${projectName ? ` for ${projectName}` : ""} has been selected. The builder will follow up with next steps.`
      : `Thank you for bidding${projectName ? ` ${projectName}` : ""}. This package has been awarded to another bidder.`

    const html = renderStandardEmailLayout({
      title,
      messageHtml: `Hi ${escapeHtml(contactName || "there")},<br/><br/>${escapeHtml(message)}`,
      orgName,
      orgLogoUrl,
      appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com",
    })

    await sendEmail({
      to: [to],
      subject: title,
      html,
      from: getOrgSenderEmail(typeof payload.orgSlug === "string" ? payload.orgSlug : undefined, orgName),
    })
    return
  }

  throw new Error(`Unknown bid email kind: ${kind}`)
}

async function processESignExecutionSideEffectsJob(supabase: ReturnType<typeof createServiceSupabaseClient>, job: any) {
  const payload = job.payload ?? {}
  const orgId = job.org_id as string
  const documentId = typeof payload.document_id === "string" ? payload.document_id : null
  const envelopeId = typeof payload.envelope_id === "string" ? payload.envelope_id : null
  const executedFileId = typeof payload.executed_file_id === "string" ? payload.executed_file_id : null
  const signerName = typeof payload.signer_name === "string" ? payload.signer_name : "Document signer"
  const signerEmail = typeof payload.signer_email === "string" ? payload.signer_email : null
  const signerIp = typeof payload.signer_ip === "string" ? payload.signer_ip : null

  if (!orgId || !documentId || !executedFileId) {
    throw new Error("Missing org/document/executed file payload for e-sign side effects")
  }

  const { data: document, error } = await supabase
    .from("documents")
    .select("id, org_id, source_entity_type, source_entity_id, metadata")
    .eq("org_id", orgId)
    .eq("id", documentId)
    .maybeSingle()

  if (error || !document) {
    throw new Error(`Document not found (${error?.message ?? "missing"})`)
  }

  const proposalId =
    document.source_entity_type === "proposal"
      ? document.source_entity_id
      : (document.metadata?.proposal_id as string | undefined)
  if (proposalId) {
    await acceptProposalFromEnvelopeExecution({
      orgId,
      proposalId,
      documentId,
      envelopeId,
      executedFileId,
      signerName,
      signerEmail,
      signerIp,
    })
  }

  const estimateId =
    document.source_entity_type === "estimate"
      ? document.source_entity_id
      : (document.metadata?.estimate_id as string | undefined)
  if (estimateId) {
    await executeEstimateFromEnvelopeExecution({
      orgId,
      estimateId,
      documentId,
      envelopeId,
      executedFileId,
      signerName,
      signerEmail,
      signerIp,
    })
  }

  const changeOrderId =
    document.source_entity_type === "change_order"
      ? document.source_entity_id
      : (document.metadata?.change_order_id as string | undefined)
  if (changeOrderId) {
    await approveChangeOrderFromEnvelopeExecution({
      orgId,
      changeOrderId,
      envelopeId,
      documentId,
      executedFileId,
      signerName,
      signerEmail,
      signerIp,
    })
  }

  const commitmentChangeOrderId =
    document.source_entity_type === "subcontract_change_order"
      ? document.source_entity_id
      : (document.metadata?.subcontract_change_order_id as string | undefined)
  if (commitmentChangeOrderId) {
    await markCommitmentChangeOrderExecutedFromEnvelope({
      orgId,
      commitmentChangeOrderId,
      envelopeId,
      documentId,
      executedFileId,
      signerName,
      signerEmail,
      signerIp,
    })
  }

  const commitmentId =
    document.source_entity_type === "subcontract"
      ? document.source_entity_id
      : (document.metadata?.subcontract_id as string | undefined)
  if (commitmentId) {
    await markCommitmentExecutedFromEnvelope({
      orgId,
      commitmentId,
      envelopeId,
      documentId,
      executedFileId,
      signerName,
      signerEmail,
      signerIp,
    })
  }

  const selectionId =
    document.source_entity_type === "selection"
      ? document.source_entity_id
      : (document.metadata?.selection_id as string | undefined)
  if (selectionId) {
    await confirmSelectionFromEnvelopeExecution({
      orgId,
      selectionId,
      envelopeId,
      documentId,
      executedFileId,
      signerName,
      signerEmail,
      signerIp,
    })
  }
}

function readSearchIndexJobRef(job: any): { entityType: SearchEntityType; entityId: string } {
  const payload = job.payload ?? {}
  const entityType = typeof payload.entity_type === "string" ? (payload.entity_type as SearchEntityType) : null
  const entityId = typeof payload.entity_id === "string" ? payload.entity_id : null
  if (!entityType || !entityId) {
    throw new Error("Missing entity_type/entity_id for search index job")
  }
  if (!job.org_id) {
    throw new Error("Missing org_id for search index job")
  }
  return { entityType, entityId }
}

async function reindexSearchJob(supabase: ReturnType<typeof createServiceSupabaseClient>, job: any) {
  const { entityType, entityId } = readSearchIndexJobRef(job)
  await reindexEntity({ orgId: job.org_id, entityType, entityId }, supabase)
}

async function processInboundBillEmailJob(job: any) {
  const payload = job.payload ?? {}
  const emailId = typeof payload.email_id === "string" ? payload.email_id : null
  if (!emailId) throw new Error("Missing email_id for inbound bill job")
  await processInboundBillEmail({ orgId: job.org_id, emailId })
}

async function removeSearchIndexJob(supabase: ReturnType<typeof createServiceSupabaseClient>, job: any) {
  const { entityType, entityId } = readSearchIndexJobRef(job)
  await removeFromIndex({ orgId: job.org_id, entityType, entityId }, supabase)
}

const MAX_FILE_INDEX_TEXT_LENGTH = 200_000
type MupdfModule = typeof import("mupdf")

function normalizeExtractedText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_FILE_INDEX_TEXT_LENGTH)
}

function extractStructuredPageText(page: any): string {
  try {
    const structured = JSON.parse(page.toStructuredText("preserve-whitespace").asJSON())
    const parts: string[] = []
    for (const block of structured.blocks ?? []) {
      for (const line of block.lines ?? []) {
        if (typeof line.text === "string") {
          parts.push(line.text)
        } else if (Array.isArray(line.spans)) {
          parts.push(line.spans.map((span: any) => span.text ?? "").join(""))
        }
      }
    }
    return parts.join("\n")
  } catch (error) {
    console.warn("[index_file] Failed to extract PDF page text", error)
    return ""
  }
}

async function extractPdfText(bytes: Buffer): Promise<string> {
  const mupdf: MupdfModule = await import("mupdf")
  const doc = mupdf.Document.openDocument(bytes, "application/pdf")
  const pageCount = Math.min(doc.countPages(), 250)
  const pages: string[] = []

  try {
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const page = doc.loadPage(pageIndex)
      try {
        const text = extractStructuredPageText(page)
        if (text) pages.push(text)
      } finally {
        page.destroy?.()
      }
      if (pages.join("\n").length >= MAX_FILE_INDEX_TEXT_LENGTH) break
    }
  } finally {
    doc.destroy?.()
  }

  return normalizeExtractedText(pages.join("\n"))
}

async function extractDocxText(bytes: Buffer): Promise<string> {
  const mammothModule: any = await import("mammoth")
  const mammoth = mammothModule.default ?? mammothModule
  const result = await mammoth.extractRawText({ buffer: bytes })
  return normalizeExtractedText(result.value ?? "")
}

async function extractIndexableFileText({
  bytes,
  fileName,
  mimeType,
}: {
  bytes: Buffer
  fileName?: string | null
  mimeType?: string | null
}): Promise<string> {
  const lowerName = fileName?.toLowerCase() ?? ""
  const lowerMime = mimeType?.toLowerCase() ?? ""

  if (lowerMime.startsWith("text/") || lowerMime === "text/csv" || lowerName.endsWith(".txt") || lowerName.endsWith(".csv")) {
    return normalizeExtractedText(bytes.toString("utf8"))
  }

  if (lowerMime === "application/pdf" || lowerName.endsWith(".pdf")) {
    return extractPdfText(bytes)
  }

  if (
    lowerMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lowerName.endsWith(".docx")
  ) {
    return extractDocxText(bytes)
  }

  return ""
}

async function indexFileJob(supabase: ReturnType<typeof createServiceSupabaseClient>, job: any) {
  const payload = job.payload ?? {}
  const fileId = typeof payload.fileId === "string" ? payload.fileId : null
  if (!fileId) {
    throw new Error("Missing fileId")
  }

  const { data: file, error } = await supabase
    .from("files")
    .select("id, org_id, project_id, file_name, storage_path, mime_type, metadata, checksum")
    .eq("id", fileId)
    .maybeSingle()

  if (error || !file) {
    throw new Error(`File not found (${error?.message ?? "unknown error"})`)
  }

  const bytes = await downloadFilesObject({
    supabase,
    orgId: file.org_id,
    path: file.storage_path,
  })
  const checksum = createHash("sha256").update(bytes).digest("hex")
  let extractedText = ""
  let extractionStatus: "ready" | "empty" | "failed" = "empty"
  let extractionError: string | undefined
  try {
    extractedText = await extractIndexableFileText({
      bytes,
      fileName: file.file_name,
      mimeType: file.mime_type,
    })
    extractionStatus = extractedText ? "ready" : "empty"
  } catch (error: any) {
    extractionStatus = "failed"
    extractionError = String(error?.message ?? error).slice(0, 500)
    console.warn("[index_file] Failed to extract file text", { fileId: file.id, error: extractionError })
  }
  const metadata = file.metadata && typeof file.metadata === "object" ? file.metadata as Record<string, any> : {}

  const { error: updateError } = await supabase
    .from("files")
    .update({
      checksum: file.checksum ?? checksum,
      metadata: {
        ...metadata,
        search: {
          ...(metadata.search ?? {}),
          extracted_text: extractedText,
          extracted_at: new Date().toISOString(),
          extraction_status: extractionStatus,
          extraction_source: extractedText ? "embedded_text" : "none",
          character_count: extractedText.length,
          extraction_error: extractionError ?? null,
        },
      },
    })
    .eq("id", file.id)

  if (updateError) {
    throw new Error(`Failed to update file search metadata: ${updateError.message}`)
  }

  await reindexEntity({ orgId: file.org_id, entityType: "file", entityId: file.id }, supabase)
}

async function generateFilePreviewJob(supabase: ReturnType<typeof createServiceSupabaseClient>, job: any) {
  const payload = job.payload ?? {}
  const fileId = typeof payload.fileId === "string" ? payload.fileId : null
  if (!fileId) {
    throw new Error("Missing fileId")
  }

  const { data: file, error } = await supabase
    .from("files")
    .select("id, org_id, project_id, file_name, storage_path, mime_type, metadata")
    .eq("id", fileId)
    .maybeSingle()

  if (error || !file) {
    throw new Error(`File not found (${error?.message ?? "unknown error"})`)
  }

  const metadata = file.metadata && typeof file.metadata === "object" ? file.metadata as any : {}
  await supabase
    .from("files")
    .update({
      metadata: {
        ...metadata,
        preview: {
          ...(metadata.preview ?? {}),
          status: "processing",
          started_at: new Date().toISOString(),
        },
      },
    })
    .eq("id", file.id)

  try {
    const mimeType = file.mime_type ?? "application/octet-stream"
    const sourceBytes = await downloadFilesObject({
      supabase,
      orgId: file.org_id,
      path: file.storage_path,
    })

    const lowerFileName = String(file.file_name ?? "").toLowerCase()
    const lowerStoragePath = String(file.storage_path ?? "").toLowerCase()
    const isHeic =
      mimeType.toLowerCase() === "image/heic" ||
      mimeType.toLowerCase() === "image/heif" ||
      lowerFileName.endsWith(".heic") ||
      lowerFileName.endsWith(".heif") ||
      lowerStoragePath.endsWith(".heic") ||
      lowerStoragePath.endsWith(".heif")
    const isDocx =
      mimeType.toLowerCase() ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      lowerFileName.endsWith(".docx") ||
      lowerStoragePath.endsWith(".docx")

    // Word documents render to a self-contained HTML preview rather than an image thumbnail.
    if (isDocx) {
      const { convertDocxToPreviewHtml } = await import("@/lib/services/word-preview")
      const { html } = await convertDocxToPreviewHtml(sourceBytes)
      const safeBaseName = file.file_name.replace(/[^a-zA-Z0-9.-]/g, "_")
      const htmlPath = `${file.org_id}/${file.project_id ?? "general"}/documents/previews/${file.id}/${Date.now()}_${safeBaseName}.html`
      await uploadFilesObject({
        supabase,
        orgId: file.org_id,
        path: htmlPath,
        bytes: new TextEncoder().encode(html),
        contentType: "text/html; charset=utf-8",
        cacheControl: "private, max-age=86400",
      })
      await updateFilePreviewMetadata(supabase, file.id, metadata, {
        status: "ready",
        kind: "html",
        html_path: htmlPath,
        content_type: "text/html",
        generated_at: new Date().toISOString(),
      })
      return
    }

    const preview =
      mimeType.startsWith("image/") || isHeic
        ? isHeic
          ? await generateHeicJpegPreview(sourceBytes)
          : await generateImageThumbnail(sourceBytes)
        : mimeType === "application/pdf"
          ? await generatePdfThumbnail(sourceBytes, file.file_name)
          : null

    if (!preview) {
      await updateFilePreviewMetadata(supabase, file.id, metadata, {
        status: "skipped",
        reason: "unsupported_type",
        mime_type: mimeType,
      })
      return
    }

    const safeBaseName = file.file_name.replace(/[^a-zA-Z0-9.-]/g, "_")
    const extension = preview.contentType === "image/jpeg" ? "jpg" : "webp"
    const thumbnailPath = `${file.org_id}/${file.project_id ?? "general"}/documents/previews/${file.id}/${Date.now()}_${safeBaseName}.${extension}`
    await uploadFilesObject({
      supabase,
      orgId: file.org_id,
      path: thumbnailPath,
      bytes: preview.bytes,
      contentType: preview.contentType,
      cacheControl: "private, max-age=86400",
    })

    await updateFilePreviewMetadata(supabase, file.id, metadata, {
      status: "ready",
      thumbnail_path: thumbnailPath,
      width: preview.width,
      height: preview.height,
      content_type: preview.contentType,
      generated_at: new Date().toISOString(),
    })
  } catch (error: any) {
    await updateFilePreviewMetadata(supabase, file.id, metadata, {
      status: "failed",
      error: String(error?.message ?? error).slice(0, 500),
      failed_at: new Date().toISOString(),
    })
    throw error
  }
}

async function updateFilePreviewMetadata(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  fileId: string,
  existingMetadata: Record<string, any>,
  preview: Record<string, any>
) {
  const { error } = await supabase
    .from("files")
    .update({
      metadata: {
        ...existingMetadata,
        preview,
      },
    })
    .eq("id", fileId)

  if (error) {
    throw new Error(`Failed to update preview metadata: ${error.message}`)
  }
}

async function generateImageThumbnail(
  sourceBytes: Buffer
): Promise<{ bytes: Uint8Array; width: number; height: number; contentType: string }> {
  const sharp = (await import("sharp")).default
  const result = await sharp(sourceBytes, { limitInputPixels: false })
    .rotate()
    .resize(640, 640, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer({ resolveWithObject: true })

  return {
    bytes: new Uint8Array(result.data),
    width: result.info.width,
    height: result.info.height,
    contentType: "image/webp",
  }
}

async function generateHeicJpegPreview(
  sourceBytes: Buffer
): Promise<{ bytes: Uint8Array; width: number; height: number; contentType: string }> {
  const convertModule = await import("heic-convert")
  const convert = (convertModule as any).default ?? convertModule
  const jpegBytes = await convert({
    buffer: sourceBytes,
    format: "JPEG",
    quality: 0.92,
  })

  const sharp = (await import("sharp")).default
  const result = await sharp(Buffer.from(jpegBytes), { limitInputPixels: false })
    .rotate()
    .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer({ resolveWithObject: true })

  return {
    bytes: new Uint8Array(result.data),
    width: result.info.width,
    height: result.info.height,
    contentType: "image/jpeg",
  }
}

async function generatePdfThumbnail(
  sourceBytes: Buffer,
  fileName: string
): Promise<{ bytes: Uint8Array; width: number; height: number; contentType: string }> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const { createCanvas } = await import("@napi-rs/canvas")
    const loadingTask = (pdfjs as any).getDocument({
      data: new Uint8Array(sourceBytes),
      disableWorker: true,
      useSystemFonts: true,
      isEvalSupported: false,
    })
    const pdf = await loadingTask.promise
    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    const scale = Math.min(900 / viewport.width, 900 / viewport.height, 2)
    const scaledViewport = page.getViewport({ scale })
    const canvas = createCanvas(Math.ceil(scaledViewport.width), Math.ceil(scaledViewport.height))
    const context = canvas.getContext("2d")

    await page.render({
      canvasContext: context,
      viewport: scaledViewport,
    }).promise

    const png = canvas.toBuffer("image/png")
    const sharp = (await import("sharp")).default
    const result = await sharp(png)
      .resize(640, 640, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer({ resolveWithObject: true })

    await pdf.destroy?.()
    return {
      bytes: new Uint8Array(result.data),
      width: result.info.width,
      height: result.info.height,
      contentType: "image/webp",
    }
  } catch (error) {
    console.warn("[file-preview] PDF render failed, using placeholder:", error)
    return createPdfPlaceholderThumbnail(fileName)
  }
}

async function createPdfPlaceholderThumbnail(
  fileName: string
): Promise<{ bytes: Uint8Array; width: number; height: number; contentType: string }> {
  const { createCanvas } = await import("@napi-rs/canvas")
  const sharp = (await import("sharp")).default
  const width = 640
  const height = 480
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext("2d")
  ctx.fillStyle = "#f8fafc"
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = "#cbd5e1"
  ctx.lineWidth = 2
  ctx.strokeRect(80, 48, 480, 384)
  ctx.fillStyle = "#e2e8f0"
  ctx.fillRect(120, 110, 400, 18)
  ctx.fillRect(120, 150, 320, 14)
  ctx.fillRect(120, 184, 360, 14)
  ctx.fillRect(120, 218, 280, 14)
  ctx.fillStyle = "#0f172a"
  ctx.font = "bold 34px Arial"
  ctx.fillText("PDF", 120, 320)
  ctx.font = "20px Arial"
  ctx.fillStyle = "#475569"
  ctx.fillText(fileName.slice(0, 42), 120, 360)

  const result = await sharp(canvas.toBuffer("image/png"))
    .webp({ quality: 78 })
    .toBuffer({ resolveWithObject: true })
  return {
    bytes: new Uint8Array(result.data),
    width: result.info.width,
    height: result.info.height,
    contentType: "image/webp",
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


function buildNotificationHref(payload: any): string | null {
  const projectId = typeof payload?.project_id === "string" ? payload.project_id : null
  const entityType = typeof payload?.entity_type === "string" ? payload.entity_type : null
  const entityId = typeof payload?.entity_id === "string" ? payload.entity_id : null
  const logId = typeof payload?.daily_log_id === "string" ? payload.daily_log_id : null

  // Pipeline estimates live outside the project workspace; route to the
  // prospect pipeline (or the standalone estimates list) so the CTA still works.
  if (entityType === "estimate") {
    return typeof payload?.prospect_id === "string" ? "/pipeline" : "/estimates"
  }

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
      return entityId ? `/projects/${projectId}/documents?fileId=${entityId}` : `/projects/${projectId}/documents`
    case "drawing_set":
    case "drawing_sheet":
    case "drawing_revision":
      return `/projects/${projectId}/drawings`
    case "task":
      return `/projects/${projectId}/tasks`
    case "daily_log":
      return logId ? `/projects/${projectId}/daily-logs?logId=${logId}` : `/projects/${projectId}/daily-logs`
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
