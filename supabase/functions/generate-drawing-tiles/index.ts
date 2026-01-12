import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { Image } from "https://deno.land/x/imagescript@1.2.15/mod.ts"

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

type RequestBody = {
  sheetVersionId: string
}

function hexFromBytes(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input)
  return hexFromBytes(digest)
}

function buildPublicBaseUrl(supabaseUrl: string, orgId: string, hash: string) {
  return `${supabaseUrl}/storage/v1/object/public/drawings-tiles/${orgId}/${hash}`
}

function clampCrop(
  x: number,
  y: number,
  w: number,
  h: number,
  maxW: number,
  maxH: number
) {
  const x0 = Math.max(0, x)
  const y0 = Math.max(0, y)
  const x1 = Math.min(maxW, x + w)
  const y1 = Math.min(maxH, y + h)
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

async function renderSinglePagePng(pdfBytes: Uint8Array): Promise<Uint8Array> {
  // pdf-to-img is already used elsewhere in this repo's edge functions.
  const pdfToImg = await import("https://esm.sh/pdf-to-img@4.2.0")
  const doc = await pdfToImg.pdf(pdfBytes, { scale: 4.0 })

  for await (const page of doc) {
    return page as Uint8Array
  }

  throw new Error("No pages found in PDF")
}

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const body = (await req.json()) as Partial<RequestBody>
    const sheetVersionId = typeof body.sheetVersionId === "string" ? body.sheetVersionId : null
    if (!sheetVersionId) {
      return new Response(JSON.stringify({ success: false, error: "Missing sheetVersionId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")
    if (!supabaseUrl || !anonKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY")
    }

    // IMPORTANT:
    // Supabase Edge Functions do not reliably expose the service role key via env.
    // Instead, rely on the inbound Authorization header:
    // - `supabase.functions.invoke()` forwards the caller's JWT
    // - Our outbox worker uses a service-role client, so the JWT has role=service_role
    const authHeader = req.headers.get("authorization")
    if (!authHeader) {
      return new Response(JSON.stringify({ success: false, error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    const supabase = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          authorization: authHeader,
        },
      },
    })

    // Load sheet version and storage path for the single-page PDF
    const { data: version, error: versionError } = await supabase
      .from("drawing_sheet_versions")
      .select(
        `
        id,
        org_id,
        tile_manifest,
        tile_base_url,
        thumbnail_url,
        drawing_sheet:drawing_sheets!drawing_sheet_versions_drawing_sheet_id_fkey(project_id),
        files:files!drawing_sheet_versions_file_id_fkey(storage_path)
      `
      )
      .eq("id", sheetVersionId)
      .single()

    if (versionError || !version) {
      throw new Error(`Sheet version not found: ${versionError?.message ?? "unknown error"}`)
    }

    // Idempotency: if tiles already exist, don't regenerate (avoids storage "already exists" errors).
    if ((version as any).tile_manifest && (version as any).tile_base_url) {
      return new Response(
        JSON.stringify({
          success: true,
          skipped: true,
          reason: "tiles_already_generated",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    const orgId = (version as any).org_id as string
    const storagePath = (version as any).files?.storage_path as string | undefined
    if (!storagePath) {
      throw new Error("Sheet version missing files.storage_path")
    }

    // Download the single-page PDF
    const { data: pdfFile, error: downloadError } = await supabase.storage
      .from("project-files")
      .download(storagePath)

    if (downloadError || !pdfFile) {
      throw new Error(`Failed to download PDF: ${downloadError?.message ?? "unknown error"}`)
    }

    const pdfBytes = new Uint8Array(await pdfFile.arrayBuffer())

    // Content-addressed hash (shortened)
    const hash = (await sha256Hex(pdfBytes)).slice(0, 16)

    // Render to a high-res PNG, decode to an image
    const pngBytes = await renderSinglePagePng(pdfBytes)
    const baseImage = await Image.decode(pngBytes)

    const width = baseImage.width
    const height = baseImage.height
    const maxDim = Math.max(width, height)
    const computedLevels = Math.ceil(Math.log2(maxDim / TILE_SIZE)) + 1
    const numLevels = Math.max(1, Math.min(MAX_LEVELS, computedLevels))

    const basePath = `${orgId}/${hash}`
    const publicBaseUrl = buildPublicBaseUrl(supabaseUrl, orgId, hash)

    // Generate tiles level-by-level
    for (let level = 0; level < numLevels; level++) {
      const scale = Math.pow(2, level - (numLevels - 1)) // last level = 1.0
      const levelW = Math.max(1, Math.round(width * scale))
      const levelH = Math.max(1, Math.round(height * scale))

      const levelImg = scale === 1 ? baseImage : baseImage.resize(levelW, levelH)
      const cols = Math.ceil(levelImg.width / TILE_SIZE)
      const rows = Math.ceil(levelImg.height / TILE_SIZE)

      for (let col = 0; col < cols; col++) {
        for (let row = 0; row < rows; row++) {
          const rawX = col * TILE_SIZE - OVERLAP
          const rawY = row * TILE_SIZE - OVERLAP
          const rawW = TILE_SIZE + OVERLAP * 2
          const rawH = TILE_SIZE + OVERLAP * 2

          const crop = clampCrop(rawX, rawY, rawW, rawH, levelImg.width, levelImg.height)
          if (crop.w === 0 || crop.h === 0) continue

          const tileImg = levelImg.crop(crop.x, crop.y, crop.w, crop.h)
          const webp = await tileImg.encodeWEBP(WEBP_QUALITY)

          const objectPath = `${basePath}/tiles/${level}/${col}_${row}.webp`
          const { error: uploadError } = await supabase.storage
            .from("drawings-tiles")
            .upload(objectPath, webp, {
              contentType: "image/webp",
              cacheControl: "public, max-age=31536000, immutable",
              upsert: false,
            })

          // Ignore duplicates (same content hash) across sheets/projects
          if (uploadError && uploadError.message?.toLowerCase?.().includes("already exists") !== true) {
            throw new Error(`Tile upload failed (${objectPath}): ${uploadError.message}`)
          }
        }
      }
    }

    // Thumbnail (256px max dimension)
    const thumbMax = 256
    const thumbScale = thumbMax / Math.max(width, height)
    const thumbW = Math.max(1, Math.round(width * thumbScale))
    const thumbH = Math.max(1, Math.round(height * thumbScale))
    const thumbImg = baseImage.resize(thumbW, thumbH)
    const thumbWebp = await thumbImg.encodeWEBP(80)

    const thumbPath = `${basePath}/thumbnail.webp`
    {
      const { error: thumbUploadError } = await supabase.storage.from("drawings-tiles").upload(thumbPath, thumbWebp, {
        contentType: "image/webp",
        cacheControl: "public, max-age=31536000, immutable",
        upsert: false,
      })
      if (
        thumbUploadError &&
        thumbUploadError.message?.toLowerCase?.().includes("already exists") !== true
      ) {
        throw new Error(`Thumbnail upload failed (${thumbPath}): ${thumbUploadError.message}`)
      }
    }

    const manifest: TileManifest = {
      Image: {
        xmlns: "http://schemas.microsoft.com/deepzoom/2008",
        Format: "webp",
        Overlap: OVERLAP,
        TileSize: TILE_SIZE,
        Size: {
          Width: width,
          Height: height,
        },
      },
    }

    // Store manifest in DB (primary) + optional copy in storage for debugging
    {
      const manifestPath = `${basePath}/manifest.json`
      const { error: manifestUploadError } = await supabase.storage
        .from("drawings-tiles")
        .upload(manifestPath, new TextEncoder().encode(JSON.stringify(manifest)), {
          contentType: "application/json",
          cacheControl: "public, max-age=31536000, immutable",
          upsert: false,
        })

      if (
        manifestUploadError &&
        manifestUploadError.message?.toLowerCase?.().includes("already exists") !== true
      ) {
        throw new Error(`Manifest upload failed (${manifestPath}): ${manifestUploadError.message}`)
      }
    }

    const { error: updateError } = await supabase
      .from("drawing_sheet_versions")
      .update({
        tile_manifest: manifest,
        tile_base_url: publicBaseUrl,
        source_hash: hash,
        tile_levels: numLevels,
        tiles_generated_at: new Date().toISOString(),
        // Keep list thumbnails stable/public
        thumbnail_url: `${publicBaseUrl}/thumbnail.webp`,
        image_width: width,
        image_height: height,
        // Back-compat canonical path fields used by some app code
        tiles_base_path: basePath,
      })
      .eq("id", sheetVersionId)

    if (updateError) {
      throw new Error(`Failed to update drawing_sheet_versions: ${updateError.message}`)
    }

    return new Response(JSON.stringify({ success: true, levels: numLevels, width, height }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  } catch (error) {
    console.error("[generate-drawing-tiles] Failed:", error)
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})

