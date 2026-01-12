import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1"

// Discipline patterns for classification
const DISCIPLINE_PATTERNS: Record<string, RegExp[]> = {
  A: [/^A\d/, /ARCH/, /FLOOR\s*PLAN/, /ELEVATION/, /SECTION/, /CEILING/i],
  S: [/^S\d/, /STRUCT/, /FOUNDATION/, /FRAMING/, /BEAM/i],
  M: [/^M\d/, /MECH/, /HVAC/, /DUCT/, /EQUIPMENT/i],
  E: [/^E\d/, /ELEC/, /LIGHTING/, /POWER/, /PANEL/i],
  P: [/^P\d/, /PLUMB/, /PIPING/, /FIXTURE/, /SANITARY/i],
  C: [/^C\d/, /CIVIL/, /SITE/, /GRADING/, /PAVING/i],
  L: [/^L\d/, /LAND/, /LANDSCAPE/, /PLANTING/, /IRRIGATION/i],
  I: [/^I\d/, /^ID\d/, /INTERIOR/, /FINISH/, /MILLWORK/i],
  FP: [/^FP\d/, /FIRE/, /SPRINKLER/, /SUPPRESSION/i],
  G: [/^G\d/, /GENERAL/, /INDEX/, /SYMBOL/, /ABBREVIATION/i],
  T: [/^T\d/, /TITLE/, /COVER/, /^0/, /^00/i],
  SP: [/^SP\d/, /SPEC/, /SCHEDULE/i],
  D: [/^D\d/, /DETAIL/i],
}

// Image generation configuration
const IMAGE_CONFIG = {
  thumbnail: { width: 400, quality: 80 },
  medium: { width: 1200, quality: 85 },
  full: { width: 2400, quality: 90 },
}

interface ProcessingRequest {
  drawingSetId: string
  orgId: string
  projectId: string
  sourceFileId: string
  storagePath: string
  generateImages?: boolean // Optional flag to enable image generation
  generateTiles?: boolean // Optional flag to enable tile generation (Foundation v2)
}

const DRAWINGS_BUCKET = "drawings-images"

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
 * Attempt to generate images from a PDF page
 * This is a best-effort operation - if it fails, we fall back to PDF-only
 *
 * NOTE: Full image generation requires a Node.js environment with sharp/canvas.
 * In Deno edge functions, this may not work. A separate migration function
 * (Phase 4) handles image generation for existing PDFs.
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
    // Try to dynamically import pdf-to-img (may not work in all Deno environments)
    // This is wrapped in a try-catch because esm.sh imports can fail
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
      console.log(`[Image Gen] Page ${pageIndex} not found`)
      return result
    }

    // Try to get image dimensions
    // For now, we'll estimate based on typical drawing sizes
    // Full implementation would use sharp to get actual dimensions
    result.width = 2400 // Estimated
    result.height = 1800 // Estimated (typical 4:3 aspect ratio)

    const hash = await hashBytes(pageBuffer)
    const basePath = `${orgId}/${projectId}/drawings/${drawingSetId}/${sheetVersionId}/${hash}`

    // Upload the full-size PNG (best-effort)
    const fullPath = `${basePath}/full.png`

    const { error: uploadError } = await supabase.storage
      .from(DRAWINGS_BUCKET)
      .upload(fullPath, pageBuffer, {
        contentType: "image/png",
        cacheControl: "31536000", // 1 year immutable
        upsert: false,
      })

    if (uploadError) {
      console.error(`[Image Gen] Upload failed:`, uploadError)
      return result
    }

    // Build public URL
    const publicUrl = buildPublicUrl(fullPath)

    // Use same path for all sizes for now (tiling handled elsewhere)
    result.fullPath = fullPath
    result.mediumPath = fullPath
    result.thumbPath = fullPath
    result.fullUrl = publicUrl
    result.mediumUrl = publicUrl
    result.thumbnailUrl = publicUrl

    console.log(`[Image Gen] Successfully generated images for page ${pageIndex}`)

  } catch (error) {
    // Image generation failed - this is expected in some environments
    // The system will fall back to PDF rendering
    console.log(`[Image Gen] Skipped (not available in this environment):`,
      error instanceof Error ? error.message : "Unknown error")
  }

  return result
}

async function hashBytes(buffer: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer)
  const hashArray = Array.from(new Uint8Array(digest))
  const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
  return hex.slice(0, 16) // short but content-addressed for immutability
}

