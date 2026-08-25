/**
 * Where the pdf.js worker lives, with nothing else in the module.
 *
 * It is split out from `worker.ts` because that file imports `react-pdf` to
 * reach `GlobalWorkerOptions`, and react-pdf plus pdf.js is ~1MB. Anything that
 * only needs the URL — prefetching the worker before a PDF is opened, for
 * instance — imports this instead and stays clear of that graph.
 */
export const PDF_WORKER_SRC = "/pdf.worker.min.mjs"
