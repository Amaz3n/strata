/**
 * Deciding how to turn a PDF into images a vision model can actually read.
 *
 * Pure by design: no mupdf, no sharp, no I/O. Rendering lives in
 * `lib/services/ai/pdf-raster.ts`; everything that can be gotten *wrong* — which
 * pages, at what resolution, and what the user is told when a cap bites — is
 * decided here so it can be tested under `node --test`.
 *
 * The reason any of this exists: Gemini and OpenAI read PDFs natively, but most
 * models reachable through OpenRouter accept images only. Without rasterisation,
 * "pick a different model for extraction" silently means "extract nothing".
 */

/** Pages sent in one call. Past this the payload stops being worth its cost. */
export const DEFAULT_MAX_RASTER_PAGES = 8

/**
 * Long edge, in pixels, of a rendered page. Invoice body text on a Letter page
 * is roughly 10pt; at 1700px long edge that lands near 200 DPI, which is well
 * clear of the ~150 DPI where small print starts dropping characters.
 */
export const DEFAULT_TARGET_LONG_EDGE_PX = 1700

/** Ceiling per page. A pathological page degrades in DPI instead of OOMing. */
export const DEFAULT_MAX_PAGE_PIXELS = 8_000_000

export interface PdfRasterPlan {
  /** Zero-based page indexes to render, in order. */
  pages: number[]
  /** True when the document has more pages than the plan renders. */
  truncated: boolean
  /** Pages the model will never see. Zero when nothing was dropped. */
  omittedPages: number
  /**
   * A line to append to the prompt when pages were dropped. Null otherwise.
   * The model has to know its view is partial, or it will answer as though the
   * total it can see is the whole document.
   */
  disclosure: string | null
}

/**
 * Choose which pages to render.
 *
 * Deliberately the FIRST n pages rather than a sample: on a bill, the header,
 * the totals and the first page of lines are what matter, and a document long
 * enough to be truncated is almost always a stapled statement or an attachment
 * bundle — cases where the tail is not where the money is. Dropping pages is
 * disclosed rather than hidden.
 */
export function planPdfRaster({
  pageCount,
  maxPages = DEFAULT_MAX_RASTER_PAGES,
}: {
  pageCount: number
  maxPages?: number
}): PdfRasterPlan {
  const total = Number.isFinite(pageCount) ? Math.max(0, Math.floor(pageCount)) : 0
  const cap = Math.max(1, Math.floor(maxPages))
  const rendered = Math.min(total, cap)
  const pages = Array.from({ length: rendered }, (_, index) => index)
  const omittedPages = Math.max(0, total - rendered)

  return {
    pages,
    truncated: omittedPages > 0,
    omittedPages,
    disclosure:
      omittedPages > 0
        ? `Only the first ${rendered} of ${total} pages of this document are shown. ` +
          `Extract what is visible, do not assume the remaining ${omittedPages} ` +
          `${omittedPages === 1 ? "page contains" : "pages contain"} nothing, and say so in notes.`
        : null,
  }
}

export interface PageRasterScale {
  /** Render DPI to hand mupdf. */
  dpi: number
  /** True when the pixel ceiling forced a lower DPI than the target. */
  scaledDown: boolean
  /** Resulting pixel dimensions, for logging and for the pixel budget. */
  widthPx: number
  heightPx: number
}

/**
 * Pick a render DPI for one page.
 *
 * PDF user space is 72 units to the inch, so a target long edge in pixels maps
 * straight onto a DPI. The pixel ceiling then claws it back for the occasional
 * D-size sheet that arrives in a payables PDF by mistake — degrading resolution
 * is survivable, running the function out of memory is not.
 */
export function rasterScaleForPage({
  widthPt,
  heightPt,
  targetLongEdgePx = DEFAULT_TARGET_LONG_EDGE_PX,
  maxPixels = DEFAULT_MAX_PAGE_PIXELS,
}: {
  widthPt: number
  heightPt: number
  targetLongEdgePx?: number
  maxPixels?: number
}): PageRasterScale {
  const safeWidthPt = widthPt > 0 && Number.isFinite(widthPt) ? widthPt : 612
  const safeHeightPt = heightPt > 0 && Number.isFinite(heightPt) ? heightPt : 792
  const longEdgePt = Math.max(safeWidthPt, safeHeightPt)

  // Sanity rails first: below ~50 DPI nothing is legible and above 400 we are
  // just burning bytes on a page that was never that detailed.
  let dpi = Math.max(50, Math.min(400, (targetLongEdgePx / longEdgePt) * 72))
  let scaledDown = false

  // The pixel ceiling is applied LAST and wins outright, including over the
  // legibility floor. It is not a preference — it is what stops a D-size sheet
  // that wandered into a payables PDF from taking the function down with it.
  const projected = safeWidthPt * safeHeightPt * (dpi / 72) ** 2
  if (projected > maxPixels) {
    dpi *= Math.sqrt(maxPixels / projected)
    scaledDown = true
  }

  return {
    dpi,
    scaledDown,
    widthPx: Math.max(1, Math.round((safeWidthPt * dpi) / 72)),
    heightPx: Math.max(1, Math.round((safeHeightPt * dpi) / 72)),
  }
}
