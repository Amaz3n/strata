import { NextRequest, NextResponse } from "next/server"
import { createHash } from "node:crypto"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { sendEmail } from "@/lib/services/mailer"

// Polyfill DOM APIs for PDF.js in Node.js environment
if (typeof globalThis.DOMMatrix === "undefined") {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init?: string | number[]) {
      // Minimal implementation for PDF.js transforms
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      if (typeof init === "string") {
        const match = init.match(/matrix\(([^)]+)\)/);
        if (match) {
          const values = match[1].split(",").map(v => parseFloat(v.trim()));
          this.a = values[0]; this.b = values[1]; this.c = values[2];
          this.d = values[3]; this.e = values[4]; this.f = values[5];
        }
      } else if (Array.isArray(init)) {
        this.a = init[0] || 1; this.b = init[1] || 0; this.c = init[2] || 0;
        this.d = init[3] || 1; this.e = init[4] || 0; this.f = init[5] || 0;
      }
    }
    a: number; b: number; c: number; d: number; e: number; f: number;
    multiply(matrix: DOMMatrix) {
      const m = new DOMMatrix();
      m.a = this.a * matrix.a + this.c * matrix.b;
      m.b = this.b * matrix.a + this.d * matrix.b;
      m.c = this.a * matrix.c + this.c * matrix.d;
      m.d = this.b * matrix.c + this.d * matrix.d;
      m.e = this.a * matrix.e + this.c * matrix.f + this.e;
      m.f = this.b * matrix.e + this.d * matrix.f + this.f;
      return m;
    }
    translate(x: number, y: number) {
      const m = new DOMMatrix();
      m.a = this.a; m.b = this.b; m.c = this.c; m.d = this.d;
      m.e = this.a * x + this.c * y + this.e;
      m.f = this.b * x + this.d * y + this.f;
      return m;
    }
    scale(scaleX: number, scaleY = scaleX) {
      const m = new DOMMatrix();
      m.a = this.a * scaleX; m.b = this.b * scaleX;
      m.c = this.c * scaleY; m.d = this.d * scaleY;
      m.e = this.e; m.f = this.f;
      return m;
    }
  } as any;
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

async function generateTilesLocally(pdfBytes: Uint8Array, orgId: string, supabase: any) {
  // Actually process the PDF to create real tiles
  let sharp: any
  let pdfToImg: any

  try {
    sharp = (await import("sharp")) as any
  } catch (e) {
    throw new Error(`Sharp not available: ${e?.message ?? String(e)}`)
  }

  try {
    // Try to load pdf-to-img for PDF processing
    pdfToImg = await import("pdf-to-img")
  } catch (e) {
    console.warn('pdf-to-img not available, falling back to Sharp-only processing')
    pdfToImg = null
  }

  let imageBuffer: Buffer
  let metadata: { width: number; height: number }

  if (pdfToImg) {
    // Use pdf-to-img to convert PDF to image (like the Edge Function)
    try {
      const doc = await pdfToImg.pdf(pdfBytes, { scale: 2.0 })
      let firstPage: Uint8Array | undefined

      for await (const page of doc) {
        firstPage = page as Uint8Array
        break // Only process first page
      }

      if (!firstPage) {
        throw new Error('No pages found in PDF')
      }

      imageBuffer = Buffer.from(firstPage)
      const img = sharp(imageBuffer)
      const imgMetadata = await img.metadata()
      metadata = { width: imgMetadata.width || 2400, height: imgMetadata.height || 1800 }

    } catch (pdfError) {
      console.warn('PDF processing failed, using placeholder:', pdfError)
      // Fall back to placeholder
      return await createPlaceholderImage(orgId, supabase)
    }
  } else {
    // pdf-to-img not available, show a message about real processing
    console.log('📄 For real PDF processing locally:')
    console.log('   npm install pdf-to-img')
    console.log('   Then re-upload drawings to see real processed PDFs')
    console.log('')
    console.log('🚀 In production, PDFs are processed automatically by Edge Functions')
    return await createPlaceholderImage(orgId, supabase, 'Run: npm install pdf-to-img')
  }

  // Create tiles from the processed image
  const hash = `real-${Date.now()}`
  const basePath = `${orgId}/${hash}`
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const tileBaseUrl = `${supabaseUrl}/storage/v1/object/public/drawings-tiles/${basePath}`

  // For simplicity, just use the full image as a single tile
  // In production, this would create proper tile pyramid
  const tilePath = `${basePath}/tiles/0/0_0.png`
  const { error: tileError } = await supabase.storage
    .from("drawings-tiles")
    .upload(tilePath, imageBuffer, {
      contentType: "image/png",
      cacheControl: "public, max-age=31536000, immutable",
      upsert: true
    })

  if (tileError && !tileError.message?.includes?.('already exists')) {
    throw new Error(`Failed to upload tile: ${tileError.message}`)
  }

  // Generate thumbnail
  const thumbBuffer = await sharp(imageBuffer)
    .resize(256, 256, { fit: 'inside' })
    .png()
    .toBuffer()

  const thumbPath = `${basePath}/thumbnail.png`
  const { error: thumbError } = await supabase.storage
    .from("drawings-tiles")
    .upload(thumbPath, thumbBuffer, {
      contentType: "image/png",
      cacheControl: "public, max-age=31536000, immutable",
      upsert: true
    })

  if (thumbError && !thumbError.message?.includes?.('already exists')) {
    throw new Error(`Failed to upload thumbnail: ${thumbError.message}`)
  }

  return {
    tile_manifest: {
      Image: {
        xmlns: "http://schemas.microsoft.com/deepzoom/2008",
        Format: "png",
        Overlap: 0,
        TileSize: metadata.width, // Single tile covers entire image
        Size: { Width: metadata.width, Height: metadata.height }
      }
    },
    tile_base_url: tileBaseUrl,
    source_hash: hash,
    tile_levels: 1,
    tiles_generated_at: new Date().toISOString(),
    thumbnail_url: `${tileBaseUrl}/thumbnail.png`,
    image_width: metadata.width,
    image_height: metadata.height,
  }
}

