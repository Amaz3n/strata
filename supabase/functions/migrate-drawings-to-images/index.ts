import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1"

const DRAWINGS_BUCKET = "drawings-images"

/**
 * Background migration function to generate images for existing drawing sheets
 *
 * Phase 4 Performance Optimization:
 * - Processes sheets without images in batches
 * - Can be run as a cron job or triggered manually
 * - Graceful error handling - failures don't block other sheets
 * - Progress tracking via console logs
 *
 * Run manually:
 *   curl -X POST https://<project>.supabase.co/functions/v1/migrate-drawings-to-images \
 *     -H "Authorization: Bearer <service_role_key>"
 *
 * Cron setup (optional):
 *   Add to supabase/functions/.cron.yml:
 *   - name: migrate-drawings-to-images
 *     schedule: "star-slash-30 star star star star" (replace star-slash with actual symbols)
 *     function: migrate-drawings-to-images
 */

const BATCH_SIZE = 50 // Process 50 sheets per run
const MAX_RETRIES = 3

interface SheetToMigrate {
  id: string
  drawing_sheet_id: string
  file_id: string
  org_id: string
  page_index: number
  drawing_sheet: {
    project_id: string
    drawing_set_id: string
  }
  files: {
    storage_path: string
  }
}

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  const startTime = Date.now()
  let processed = 0
  let failed = 0
  let skipped = 0

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    )

    // Find sheet versions without images
    const { data: sheetsToMigrate, error: queryError } = await supabase
      .from("drawing_sheet_versions")
      .select(`
        id,
        drawing_sheet_id,
        file_id,
        org_id,
        page_index,
        drawing_sheet:drawing_sheets!drawing_sheet_versions_drawing_sheet_id_fkey(
          project_id,
          drawing_set_id
        ),
        files!drawing_sheet_versions_file_id_fkey(
          storage_path
        )
      `)
      .is("thumbnail_url", null)
      .not("file_id", "is", null)
      .limit(BATCH_SIZE)

    if (queryError) {
      throw new Error(`Failed to query sheets: ${queryError.message}`)
    }

    if (!sheetsToMigrate || sheetsToMigrate.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "No sheets to migrate",
          processed: 0,
          failed: 0,
          skipped: 0,
          duration: Date.now() - startTime,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    console.log(`[Migration] Found ${sheetsToMigrate.length} sheets to process`)

    for (const sheet of sheetsToMigrate as SheetToMigrate[]) {
      try {
        const storagePath = sheet.files?.storage_path
        if (!storagePath) {
          console.log(`[Migration] Sheet ${sheet.id} has no storage path, skipping`)
          skipped++
          continue
        }

        const projectId = sheet.drawing_sheet?.project_id
        const drawingSetId = sheet.drawing_sheet?.drawing_set_id
        if (!projectId || !drawingSetId) {
          console.log(`[Migration] Sheet ${sheet.id} missing project/set info, skipping`)
          skipped++
          continue
        }

        console.log(`[Migration] Processing sheet ${sheet.id}`)

        // Download the PDF
        const { data: pdfData, error: downloadError } = await supabase.storage
          .from("project-files")
          .download(storagePath)

        if (downloadError || !pdfData) {
          console.error(`[Migration] Failed to download PDF for sheet ${sheet.id}:`, downloadError)
          failed++
          continue
        }

        const pdfBytes = new Uint8Array(await pdfData.arrayBuffer())

        // Get page dimensions from PDF
        const pdfDoc = await PDFDocument.load(pdfBytes)
        const pageIndex = sheet.page_index ?? 0
        const page = pdfDoc.getPage(pageIndex)
        const { width: pdfWidth, height: pdfHeight } = page.getSize()

        // Try to generate images
        const images = await tryGenerateImages(
          supabase,
          pdfBytes,
          pageIndex,
          sheet.org_id,
          projectId,
          drawingSetId,
          sheet.id
        )

        if (images.fullPath) {
          // Update the sheet version with image URLs
          const { error: updateError } = await supabase
            .from("drawing_sheet_versions")
            .update({
              thumb_path: images.thumbPath,
              medium_path: images.mediumPath,
              full_path: images.fullPath,
              tile_manifest_path: null,
              tiles_base_path: null,
              thumbnail_url: images.thumbnailUrl,
              medium_url: images.mediumUrl,
              full_url: images.fullUrl,
              image_width: images.width || Math.round(pdfWidth * 3),
              image_height: images.height || Math.round(pdfHeight * 3),
              images_generated_at: new Date().toISOString(),
            })
            .eq("id", sheet.id)

          if (updateError) {
            console.error(`[Migration] Failed to update sheet ${sheet.id}:`, updateError)
            failed++
          } else {
            console.log(`[Migration] Successfully processed sheet ${sheet.id}`)
            processed++
          }
        } else {
          console.log(`[Migration] Image generation not available for sheet ${sheet.id}`)
          skipped++
        }
      } catch (sheetError) {
        console.error(`[Migration] Error processing sheet ${sheet.id}:`, sheetError)
        failed++
      }
    }

    const duration = Date.now() - startTime
    console.log(`[Migration] Complete: ${processed} processed, ${failed} failed, ${skipped} skipped in ${duration}ms`)

    return new Response(
      JSON.stringify({
        success: true,
        message: "Migration batch complete",
        processed,
        failed,
        skipped,
        total: sheetsToMigrate.length,
        duration,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  } catch (error) {
    console.error("[Migration] Fatal error:", error)

    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        processed,
        failed,
        skipped,
        duration: Date.now() - startTime,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    )
  }
})

