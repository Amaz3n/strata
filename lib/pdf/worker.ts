import { pdfjs } from "react-pdf"

import { PDF_WORKER_SRC } from "./worker-src"

/**
 * Point pdf.js at its worker. The one place that configures it.
 *
 * The worker is copied into `public/` and fetched by URL at runtime, which means
 * it must stay reachable without a session: `proxy.ts` allows it through
 * `PUBLIC_FILE_EXTENSIONS`, and dropping `.mjs` from that list answers the
 * request with a sign-in redirect instead. pdf.js then reports the redirect's
 * empty content type as `'' is not a valid JavaScript MIME type` and falls back
 * to a fake worker that fails the same way — an error that names neither the
 * proxy nor the URL, which is why this lives in one place now rather than five.
 *
 * `pdfjs` is taken from react-pdf, not from `pdfjs-dist` directly: pnpm resolves
 * a second copy of pdfjs-dist, and configuring the wrong copy's
 * GlobalWorkerOptions leaves the one actually rendering with an empty workerSrc.
 */
export function configurePdfWorker(): void {
  if (pdfjs.GlobalWorkerOptions.workerSrc === PDF_WORKER_SRC) return
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC
}