async function createVisibleTestImage(orgId: string, supabase: any) {
  // Create a HIGHLY VISIBLE test image with bright colors
  let sharp: any
  try {
    sharp = (await import("sharp")) as any
  } catch (e) {
    throw new Error(`Sharp not available: ${e?.message ?? String(e)}`)
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
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const tileBaseUrl = `${supabaseUrl}/storage/v1/object/public/drawings-tiles/${basePath}`

  // Upload the visible test image
  const tilePath = `${basePath}/tiles/0/0_0.png`
  const { error: tileError } = await supabase.storage
    .from("drawings-tiles")
    .upload(tilePath, imageBuffer, {
      contentType: "image/png",
      cacheControl: "public, max-age=31536000, immutable",
      upsert: true
    })

  if (tileError) {
    console.error('Tile upload error:', tileError)
    throw new Error(`Failed to upload test image: ${tileError.message}`)
  }

  const thumbPath = `${basePath}/thumbnail.png`
  await supabase.storage.from("drawings-tiles").upload(thumbPath, thumbBuffer, {
    contentType: "image/png",
    cacheControl: "public, max-age=31536000, immutable",
    upsert: true
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
export async function GET() {
  // Debug-only endpoint (queues jobs for everything). Keep it out of prod.
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const supabase = createServiceSupabaseClient()

  // Find all sheet versions that don't have tiles
  const { data: sheetVersions, error } = await supabase
    .from("drawing_sheet_versions")
    .select("id, org_id")
    .is("tile_manifest", null)
    .not("file_id", "is", null)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!sheetVersions?.length) {
    return NextResponse.json({ message: "No sheets need tiles", queued: 0 })
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
    Format: "webp"
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
    .in("job_type", ["deliver_notification", "generate_drawing_tiles", "refresh_drawing_sheets_list"])
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
      } else if (job.job_type === "generate_drawing_tiles") {
        await generateDrawingTilesJob(supabase, job)
      } else if (job.job_type === "refresh_drawing_sheets_list") {
        await refreshDrawingSheetsListJob(supabase)
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
  const title = typeof nPayload.title === "string" ? nPayload.title : `Strata: ${notification.notification_type}`
  const message = typeof nPayload.message === "string" ? nPayload.message : ""

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.strata.build"
  const href = buildNotificationHref(nPayload)
  const linkHtml = href ? `<p style="margin-top: 16px"><a href="${appUrl}${href}">View in Strata</a></p>` : ""

  await sendEmail({
    to: [user.email],
    subject: title,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; line-height: 1.5">
        <h2 style="margin: 0 0 12px 0">${escapeHtml(title)}</h2>
        <p style="margin: 0 0 12px 0; color: #333">${escapeHtml(message)}</p>
        ${linkHtml}
        <hr style="margin: 20px 0; border: 0; border-top: 1px solid #eee" />
        <p style="margin: 0; color: #777; font-size: 12px">You’re receiving this because notifications are enabled for your Strata account.</p>
      </div>
    `,
  })
}

async function generateDrawingTilesJob(supabase: ReturnType<typeof createServiceSupabaseClient>, job: any) {
  const payload = (job.payload ?? {}) as any
  const sheetVersionId =
    (typeof payload.sheetVersionId === "string" ? payload.sheetVersionId : null) ??
    (typeof payload.sheet_version_id === "string" ? payload.sheet_version_id : null)

  if (!sheetVersionId) {
    throw new Error("Missing sheetVersionId")
  }

  const isDev = process.env.NODE_ENV !== "production"

  if (isDev) {
    // In development, generate tiles locally without edge functions
    await generateDrawingTilesLocally(supabase, sheetVersionId)
  } else {
    // In production, call the edge function
    await generateDrawingTilesViaEdgeFunction(supabase, sheetVersionId)
  }

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

async function generateDrawingTilesViaEdgeFunction(supabase: ReturnType<typeof createServiceSupabaseClient>, sheetVersionId: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  }

  const edgeFunctionUrl = `${supabaseUrl}/functions/v1/generate-drawing-tiles`

  const response = await fetch(edgeFunctionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({ sheetVersionId }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Edge Function failed: ${response.status} ${errorText}`)
  }

  const result = await response.json()
  if (!result.success) {
    throw new Error(`Tile generation failed: ${result.error}`)
  }
}

async function generateDrawingTilesLocally(supabase: ReturnType<typeof createServiceSupabaseClient>, sheetVersionId: string) {
  console.log(`[Local Tile Gen] Processing sheet version ${sheetVersionId}`)

  try {
    // Load sheet version to get org_id
    const { data: version, error: versionError } = await supabase
      .from("drawing_sheet_versions")
      .select("id, org_id")
      .eq("id", sheetVersionId)
      .single()

    if (versionError || !version) {
      throw new Error(`Sheet version not found: ${versionError?.message ?? "unknown error"}`)
    }

    const orgId = version.org_id
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const hash = `dev-${sheetVersionId}`
    const basePath = `${orgId}/${hash}`
    const publicBaseUrl = `${supabaseUrl}/storage/v1/object/public/drawings-tiles/${basePath}`

    // Create a simple SVG placeholder image (works server-side)
    const svgContent = `
      <svg width="2400" height="1800" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#f0f9ff;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#e0f2fe;stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#grad)"/>
        <rect x="20" y="20" width="2360" height="1760" fill="none" stroke="#0ea5e9" stroke-width="10"/>
        <text x="50%" y="45%" text-anchor="middle" font-family="Arial, sans-serif" font-size="72" font-weight="bold" fill="#0ea5e9">TILED VIEWER</text>
        <text x="50%" y="55%" text-anchor="middle" font-family="Arial, sans-serif" font-size="36" fill="#0ea5e9">Development Placeholder</text>
        <text x="50%" y="65%" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" fill="#666">${sheetVersionId}</text>
      </svg>
    `

    // Convert SVG to PNG using a simple approach
    // For simplicity, upload as SVG first, then we'll convert it to PNG later if needed
    const svgBytes = new TextEncoder().encode(svgContent)

    // Upload as single tile (SVG for now, can be converted to PNG/WebP later)
    const tilePath = `${basePath}/tiles/0/0_0.svg`
    const { error: uploadError } = await supabase.storage
      .from("drawings-tiles")
      .upload(tilePath, svgBytes, {
        contentType: "image/svg+xml",
        cacheControl: "public, max-age=31536000, immutable",
        upsert: true,
      })

    if (uploadError && !uploadError.message?.includes("already exists")) {
      throw new Error(`Tile upload failed: ${uploadError.message}`)
    }

    // Create thumbnail (smaller version)
    const thumbSvg = `
      <svg width="256" height="192" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#f0f9ff;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#e0f2fe;stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#grad)"/>
        <rect x="5" y="5" width="246" height="182" fill="none" stroke="#0ea5e9" stroke-width="2"/>
        <text x="50%" y="40%" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" font-weight="bold" fill="#0ea5e9">TILED</text>
        <text x="50%" y="65%" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#0ea5e9">${sheetVersionId.slice(-8)}</text>
      </svg>
    `

    const thumbBytes = new TextEncoder().encode(thumbSvg)
    const thumbPath = `${basePath}/thumbnail.svg`
    await supabase.storage.from("drawings-tiles").upload(thumbPath, thumbBytes, {
      contentType: "image/svg+xml",
      cacheControl: "public, max-age=31536000, immutable",
      upsert: true,
    })

    // Create manifest
    const manifest = {
      Image: {
        xmlns: "http://schemas.microsoft.com/deepzoom/2008",
        Format: "svg",
        Overlap: 0,
        TileSize: 2400, // Single tile covers entire image
        Size: { Width: 2400, Height: 1800 },
      },
    }

    // Update database
    const { error: updateError } = await supabase
      .from("drawing_sheet_versions")
      .update({
        tile_manifest: manifest,
        tile_base_url: publicBaseUrl,
        source_hash: hash,
        tile_levels: 1,
        tiles_generated_at: new Date().toISOString(),
        thumbnail_url: `${publicBaseUrl}/thumbnail.svg`,
        image_width: 2400,
        image_height: 1800,
      })
      .eq("id", sheetVersionId)

    if (updateError) {
      throw new Error(`Failed to update drawing_sheet_versions: ${updateError.message}`)
    }

    console.log(`[Local Tile Gen] Completed for ${sheetVersionId}`)

  } catch (error) {
    console.error(`[Local Tile Gen] Failed for ${sheetVersionId}:`, error)
    throw error
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

function buildPublicBaseUrl(supabaseUrl: string, orgId: string, hash: string) {
  return `${supabaseUrl}/storage/v1/object/public/drawings-tiles/${orgId}/${hash}`
}

function clampCrop(x: number, y: number, w: number, h: number, maxW: number, maxH: number) {
  const x0 = Math.max(0, Math.floor(x))
  const y0 = Math.max(0, Math.floor(y))
  const x1 = Math.min(maxW, Math.ceil(x + w))
  const y1 = Math.min(maxH, Math.ceil(y + h))
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

async function renderPdfFirstPageToPng(pdfBytes: Uint8Array) {
  // Back to PDF.js with better configuration for Node.js
  let pdfjsLib: any
  try {
    pdfjsLib = (await import("pdfjs-dist")) as any
    // Set worker to empty to prevent fake worker setup
    if (pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = ""
    }
  } catch (e: any) {
    throw new Error(`pdfjs-dist import failed: ${e?.message ?? String(e)}`)
  }

  let createCanvas: any
  try {
    ;({ createCanvas } = (await import("@napi-rs/canvas")) as any)
  } catch (e: any) {
    throw new Error(`@napi-rs/canvas import failed: ${e?.message ?? String(e)}`)
  }

  try {
    const loadingTask = pdfjsLib.getDocument({
      data: pdfBytes,
      disableWorker: true,
      disableFontFace: true,
      useSystemFonts: true
    })
    const doc = await loadingTask.promise
    const page = await doc.getPage(1)

    // Use higher scale for better quality
    const scale = 2.5
    const viewport = page.getViewport({ scale })

    const canvasW = Math.max(1, Math.ceil(viewport.width))
    const canvasH = Math.max(1, Math.ceil(viewport.height))
    const canvas = createCanvas(canvasW, canvasH)
    const ctx = canvas.getContext("2d")

    await page.render({
      canvasContext: ctx,
      viewport,
      background: 'white'
    }).promise

    const png = canvas.toBuffer("image/png")

    return { pngBytes: new Uint8Array(png), width: canvasW, height: canvasH }
  } catch (e: any) {
    throw new Error(`PDF.js rendering failed: ${e?.message ?? String(e)}`)
  }
}

async function uploadPublicObject(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  objectPath: string,
  bytes: Uint8Array,
  contentType: string,
) {
  const { error } = await supabase.storage.from("drawings-tiles").upload(objectPath, bytes, {
    contentType,
    cacheControl: "public, max-age=31536000, immutable",
    upsert: false,
  })

  if (!error) return

  const msg = (error as any)?.message?.toLowerCase?.() ?? ""
  if (msg.includes("already exists") || msg.includes("409")) return

  throw new Error(`storage upload failed (${objectPath}): ${(error as any)?.message ?? "unknown error"}`)
}

async function generateDrawingTilesInNode(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  sheetVersionId: string,
) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!supabaseUrl) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL")

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SUPABASE_FUNCTION_TIMEOUT_MS)

  try {
    // 1) Load minimal metadata (avoid join-multiplicity issues that break .single()).
    const { data: version, error: versionError } = await supabase
      .from("drawing_sheet_versions")
      .select("id, org_id, file_id")
      .eq("id", sheetVersionId)
      .maybeSingle()

    if (versionError || !version) {
      throw new Error(`Sheet version not found: ${versionError?.message ?? "unknown error"}`)
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
    const { data: pdfFile, error: downloadError } = await supabase.storage
      .from("project-files")
      .download(file.storage_path, { signal: controller.signal as any })

    if (downloadError || !pdfFile) {
      throw new Error(`Failed to download PDF: ${downloadError?.message ?? "unknown error"}`)
    }

    const pdfBytes = new Uint8Array(await pdfFile.arrayBuffer())
    const hash = sha256Hex(pdfBytes).slice(0, 16)

    // 3) Render page to PNG once
    const { pngBytes, width, height } = await renderPdfFirstPageToPng(pdfBytes)

    // 4) Compute levels
    const maxDim = Math.max(width, height)
    const computedLevels = Math.ceil(Math.log2(maxDim / TILE_SIZE)) + 1
    const numLevels = Math.max(1, Math.min(MAX_LEVELS, computedLevels))

    // 5) Content-addressed base path
    const basePath = `${orgId}/${hash}`
    const publicBaseUrl = buildPublicBaseUrl(supabaseUrl, orgId, hash)

    // 6) Tile pyramid generation (webp)
    let createCanvas: any
    let loadImage: any
    try {
      ;({ createCanvas, loadImage } = (await import("@napi-rs/canvas")) as any)
    } catch (e: any) {
      throw new Error(`@napi-rs/canvas import failed: ${e?.message ?? String(e)}`)
    }

    let img: any
    try {
      img = await loadImage(Buffer.from(pngBytes))
    } catch (e: any) {
      throw new Error(`loadImage failed: ${e?.message ?? String(e)}`)
    }

    for (let level = 0; level < numLevels; level++) {
      const scale = Math.pow(2, level - (numLevels - 1)) // last level = 1.0
      const levelW = Math.max(1, Math.round(width * scale))
      const levelH = Math.max(1, Math.round(height * scale))

      const levelCanvas = createCanvas(levelW, levelH)
      const levelCtx = levelCanvas.getContext("2d")
      levelCtx.drawImage(img, 0, 0, levelW, levelH)
      const cols = Math.ceil(levelW / TILE_SIZE)
      const rows = Math.ceil(levelH / TILE_SIZE)

      for (let col = 0; col < cols; col++) {
        for (let row = 0; row < rows; row++) {
          const rawX = col * TILE_SIZE - OVERLAP
          const rawY = row * TILE_SIZE - OVERLAP
          const rawW = TILE_SIZE + OVERLAP * 2
          const rawH = TILE_SIZE + OVERLAP * 2

          const crop = clampCrop(rawX, rawY, rawW, rawH, levelW, levelH)
          if (crop.w <= 0 || crop.h <= 0) continue

          const tileCanvas = createCanvas(crop.w, crop.h)
          const tileCtx = tileCanvas.getContext("2d")
          tileCtx.drawImage(levelCanvas, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h)
          const webp = tileCanvas.toBuffer("image/webp", { quality: WEBP_QUALITY }) as Buffer

          const objectPath = `${basePath}/tiles/${level}/${col}_${row}.webp`
          await uploadPublicObject(supabase, objectPath, new Uint8Array(webp), "image/webp")
        }
      }
    }

    // 7) Thumbnail (256px max)
    const thumbMax = 256
    const thumbScale = thumbMax / Math.max(width, height)
    const thumbW = Math.max(1, Math.round(width * thumbScale))
    const thumbH = Math.max(1, Math.round(height * thumbScale))

    const thumbCanvas = createCanvas(thumbW, thumbH)
    const thumbCtx = thumbCanvas.getContext("2d")
    thumbCtx.drawImage(img, 0, 0, thumbW, thumbH)
    const thumbWebp = thumbCanvas.toBuffer("image/webp", { quality: 80 }) as Buffer

    await uploadPublicObject(supabase, `${basePath}/thumbnail.webp`, new Uint8Array(thumbWebp), "image/webp")

    const manifest: TileManifest = {
      Image: {
        xmlns: "http://schemas.microsoft.com/deepzoom/2008",
        Format: "webp",
        Overlap: OVERLAP,
        TileSize: TILE_SIZE,
        Size: { Width: width, Height: height },
      },
    }

    await uploadPublicObject(
      supabase,
      `${basePath}/manifest.json`,
      new TextEncoder().encode(JSON.stringify(manifest)),
      "application/json",
    )

    // 8) Persist metadata
    const { error: updateError } = await supabase
      .from("drawing_sheet_versions")
      .update({
        tile_manifest: manifest,
        tile_base_url: publicBaseUrl,
        source_hash: hash,
        tile_levels: numLevels,
        tiles_generated_at: new Date().toISOString(),
        thumbnail_url: `${publicBaseUrl}/thumbnail.webp`,
        image_width: width,
        image_height: height,
        tiles_base_path: basePath,
      })
      .eq("id", sheetVersionId)

    if (updateError) {
      throw new Error(`Failed to update drawing_sheet_versions: ${updateError.message}`)
    }
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