interface ImageGenerationResult {
  thumbPath: string | null
  mediumPath: string | null
  fullPath: string | null
  thumbnailUrl: string | null
  mediumUrl: string | null
  fullUrl: string | null
  width: number | null
  height: number | null
}

/**
 * Try to generate images from a PDF page
 * This mirrors the logic in process-drawing-set/index.ts
 */
async function tryGenerateImages(
  supabase: ReturnType<typeof createClient>,
  pdfBytes: Uint8Array,
  pageIndex: number,
  orgId: string,
  projectId: string,
  drawingSetId: string,
  sheetVersionId: string
): Promise<ImageGenerationResult> {
  const result: ImageGenerationResult = {
    thumbPath: null,
    mediumPath: null,
    fullPath: null,
    thumbnailUrl: null,
    mediumUrl: null,
    fullUrl: null,
    width: null,
    height: null,
  }

  try {
    // Try to dynamically import pdf-to-img
    const pdfToImg = await import("https://esm.sh/pdf-to-img@4.2.0")

    // Convert PDF page to PNG buffer
    const document = await pdfToImg.pdf(new Uint8Array(pdfBytes), {
      scale: 3.0, // High DPI for quality
    })

    // Get the specific page
    let pageBuffer: Uint8Array | null = null
    let pageNum = 0
    for await (const page of document) {
      if (pageNum === pageIndex) {
        pageBuffer = page
        break
      }
      pageNum++
    }

    if (!pageBuffer) {
      console.log(`[Migration] Page ${pageIndex} not found in PDF`)
      return result
    }

    // Estimate dimensions (full implementation would use sharp)
    result.width = 2400
    result.height = 1800

    const hash = await hashBytes(pageBuffer)
    const basePath = `${orgId}/${projectId}/drawings/${drawingSetId}/${sheetVersionId}/${hash}`

    // Upload the full-size PNG
    const fullPath = `${basePath}/full.png`

    const { error: uploadError } = await supabase.storage
      .from(DRAWINGS_BUCKET)
      .upload(fullPath, pageBuffer, {
        contentType: "image/png",
        cacheControl: "31536000", // 1 year immutable
        upsert: false,
      })

    if (uploadError) {
      console.error(`[Migration] Upload failed:`, uploadError)
      return result
    }

    // Get public URL
    const publicUrl = buildPublicUrl(fullPath)

    // For now, use the same URL for all sizes
    // TODO: Generate actual resized versions using sharp when available
    result.fullPath = fullPath
    result.mediumPath = fullPath
    result.thumbPath = fullPath
    result.fullUrl = publicUrl
    result.mediumUrl = publicUrl
    result.thumbnailUrl = publicUrl

    console.log(`[Migration] Generated images for sheet version ${sheetVersionId}`)
  } catch (error) {
    // Image generation not available in this environment
    console.log(
      `[Migration] Image generation skipped:`,
      error instanceof Error ? error.message : "Unknown error"
    )
  }

  return result
}

async function hashBytes(buffer: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer)
  const hashArray = Array.from(new Uint8Array(digest))
  const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
  return hex.slice(0, 16)
}

function buildPublicUrl(path: string | null): string | null {
  if (!path) return null
  const base = Deno.env.get("SUPABASE_URL")
  if (!base) return null
  const normalized = path.startsWith("/") ? path.slice(1) : path
  return `${base}/storage/v1/object/public/${DRAWINGS_BUCKET}/${encodeURI(normalized)}`
}