function buildPublicUrl(path: string | null): string | null {
  if (!path) return null
  const base = Deno.env.get("SUPABASE_URL")
  if (!base) return null
  const normalized = path.startsWith("/") ? path.slice(1) : path
  return `${base}/storage/v1/object/public/${DRAWINGS_BUCKET}/${encodeURI(normalized)}`
}

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  }

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const {
      drawingSetId,
      orgId,
      projectId,
      sourceFileId,
      storagePath,
      generateImages = true, // Enable by default
      generateTiles = true, // Enable by default
    }: ProcessingRequest = await req.json()

    console.log(`Processing drawing set ${drawingSetId}`)

    // Create Supabase client with service role
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    )

    // Download the source PDF
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("project-files")
      .download(storagePath)

    if (downloadError || !fileData) {
      throw new Error(`Failed to download source file: ${downloadError?.message}`)
    }

    // Load the PDF
    const pdfBytes = await fileData.arrayBuffer()
    const pdfDoc = await PDFDocument.load(pdfBytes)
    const totalPages = pdfDoc.getPageCount()

    console.log(`PDF has ${totalPages} pages`)

    // Update total pages in drawing set
    await supabase
      .from("drawing_sets")
      .update({ total_pages: totalPages })
      .eq("id", drawingSetId)

    // Create a default revision for this set
    const { data: revision, error: revisionError } = await supabase
      .from("drawing_revisions")
      .insert({
        org_id: orgId,
        project_id: projectId,
        drawing_set_id: drawingSetId,
        revision_label: "Initial",
        issued_date: new Date().toISOString().split("T")[0],
        notes: "Automatically created during plan set upload",
      })
      .select("id")
      .single()

    if (revisionError || !revision) {
      throw new Error(`Failed to create revision: ${revisionError?.message}`)
    }

    let imagesGenerated = 0
    let imageGenerationAvailable = true // Track if image gen works in this environment

    // Process each page
    for (let i = 0; i < totalPages; i++) {
      const pageNumber = i + 1
      console.log(`Processing page ${pageNumber}/${totalPages}`)

      try {
        // Create a new PDF with just this page
        const singlePageDoc = await PDFDocument.create()
        const [copiedPage] = await singlePageDoc.copyPages(pdfDoc, [i])
        singlePageDoc.addPage(copiedPage)
        const singlePageBytes = await singlePageDoc.save()

        // Get page dimensions from the PDF
        const page = pdfDoc.getPage(i)
        const { width: pdfWidth, height: pdfHeight } = page.getSize()

        // Generate sheet number (will be refined with OCR later)
        const sheetNumber = `Sheet-${String(pageNumber).padStart(3, "0")}`

        // Try to classify discipline from sheet number
        const discipline = classifyDiscipline(sheetNumber)

        // Upload the single page PDF
        const timestamp = Date.now()
        const sheetPath = `${orgId}/${projectId}/drawings/sheets/${drawingSetId}/${timestamp}_page_${pageNumber}.pdf`

        const { error: uploadError } = await supabase.storage
          .from("project-files")
          .upload(sheetPath, singlePageBytes, {
            contentType: "application/pdf",
            upsert: false,
          })

        if (uploadError) {
          console.error(`Failed to upload page ${pageNumber}:`, uploadError)
          continue
        }

        // Create file record for the sheet
        const { data: fileRecord, error: fileError } = await supabase
          .from("files")
          .insert({
            org_id: orgId,
            project_id: projectId,
            file_name: `${sheetNumber}.pdf`,
            storage_path: sheetPath,
            mime_type: "application/pdf",
            size_bytes: singlePageBytes.byteLength,
            visibility: "private",
            category: "plans",
            source: "generated",
          })
          .select("id")
          .single()

        if (fileError || !fileRecord) {
          console.error(`Failed to create file record for page ${pageNumber}:`, fileError)
          continue
        }

        // Create the drawing sheet
        const { data: sheet, error: sheetError } = await supabase
          .from("drawing_sheets")
          .insert({
            org_id: orgId,
            project_id: projectId,
            drawing_set_id: drawingSetId,
            sheet_number: sheetNumber,
            sheet_title: `Page ${pageNumber}`,
            discipline: discipline,
            current_revision_id: revision.id,
            sort_order: pageNumber,
            share_with_clients: false,
            share_with_subs: false,
          })
          .select("id")
          .single()

        if (sheetError || !sheet) {
          console.error(`Failed to create sheet for page ${pageNumber}:`, sheetError)
          continue
        }

        // Create the sheet version first (without image URLs)
        const { data: sheetVersion, error: versionError } = await supabase
          .from("drawing_sheet_versions")
          .insert({
            org_id: orgId,
            drawing_sheet_id: sheet.id,
            drawing_revision_id: revision.id,
            file_id: fileRecord.id,
            page_index: i,
            extracted_metadata: {
              original_page: pageNumber,
              auto_classified: true,
              pdf_width: pdfWidth,
              pdf_height: pdfHeight,
            },
          })
          .select("id")
          .single()

        if (versionError || !sheetVersion) {
          console.error(`Failed to create sheet version for page ${pageNumber}:`, versionError)
          continue
        }

        // Foundation v2: enqueue tile generation as an outbox job (processed by a cron worker)
        if (generateTiles) {
          try {
            await supabase.from("outbox").insert({
              org_id: orgId,
              // Some environments have NOT NULL constraints on these columns; set them defensively.
              // NOTE: outbox.event_id may have an FK to events; leave null to avoid violations.
              event_id: null,
              job_type: "generate_drawing_tiles",
              status: "pending",
              run_at: new Date().toISOString(),
              retry_count: 0,
              last_error: "",
              payload: {
                sheetVersionId: sheetVersion.id,
              },
            })
          } catch (e) {
            console.error(`[Tiles] Failed to enqueue tile job for sheetVersion ${sheetVersion.id}:`, e)
          }
        }

        // Try to generate images (if enabled and available in this environment)
        if (generateImages && imageGenerationAvailable) {
          const images = await tryGenerateImages(
            supabase,
            new Uint8Array(singlePageBytes),
            0, // Always page 0 since this is a single-page PDF
            orgId,
            projectId,
            drawingSetId,
            sheetVersion.id
          )

          // If we got images, update the sheet version
          if (images.fullPath) {
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
                image_width: images.width || Math.round(pdfWidth * 3), // Estimate from PDF
                image_height: images.height || Math.round(pdfHeight * 3),
                images_generated_at: new Date().toISOString(),
              })
              .eq("id", sheetVersion.id)

            if (!updateError) {
              imagesGenerated++
            }
          } else {
            // Image generation not available, skip for remaining pages
            if (i === 0) {
              console.log("[Image Gen] Not available in this environment, falling back to PDF-only")
              imageGenerationAvailable = false
            }
          }
        }

        // Update progress
        await supabase
          .from("drawing_sets")
          .update({ processed_pages: pageNumber })
          .eq("id", drawingSetId)

      } catch (pageError) {
        console.error(`Error processing page ${pageNumber}:`, pageError)
        // Continue with next page
      }
    }

    // Mark processing as complete
    await supabase
      .from("drawing_sets")
      .update({
        status: "ready",
        processed_at: new Date().toISOString(),
        processed_pages: totalPages,
      })
      .eq("id", drawingSetId)

    // Refresh the denormalized sheets list (if present) via outbox job.
    // We enqueue once per set instead of per sheet to avoid expensive refresh storms.
    try {
      await supabase.from("outbox").insert({
        org_id: orgId,
        // NOTE: outbox.event_id may have an FK to events; leave null to avoid violations.
        event_id: null,
        job_type: "refresh_drawing_sheets_list",
        status: "pending",
        run_at: new Date().toISOString(),
        retry_count: 0,
        last_error: "",
        payload: { projectId },
      })
    } catch (e) {
      console.error("[Sheets List] Failed to enqueue refresh job:", e)
    }

    console.log(`Drawing set ${drawingSetId} processing complete`)
    console.log(`Images generated: ${imagesGenerated}/${totalPages}`)

    return new Response(
      JSON.stringify({
        success: true,
        drawingSetId,
        totalPages,
        imagesGenerated,
        message: imagesGenerated > 0
          ? "Processing complete with images"
          : "Processing complete (images pending migration)",
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    )

  } catch (error) {
    console.error("Processing failed:", error)

    // Try to update the drawing set status to failed
    try {
      const body = await (async () => {
        try {
          return await req.clone().json()
        } catch {
          return null
        }
      })()

      if (body?.drawingSetId) {
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        )

        await supabase
          .from("drawing_sets")
          .update({
            status: "failed",
            error_message: error instanceof Error ? error.message : "Unknown error",
          })
          .eq("id", body.drawingSetId)
      }
    } catch (updateError) {
      console.error("Failed to update drawing set status:", updateError)
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    )
  }
})

/**
 * Classify discipline based on sheet number patterns
 */
function classifyDiscipline(sheetNumber: string): string | null {
  const upperSheet = sheetNumber.toUpperCase()

  for (const [discipline, patterns] of Object.entries(DISCIPLINE_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(upperSheet)) {
        return discipline
      }
    }
  }

  return "X" // Unknown/Other
}
