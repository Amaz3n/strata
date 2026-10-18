import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AREA_EVIDENCE_FILE,
  AREA_EVIDENCE_VERSION,
  AREA_EXTRACTION_PROFILE,
  hasVectorGeometryInRegion,
  type AreaEvidence,
} from "@/lib/drawings/area-evidence";
import {
  downloadTilesObject,
  uploadTilesObject,
} from "@/lib/storage/drawings-tiles-storage";

/** Both consumers refresh the same immutable PDF evidence. Older drawings do
 * not silently route model generation through a different legacy interpreter. */
async function loadVectorEvidence(input: {
  supabase: SupabaseClient;
  orgId: string;
  version: {
    tiles_base_path: string | null;
    file_id?: string | null;
    page_index?: number | null;
  };
  imageSize: { width: number; height: number };
}): Promise<{ evidence: AreaEvidence | null; bytes: Buffer | null }> {
  const { supabase, orgId, version, imageSize } = input;
  if (!version.tiles_base_path) return { evidence: null, bytes: null };
  const path = `${version.tiles_base_path}/${AREA_EVIDENCE_FILE}`;
  const stored = await downloadTilesObject({ supabase, path }).catch(
    () => null,
  );
  if (stored) {
    try {
      const evidence: AreaEvidence = JSON.parse(stored.toString("utf8"));
      if (
        evidence.version === AREA_EVIDENCE_VERSION &&
        evidence.extractionProfile === AREA_EXTRACTION_PROFILE &&
        Array.isArray(evidence.paths)
      )
        return { evidence, bytes: stored };
    } catch {
      /* Re-extract corrupt derived data from the source PDF. */
    }
  }
  if (!version.file_id) return { evidence: null, bytes: null };
  const { data: file, error } = await supabase
    .from("files")
    .select("storage_path")
    .eq("org_id", orgId)
    .eq("id", version.file_id)
    .maybeSingle();
  if (error) throw error;
  if (!file?.storage_path) return { evidence: null, bytes: null };
  const [{ downloadDrawingPdfObject }, { loadMupdf }, { extractAreaEvidence }] =
    await Promise.all([
      import("@/lib/storage/drawings-pdfs-storage"),
      import("./mupdf-loader"),
      import("./area-evidence-extract"),
    ]);
  const pdf = await downloadDrawingPdfObject({
    supabase,
    orgId,
    path: file.storage_path,
  });
  const mupdf = await loadMupdf(),
    doc = mupdf.Document.openDocument(pdf, "application/pdf");
  try {
    const page = doc.loadPage(version.page_index ?? 0);
    try {
      const [x0, y0, x1, y1] = page.getBounds(),
        width = x1 - x0,
        height = y1 - y0;
      if (
        !(width > 0 && height > 0) ||
        Math.abs(width / height - imageSize.width / imageSize.height) >= 0.02
      )
        throw new Error(
          "Drawing geometry and image coordinates disagree. Reprocess this sheet before recognition.",
        );
      const evidence = extractAreaEvidence(mupdf, page, {
        pageOriginX: x0,
        pageOriginY: y0,
        pageToImageScale: imageSize.width / width,
        imageWidth: imageSize.width,
        imageHeight: imageSize.height,
      });
      const bytes = Buffer.from(JSON.stringify(evidence));
      await uploadTilesObject({
        supabase,
        path,
        bytes,
        contentType: "application/json",
      });
      return { evidence, bytes };
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

/** Calibrated scans acquire measured pixel contours before either consumer runs. */
export async function loadArchitecturalEvidence(
  input: Parameters<typeof loadVectorEvidence>[0] & {
    feetPerImagePx?: number;
    region?: { x0: number; y0: number; x1: number; y1: number };
  },
): Promise<{ evidence: AreaEvidence | null; bytes: Buffer | null }> {
  const source = await loadVectorEvidence(input);
  if (
    hasVectorGeometryInRegion(source.evidence, input.region) ||
    !input.feetPerImagePx ||
    !input.version.tiles_base_path
  )
    return source;
  const { loadRasterArchitecturalEvidence } =
    await import("./architectural-raster");
  return loadRasterArchitecturalEvidence({
    supabase: input.supabase,
    tilesBasePath: input.version.tiles_base_path,
    imageWidth: input.imageSize.width,
    imageHeight: input.imageSize.height,
    feetPerImagePx: input.feetPerImagePx,
    region: input.region,
    source: input.version.file_id ? { orgId: input.orgId, fileId: input.version.file_id, pageIndex: input.version.page_index ?? 0 } : undefined,
  });
}
