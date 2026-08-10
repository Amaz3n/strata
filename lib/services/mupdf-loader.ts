import "server-only"

/**
 * The single lazy handle on the MuPDF WASM module.
 *
 * It lives alone in this file rather than inside the drawings pipeline because
 * three unrelated things need to open a PDF — sheet rendering, spec splitting,
 * and rasterising a bill for a model that cannot read PDFs — and importing the
 * whole drawings pipeline to get at one dynamic import pulls a very large module
 * graph into every one of them. Keeping the loader separate also keeps the AI
 * gateway from importing the pipeline that is itself a gateway caller.
 *
 * The import is deferred because the WASM binary is several megabytes: a request
 * that never touches a PDF should never pay for it.
 */

export type MupdfModule = typeof import("mupdf")

let mupdfModulePromise: Promise<MupdfModule> | null = null

export function loadMupdf(): Promise<MupdfModule> {
  if (!mupdfModulePromise) {
    mupdfModulePromise = import("mupdf")
  }
  return mupdfModulePromise
}
