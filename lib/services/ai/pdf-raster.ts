import "server-only"

import {
  planPdfRaster,
  rasterScaleForPage,
  type PdfRasterPlan,
} from "@/lib/ai/pdf-raster-plan"
import { loadMupdf } from "@/lib/services/mupdf-loader"

/**
 * Turn a PDF into page images for models that cannot read PDFs.
 *
 * Same mupdf + sharp pair the drawings pipeline already runs on — a PDF page is
 * a PDF page whether it carries a floor plan or a lumber invoice, and a second
 * rasteriser would just be a second set of bugs. What is decided here is only
 * the I/O; every judgement call (which pages, what DPI, what the model is told
 * when pages are dropped) lives in the pure plan module.
 *
 * WebP, not PNG: a rendered invoice page is mostly white, and lossy WebP at
 * quality 85 is roughly a fifth the bytes with no visible loss on printed text.
 * Payload size is the binding constraint on multi-page documents.
 */

export interface RasterizedPdf {
  images: Array<{ data: Buffer; mediaType: string; filename: string }>
  /** Pages in the source document, not pages rendered. */
  pageCount: number
  plan: PdfRasterPlan
}

async function loadSharp() {
  const sharpModule = await import("sharp")
  return sharpModule.default
}

export async function rasterizePdfToImages(
  bytes: Buffer,
  options: {
    maxPages?: number
    targetLongEdgePx?: number
    /** Used in the generated filenames so a model can refer to "page 2". */
    label?: string
  } = {},
): Promise<RasterizedPdf | null> {
  const mupdf = await loadMupdf()
  const sharp = await loadSharp()
  const label = options.label ?? "page"

  let doc: ReturnType<typeof mupdf.Document.openDocument> | null = null
  try {
    doc = mupdf.Document.openDocument(bytes, "application/pdf")
  } catch {
    // An unopenable PDF is not a rasterisation problem — hand it back so the
    // caller can send the original bytes and let the provider say why.
    return null
  }

  try {
    const pageCount = doc.countPages()
    if (!(pageCount > 0)) return null

    const plan = planPdfRaster({ pageCount, maxPages: options.maxPages })
    const images: RasterizedPdf["images"] = []

    for (const pageIndex of plan.pages) {
      const page = doc.loadPage(pageIndex)
      try {
        let widthPt = 612
        let heightPt = 792
        try {
          const bounds = page.getBounds()
          widthPt = Math.abs(bounds[2] - bounds[0])
          heightPt = Math.abs(bounds[3] - bounds[1])
        } catch {
          // Unreadable bounds: US Letter is the right guess for a bill.
        }

        const scale = rasterScaleForPage({
          widthPt,
          heightPt,
          targetLongEdgePx: options.targetLongEdgePx,
        })

        const pixmap = page.toPixmap(
          mupdf.Matrix.scale(scale.dpi / 72, scale.dpi / 72),
          mupdf.ColorSpace.DeviceRGB,
          false,
          true,
        )
        try {
          const webp = await sharp(Buffer.from(pixmap.asPNG())).webp({ quality: 85 }).toBuffer()
          images.push({
            data: webp,
            mediaType: "image/webp",
            filename: `${label}-${pageIndex + 1}.webp`,
          })
        } finally {
          pixmap.destroy?.()
        }
      } finally {
        // mupdf objects are WASM-heap backed; a dropped reference is a leak that
        // survives GC, and a 40-page bundle leaks 40 of them.
        ;(page as { destroy?: () => void }).destroy?.()
      }
    }

    if (images.length === 0) return null
    return { images, pageCount, plan }
  } finally {
    ;(doc as { destroy?: () => void } | null)?.destroy?.()
  }
}
