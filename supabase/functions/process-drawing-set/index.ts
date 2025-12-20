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

interface ProcessingRequest {
  drawingSetId: string
  orgId: string
  projectId: string
  sourceFileId: string
  storagePath: string
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

        // Create the sheet version
        const { error: versionError } = await supabase
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
            },
          })

        if (versionError) {
          console.error(`Failed to create sheet version for page ${pageNumber}:`, versionError)
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

    console.log(`Drawing set ${drawingSetId} processing complete`)

    return new Response(
      JSON.stringify({
        success: true,
        drawingSetId,
        totalPages,
        message: "Processing complete",
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
