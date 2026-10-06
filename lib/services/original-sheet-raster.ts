import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AreaRegion } from "@/lib/drawings/area-takeoff";
import { inspectPdfRasterSampling } from "@/lib/drawings/pdf-raster-sampling";
import { renderPdfRegion } from "@/lib/drawings/pdf-region-raster";
import { downloadDrawingPdfObject } from "@/lib/storage/drawings-pdfs-storage";
import { loadMupdf } from "./mupdf-loader";

/** The source handle is shared across contour and OCR windows, and destroyed by
 * its caller. Downloads use the existing organization-scoped PDF storage path. */
export async function openOriginalSheetRaster(input: {
  supabase: SupabaseClient;
  orgId: string;
  fileId: string;
  pageIndex: number;
  imageWidth: number;
  imageHeight: number;
  region: AreaRegion;
}) {
  if (
    !input.orgId ||
    !input.fileId ||
    !Number.isInteger(input.pageIndex) ||
    input.pageIndex < 0 ||
    !Number.isInteger(input.imageWidth) ||
    !Number.isInteger(input.imageHeight) ||
    input.imageWidth < 2 ||
    input.imageHeight < 2
  )
    throw new Error("Invalid original drawing identity or frame");
  const { data: file, error } = await input.supabase
    .from("files")
    .select("storage_path")
    .eq("org_id", input.orgId)
    .eq("id", input.fileId)
    .maybeSingle();
  if (error) throw error;
  if (!file?.storage_path)
    throw new Error(
      "Original drawing source is unavailable. Reprocess this sheet before recognition.",
    );
  const bytes = await downloadDrawingPdfObject({
    supabase: input.supabase,
    orgId: input.orgId,
    path: file.storage_path,
  });
  if (!bytes.length || bytes.length > 150_000_000)
    throw new Error("Original drawing exceeds the source processing budget.");
  const mupdf = await loadMupdf(),
    doc = mupdf.Document.openDocument(bytes, "application/pdf");
  let page: ReturnType<typeof doc.loadPage> | undefined;
  try {
    if (input.pageIndex >= doc.countPages())
      throw new Error(
        "Original drawing page no longer exists. Reprocess this sheet.",
      );
    page = doc.loadPage(input.pageIndex);
    const [x0, y0, x1, y1] = page.getBounds(),
      width = x1 - x0,
      height = y1 - y0;
    if (
      !(width > 0 && height > 0) ||
      Math.abs(width / height - input.imageWidth / input.imageHeight) >= 0.02
    )
      throw new Error(
        "Original PDF and drawing image frames disagree. Reprocess this sheet before recognition.",
      );
    const sampling = inspectPdfRasterSampling(mupdf, page, input.region);
    const nativeWidth = Math.round(width * sampling.renderScale),
      nativeHeight = Math.round(height * sampling.renderScale);
    if (
      nativeWidth < 2 ||
      nativeHeight < 2 ||
      nativeWidth > 100_000 ||
      nativeHeight > 100_000
    )
      throw new Error(
        "Original drawing sampling exceeds its frame budget. Select a smaller source view.",
      );
    let closed = false;
    const sourcePage = page;
    return {
      sampling,
      sourceHash: createHash("sha256").update(bytes).digest("hex"),
      imageWidth: nativeWidth,
      imageHeight: nativeHeight,
      inspectSampling: (window: AreaRegion) => {
        if (closed) throw new Error("Original drawing source handle is closed");
        return inspectPdfRasterSampling(mupdf, sourcePage, window);
      },
      recognitionWindowBudget: (
        window: AreaRegion,
        maximumDimension = 4096,
      ) => {
        if (closed) throw new Error("Original drawing source handle is closed");
        if (
          !Number.isInteger(maximumDimension) ||
          maximumDimension < 4 ||
          maximumDimension > 8192
        )
          throw new Error("Invalid original recognition image budget");
        const observed = inspectPdfRasterSampling(mupdf, sourcePage, window);
        // Leave sub-pixel arithmetic headroom when normalized bounds are
        // subtracted and multiplied back into pixels. The strict renderer
        // retains its two-pixel rounding reserve and never lowers density.
        const usablePixels=maximumDimension-2-1e-6;
        return {
          x: usablePixels / (width * observed.renderScale),
          y: usablePixels / (height * observed.renderScale),
        };
      },
      renderWindow: async (window: AreaRegion, maximumDimension: number) => {
        if (closed) throw new Error("Original drawing source handle is closed");
        const crop = renderPdfRegion(mupdf, sourcePage, {
          region: window,
          scale: sampling.renderScale,
          maximumDimension,
        });
        return {
          data: Buffer.from(crop.data),
          mediaType: "image/png" as const,
          sourceRegion: crop.region,
          renderScale: crop.scale,
        };
      },
      renderSourceWindow: async (
        window: AreaRegion,
        maximumDimension: number,
      ) => {
        if (closed) throw new Error("Original drawing source handle is closed");
        const observed = inspectPdfRasterSampling(mupdf, sourcePage, window);
        const nativeWidth = Math.round(width * observed.renderScale),
          nativeHeight = Math.round(height * observed.renderScale);
        if (
          Math.max(
            width * (window.x1 - window.x0),
            height * (window.y1 - window.y0),
          ) *
            observed.renderScale >
          maximumDimension - 2
        )
          throw new Error(
            "Source recognition window exceeds its native image budget. Use smaller recognition windows; source density was not reduced.",
          );
        const crop = renderPdfRegion(mupdf, sourcePage, {
          region: window,
          scale: observed.renderScale,
          maximumDimension,
        });
        if (Math.abs(crop.scale - observed.renderScale) > 0.000001)
          throw new Error("Source recognition image density was reduced");
        return {
          data: Buffer.from(crop.data),
          mediaType: "image/png" as const,
          sourceRegion: crop.region,
          renderDpi: crop.scale * 72,
          nativeWidth,
          nativeHeight,
          sampling: observed,
        };
      },
      close: () => {
        if (!closed) {
          closed = true;
          try {
            sourcePage.destroy();
          } finally {
            doc.destroy();
          }
        }
      },
    };
  } catch (error) {
    try {
      page?.destroy();
    } finally {
      doc.destroy();
    }
    throw error;
  }
}
