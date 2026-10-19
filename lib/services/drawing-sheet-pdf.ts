import "server-only"

import type { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadDrawingPdfObject } from "@/lib/storage/drawings-pdfs-storage"

/**
 * One sheet as a one-page PDF. Sheets are stored as pages of the full uploaded
 * set, so the page is extracted here: handing out the source file would leak
 * every sheet in the set, including the ones not shared.
 */
export async function extractDrawingSheetPdf({
  supabase,
  orgId,
  sheet,
}: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  sheet: { id: string; sheet_number: string | null; current_revision_id: string | null }
}): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  if (!sheet.current_revision_id) return null
  const { data: version } = await supabase
    .from("drawing_sheet_versions")
    .select("file_id, page_index, files!drawing_sheet_versions_file_id_fkey(storage_path)")
    .eq("drawing_sheet_id", sheet.id)
    .eq("drawing_revision_id", sheet.current_revision_id)
    .maybeSingle()
  const file = version?.files as { storage_path?: string } | { storage_path?: string }[] | null | undefined
  const storagePath = Array.isArray(file) ? file[0]?.storage_path : file?.storage_path
  if (!storagePath) return null

  const pdfBytes = await downloadDrawingPdfObject({ supabase, orgId, path: storagePath })
  const mupdf = await import("mupdf")
  const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf")
  if (!(doc instanceof mupdf.PDFDocument)) throw new Error("The plan set is not a PDF.")
  const pageIndex = Math.min(Math.max(0, version?.page_index ?? 0), Math.max(0, doc.countPages() - 1))
  const single = new mupdf.PDFDocument()
  single.graftPage(0, doc, pageIndex)
  return {
    bytes: single.saveToBuffer("compress").asUint8Array(),
    fileName: `${sheet.sheet_number || "sheet"}.pdf`.replace(/[^\w.-]+/g, "-"),
  }
}
