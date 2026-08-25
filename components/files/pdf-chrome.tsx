import { Skeleton } from "@/components/ui/skeleton"

/**
 * The parts of the PDF experience the file viewer's chrome needs to know about
 * — zoom vocabulary, reported status, and the loading skeleton. Kept out of
 * `pdf-viewer.tsx` on purpose: that module pulls in react-pdf and pdf.js, and
 * the viewer shell must be able to describe a PDF without loading either.
 */

/**
 * How the document is sized. `fit-width` and `fit-page` are derived from the
 * viewport on every layout pass; `scale` is an absolute multiple of the page's
 * natural print size (1 = 100%, i.e. one PDF point renders as 1/72in).
 */
export type PdfZoom =
  | { kind: "fit-width" }
  | { kind: "fit-page" }
  | { kind: "scale"; value: number }

export interface PdfViewerStatus {
  state: "loading" | "ready" | "error"
  pageCount: number
  activePage: number
  /** Rendered size relative to the page's natural print size. 1 = 100%. */
  effectiveScale: number
}

export const INITIAL_PDF_STATUS: PdfViewerStatus = {
  state: "loading",
  pageCount: 0,
  activePage: 1,
  effectiveScale: 1,
}

export const MIN_PDF_SCALE = 0.1
export const MAX_PDF_SCALE = 8

export function clampPdfScale(value: number): number {
  return Math.min(MAX_PDF_SCALE, Math.max(MIN_PDF_SCALE, value))
}

export const PDF_THUMB_WIDTH = 88
export const PDF_THUMB_HEIGHT = 112

/** Holds the shape of the real thing: one page, and the page rail beneath it. */
export function PdfSkeleton() {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-start overflow-hidden p-6">
      <Skeleton className="min-h-0 w-full max-w-[820px] flex-1" />
      <div className="mt-4 hidden shrink-0 items-center gap-2 sm:flex">
        {[0, 1, 2, 3, 4, 5].map((slot) => (
          <Skeleton
            key={slot}
            style={{ width: PDF_THUMB_WIDTH, height: PDF_THUMB_HEIGHT }}
          />
        ))}
      </div>
    </div>
  )
}
