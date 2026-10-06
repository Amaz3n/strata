import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AreaEvidence } from "@/lib/drawings/area-evidence";
import {
  extractRasterPlanEvidence as extractRasterEvidence,
  RASTER_PLAN_PROFILE as RASTER_EXTRACTION_PROFILE,
} from "@/lib/drawings/raster-plan-evidence";
import {
  downloadTilesObject,
  uploadTilesObject,
} from "@/lib/storage/drawings-tiles-storage";
import { renderSheetWindowImage } from "./drawings-sheet-images";
import {
  RASTER_TEXT_PROFILE,
  validRasterTextEvidence,
} from "@/lib/drawings/raster-text";
import { loadLocalRasterText } from "./local-raster-text";
import { openOriginalSheetRaster } from "./original-sheet-raster";
import {
  type PdfRasterSampling,
  PDF_RASTER_SAMPLING_PROFILE,
  validPdfRasterSampling,
} from "@/lib/drawings/pdf-raster-sampling";
import {
  RASTER_CONTEXT_PROFILE,
  planRasterContext,
  validRasterContext,
  validRasterContextRegion,
  type RasterContextEvidence,
} from "@/lib/drawings/raster-context";

import {
  RASTER_GEOMETRY_TILING_PROFILE,
  planNativeRasterGeometry,
  mergeNativeRasterGeometry,
  validRasterGeometryTiling,
  type RasterGeometryWindow,
  type RasterGeometryTiling,
} from "@/lib/drawings/raster-geometry-tiles";

