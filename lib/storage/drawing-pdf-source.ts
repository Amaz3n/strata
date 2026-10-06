/** Native drawing uploads and library PDFs share a file record, but have different R2 prefixes. */
export function drawingPdfSourceKey(path: string): string {
  const normalized = path.replace(/^\//, "");
  const nativeUpload = /^[^/]+\/[^/]+\/drawings\/(uploads|sets)\//.test(normalized);
  return `${nativeUpload ? "drawings-pdfs" : "project-files"}/${normalized}`;
}

/** Older library version uploads can retain a native drawing directory. Resolve the actual object. */
export async function resolveDrawingPdfSourceKey(path: string, exists: (key: string) => Promise<boolean>): Promise<string> {
  const preferred = drawingPdfSourceKey(path);
  if (!preferred.startsWith("drawings-pdfs/")) return preferred;
  if (await exists(preferred)) return preferred;
  return `project-files/${path.replace(/^\//, "")}`;
}