export async function loadRasterArchitecturalEvidence(input: {
  supabase: SupabaseClient;
  tilesBasePath: string;
  imageWidth: number;
  imageHeight: number;
  feetPerImagePx: number;
  region?: { x0: number; y0: number; x1: number; y1: number };
  source?: { orgId: string; fileId: string; pageIndex: number };
}): Promise<{ evidence: AreaEvidence; bytes: Buffer }> {
  const region = input.region ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
  if (!validRasterContextRegion(region))
    throw new Error("Invalid scan source selection");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        RASTER_EXTRACTION_PROFILE,
        RASTER_TEXT_PROFILE,
        PDF_RASTER_SAMPLING_PROFILE,
        RASTER_CONTEXT_PROFILE,
        RASTER_GEOMETRY_TILING_PROFILE,
        input.source ?? null,
        input.imageWidth,
        input.imageHeight,
        input.feetPerImagePx,
        region,
      ]),
    )
    .digest("hex");
  const path = `${input.tilesBasePath}/architecture/raster-${fingerprint}.json`;
  try {
    const bytes = await downloadTilesObject({ supabase: input.supabase, path }),
      evidence: AreaEvidence = JSON.parse(bytes.toString("utf8"));
    if (
      evidence.extractionProfile === RASTER_EXTRACTION_PROFILE &&
      !evidence.truncated &&
      validRasterTextEvidence(evidence.rasterText) &&
      evidence.rasterText.status === "processed" &&
      (!input.source ||
        (evidence.rasterText.source?.kind === "original-pdf" &&
          evidence.rasterText.source.hash === evidence.raster?.sourceHash &&
          validPdfRasterSampling(evidence.raster?.sourceSampling))) &&
      evidence.raster &&
      validRasterContext(
        evidence.raster.context,
        region,
        evidence.raster.region,
      ) &&
      evidence.raster.context.status !== "unresolved" &&
      (!evidence.raster.tiling ||
        (validRasterGeometryTiling(evidence.raster.tiling, region) &&
          evidence.raster.tiling.status === "complete")) &&
      Array.isArray(evidence.paths)
    )
      return { evidence, bytes };
  } catch {
    /* Raster artifacts are reproducible derivatives of this sheet. */
  }
  const original = input.source
    ? await openOriginalSheetRaster({ ...input, ...input.source, region })
    : undefined;
  try {
    const sharp = (await import("sharp")).default;
    const readRegion = async (window: typeof region) => {
      const image = original
        ? await original.renderWindow(window, 4096)
        : await renderSheetWindowImage({
            ...input,
            window,
            maxEdge: 4096,
            requireComplete: true,
            lossless: true,
          });
      if (!image)
        throw new Error(
          "The complete scan region could not be read. Retry when all drawing tiles are available.",
        );
      const { data, info } = await sharp(image.data)
        .flatten({ background: "#ffffff" })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const evidence = extractRasterEvidence({
        pixels: data,
        width: info.width,
        height: info.height,
        feetPerPixel:
          (input.imageWidth *
            (image.sourceRegion.x1 - image.sourceRegion.x0) *
            input.feetPerImagePx) /
          info.width,
        region: image.sourceRegion,
      });
      if (original && evidence.raster) {
        evidence.raster.sourceSampling = original.sampling;
        evidence.raster.sourceHash = original.sourceHash;
        evidence.raster.renderDpi =
          image && "renderScale" in image ? image.renderScale * 72 : undefined;
      }
      return evidence;
    };
    let evidence: AreaEvidence;
    const nativeWidth = original?.imageWidth ?? input.imageWidth,
      nativeHeight = original?.imageHeight ?? input.imageHeight;
    if (
      original &&
      Math.max(
        nativeWidth * (region.x1 - region.x0),
        nativeHeight * (region.y1 - region.y0),
      ) > 4094
    ) {
      const fpp = (input.imageWidth * input.feetPerImagePx) / nativeWidth,
        planned = planNativeRasterGeometry({
          width: nativeWidth,
          height: nativeHeight,
          feetPerPixel: fpp,
          region,
        });
      const observations: Array<{
        window: RasterGeometryWindow;
        evidence: AreaEvidence;
        sha256: string;
        renderDpi: number;
      }> = [];
      let reason: RasterGeometryTiling["reason"] = planned.reason,
        retainedPaths = 0,
        retainedCommands = 0;
      const deadline = Date.now() + 120000;
      for (const window of planned.windows) {
        if (Date.now() > deadline) {
          reason = "time-budget";
          break;
        }
        try {
          const e = await readRegion(window.window);
          if (
            !e.raster?.renderDpi ||
            Math.abs(e.raster.renderDpi - original.sampling.renderScale * 72) >
              0.01
          ) {
            reason = "incomplete-window";
            break;
          }
          retainedPaths += e.paths.length;
          retainedCommands += e.paths.reduce(
            (n, p) => n + p.commands.length,
            0,
          );
          if (retainedPaths > 64000 || retainedCommands > 1000000) {
            reason = "path-budget";
            break;
          }
          observations.push({
            window,
            evidence: e,
            sha256: createHash("sha256")
              .update(JSON.stringify(e))
              .digest("hex"),
            renderDpi: e.raster.renderDpi,
          });
          if (e.truncated) {
            reason = "incomplete-window";
            break;
          }
        } catch {
          reason = "read-failed";
          break;
        }
      }
      evidence = mergeNativeRasterGeometry({
        region,
        width: nativeWidth,
        height: nativeHeight,
        feetPerPixel: fpp,
        observations,
        plannedWindows: planned.windows.length,
        reason,
      });
      evidence.raster!.sourceSampling = original.sampling;
      evidence.raster!.sourceHash = original.sourceHash;
      evidence.raster!.renderDpi = original.sampling.renderScale * 72;
    } else evidence = await readRegion(region);
    const initial = evidence;
    const context: RasterContextEvidence = {
      profile: RASTER_CONTEXT_PROFILE,
      requestedRegion: region,
      initialRegion: initial.raster!.region,
      effectiveRegion: initial.raster!.region,
      initialEvidenceSha256: createHash("sha256")
        .update(JSON.stringify(initial))
        .digest("hex"),
      triggerPathIds: [],
      edges: [],
      attempts: 0,
      status: "unchanged",
    };
    const planned = planRasterContext({ ...input, evidence });
    if (planned.pathIds.length) {
      context.triggerPathIds = planned.pathIds;
      context.edges = planned.edges;
      context.status = "unresolved";
      context.reason = planned.reason;
      if (planned.region) {
        let sampling: PdfRasterSampling | undefined;
        let inspectionFailed = false;
        try {
          sampling = original?.inspectSampling(planned.region);
        } catch {
          inspectionFailed = true;
        }
        // Reading outside the selection cannot inherit a native-density claim
        // that was only verified for the initial view. Preserve observed detail.
        if (inspectionFailed) {
          context.reason = "read-failed";
        } else if (
          original &&
          (!sampling ||
            sampling.kind !== "native-raster" ||
            original.sampling.kind !== "native-raster" ||
            sampling.minimumSourceDpi! <
              original.sampling.minimumSourceDpi! - 0.01 ||
            Math.abs(sampling.renderScale - original.sampling.renderScale) >
              1e-6)
        ) {
          context.reason = "source-unverified";
        } else {
          context.attempts = 1;
          try {
            const expanded = await readRegion(planned.region);
            if (
              expanded.truncated ||
              expanded.raster!.feetPerPixel >
                initial.raster!.feetPerPixel * 1.001
            ) {
              context.reason = "geometry-budget";
            } else {
              evidence = expanded;
              if (sampling) evidence.raster!.sourceSampling = sampling;
              context.effectiveRegion = expanded.raster!.region;
              if (
                planRasterContext({ ...input, evidence: expanded }).pathIds
                  .length
              ) {
                context.reason = "remaining-clipping";
              } else {
                context.status = "expanded";
                delete context.reason;
              }
            }
          } catch {
            context.reason = "read-failed";
          }
        }
      }
    }
    evidence.raster!.context = context;
    evidence.rasterText = await loadLocalRasterText({
      ...input,
      region,
      original,
    });
    if (evidence.raster?.tiling)
      evidence.rasterText.warnings.push(
        evidence.raster.tiling.status === "complete"
          ? "Geometry was sampled in overlapping source-resolution windows. The raster header is a logical sheet frame; per-window pixel frames and source hashes remain explicit. Tile seams are not architectural boundaries."
          : `Source-resolution geometry acquisition is incomplete (${evidence.raster.tiling.reason}). Missing windows or primitives were not inferred; select a smaller plan view or retry acquisition.`,
      );
    if (context.status !== "unchanged")
      evidence.rasterText.warnings.push(
        context.status === "expanded"
          ? "Clipped swing ink triggered one bounded source-context read. Geometry remains in the original sheet frame; the requested model selection is unchanged. Expanded context is source evidence, not verified door recognition."
          : `Clipped swing context remains unresolved (${context.reason}). No missing geometry was guessed. Select a smaller or broader source view and inspect the leaf, jambs and wall host.`,
      );
    if (evidence.truncated)
      evidence.rasterText.warnings.push(
        "Scan primitive extraction reached its source budget. Some geometry is unrepresented; select a smaller plan view before approving reconstruction.",
      );
    if (
      original &&
      evidence.raster?.renderDpi &&
      evidence.raster.renderDpi < original.sampling.renderScale * 72 - 0.01
    )
      evidence.rasterText.warnings.push(
        `Scan contours were reduced to ${Math.round(evidence.raster.renderDpi)} rendered DPI by the view budget. Original detail is preserved separately for text; select a smaller plan view for detailed geometry.`,
      );
    const bytes = Buffer.from(JSON.stringify(evidence));
    if (
      evidence.rasterText.status !== "processed" ||
      evidence.truncated ||
      context.status === "unresolved"
    )
      return { evidence, bytes };
    await uploadTilesObject({
      supabase: input.supabase,
      path,
      bytes,
      contentType: "application/json",
    });
    return { evidence, bytes };
  } finally {
    original?.close();
  }
}
