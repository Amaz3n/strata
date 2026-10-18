import type * as MuPDF from "mupdf";
import type { AreaRegion } from "./area-takeoff";

export const PDF_RASTER_SAMPLING_PROFILE = "pdf-native-density-1";
export interface PdfRasterSampling {
  profile: typeof PDF_RASTER_SAMPLING_PROFILE;
  kind: "native-raster" | "unverified";
  minimumSourceDpi: number | null;
  maximumSourceDpi: number | null;
  renderScale: number;
  warnings: string[];
}
export interface PdfImageObservation {
  width: number;
  height: number;
  matrix: readonly number[];
  opaqueUnclipped: boolean;
}

export function validPdfRasterSampling(
  value: unknown,
): value is PdfRasterSampling {
  if (!value || typeof value !== "object") return false;
  const sample = value as PdfRasterSampling;
  return (
    sample.profile === PDF_RASTER_SAMPLING_PROFILE &&
    ["native-raster", "unverified"].includes(sample.kind) &&
    Number.isFinite(sample.renderScale) &&
    sample.renderScale > 0 &&
    sample.renderScale <= 600 / 72 &&
    Array.isArray(sample.warnings) &&
    sample.warnings.length <= 16 &&
    sample.warnings.every((w) => typeof w === "string" && w.length <= 500) &&
    (sample.kind === "unverified"
      ? sample.minimumSourceDpi === null && sample.maximumSourceDpi === null
      : Number.isFinite(sample.minimumSourceDpi) &&
        Number.isFinite(sample.maximumSourceDpi) &&
        sample.minimumSourceDpi! > 0 &&
        sample.maximumSourceDpi! >= sample.minimumSourceDpi!)
  );
}

/** Measure original pixel footprints, including rotation/shear. Rendering more
 * pixels cannot upgrade this density. A single verified image must cover every
 * requested corner; a collection of thumbnails does not establish scan quality. */
export function assessPdfRasterSampling(
  bounds: readonly number[],
  region: AreaRegion,
  images: readonly PdfImageObservation[],
): PdfRasterSampling {
  const [ox, oy, ex, ey] = bounds,
    width = ex - ox,
    height = ey - oy;
  if (
    bounds.length !== 4 ||
    !bounds.every(Number.isFinite) ||
    !(width > 0 && height > 0) ||
    ![region.x0, region.y0, region.x1, region.y1].every(Number.isFinite) ||
    region.x0 < 0 ||
    region.y0 < 0 ||
    region.x1 > 1 ||
    region.y1 > 1 ||
    region.x1 <= region.x0 ||
    region.y1 <= region.y0 ||
    images.length > 4096
  )
    throw new Error("Invalid original scan frame");
  const corners = [
    [region.x0, region.y0],
    [region.x1, region.y0],
    [region.x1, region.y1],
    [region.x0, region.y1],
  ].map(([x, y]) => [ox + x * width, oy + y * height]);
  const covering: { low: number; high: number }[] = [];
  let intersectingUnverified = false;
  for (const image of images) {
    const m = image.matrix;
    if (
      !Number.isInteger(image.width) ||
      !Number.isInteger(image.height) ||
      image.width < 1 ||
      image.height < 1 ||
      m.length !== 6 ||
      !m.every(Number.isFinite)
    ) {
      intersectingUnverified = true;
      continue;
    }
    const [a, b, c, d, tx, ty] = m,
      determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
      intersectingUnverified = true;
      continue;
    }
    const quad = [
      [tx, ty],
      [tx + a, ty + b],
      [tx + a + c, ty + b + d],
      [tx + c, ty + d],
    ];
    const box = {
      x0: Math.min(...quad.map((p) => p[0])),
      x1: Math.max(...quad.map((p) => p[0])),
      y0: Math.min(...quad.map((p) => p[1])),
      y1: Math.max(...quad.map((p) => p[1])),
    };
    const view = {
      x0: corners[0][0],
      y0: corners[0][1],
      x1: corners[2][0],
      y1: corners[2][1],
    };
    if (
      box.x1 <= view.x0 ||
      box.x0 >= view.x1 ||
      box.y1 <= view.y0 ||
      box.y0 >= view.y1
    )
      continue;
    const covers = corners.every(([x, y]) => {
      const u = ((x - tx) * d - (y - ty) * c) / determinant,
        v = ((y - ty) * a - (x - tx) * b) / determinant;
      return u >= -1e-8 && u <= 1 + 1e-8 && v >= -1e-8 && v <= 1 + 1e-8;
    });
    if (!image.opaqueUnclipped || !covers) {
      intersectingUnverified = true;
      continue;
    }
    const ax = a / image.width,
      ay = b / image.width,
      bx = c / image.height,
      by = d / image.height;
    const xx = ax * ax + ay * ay,
      yy = bx * bx + by * by,
      xy = ax * bx + ay * by;
    const largest = Math.sqrt((xx + yy + Math.hypot(xx - yy, 2 * xy)) / 2);
    // Determinant avoids cancellation for the smaller singular value.
    const smallest = Math.abs(ax * by - ay * bx) / largest;
    const low = 72 / largest,
      high = 72 / smallest;
    if (!(low > 0 && high >= low) || ![low, high].every(Number.isFinite)) {
      intersectingUnverified = true;
      continue;
    }
    covering.push({ low, high });
  }
  // Overlaid/mixed images can conceal a coarser source. Do not cherry-pick its
  // highest DPI or sum image widths to manufacture coverage.
  const verified = covering.length === 1 && !intersectingUnverified;
  const source = verified ? covering[0] : null;
  const warnings: string[] = [];
  if (!source)
    warnings.push(
      "Original PDF raster density is unverified for this view (mixed, partial, clipped or absent images). Rendered DPI does not establish native detail.",
    );
  if (source && source.low < 200 - 1e-3)
    warnings.push(
      "Original scan detail is below 200 effective DPI. Reliable reconstruction is not qualified for this source.",
    );
  if (source && source.high / source.low > 1.02)
    warnings.push(
      "Original scan pixels have unequal physical spacing or shear. The renderer uses the lower effective density; verify source dimensions.",
    );
  if (source && source.low > 600)
    warnings.push(
      "Original scan sampling exceeds the 600 DPI processing limit. Recognition uses reduced sampling and preserves the original density separately.",
    );
  return {
    profile: PDF_RASTER_SAMPLING_PROFILE,
    kind: source ? "native-raster" : "unverified",
    minimumSourceDpi: source?.low ?? null,
    maximumSourceDpi: source?.high ?? null,
    renderScale: Math.min(source?.low ?? 200, 600) / 72,
    warnings,
  };
}

/** Inspect paint state without allocating an entire page raster. Conservative
 * clipping/mask/group handling leaves uncertain sources explicitly unverified. */
export function inspectPdfRasterSampling(
  mupdf: typeof MuPDF,
  page: MuPDF.Page,
  region: AreaRegion,
): PdfRasterSampling {
  const images: PdfImageObservation[] = [],
    clips: boolean[] = [],
    groups: boolean[] = [];
  let masks = 0,
    tiles = 0,
    exhausted = false;
  const clipped = () => clips.push(true);
  const device = new mupdf.Device({
    clipPath: clipped,
    clipStrokePath: clipped,
    clipText: clipped,
    clipStrokeText: clipped,
    clipImageMask: clipped,
    popClip: () => {
      clips.pop();
    },
    beginMask: () => {
      masks++;
    },
    endMask: () => {
      masks = Math.max(0, masks - 1);
      clips.push(true);
    },
    beginGroup: (_bounds, _space, _isolated, knockout, blend, alpha) => {
      groups.push(knockout || blend !== "Normal" || alpha !== 1);
    },
    endGroup: () => {
      groups.pop();
    },
    beginTile: () => {
      tiles++;
      return 0;
    },
    endTile: () => {
      tiles = Math.max(0, tiles - 1);
    },
    fillImage: (image, matrix, alpha) => {
      if (images.length >= 4096) {
        exhausted = true;
        return;
      }
      images.push({
        width: image.getWidth(),
        height: image.getHeight(),
        matrix: [...matrix],
        opaqueUnclipped:
          alpha === 1 &&
          !clips.length &&
          !masks &&
          !tiles &&
          !groups.some(Boolean),
      });
    },
    fillImageMask: (image, matrix) => {
      if (images.length >= 4096) {
        exhausted = true;
        return;
      }
      images.push({
        width: image.getWidth(),
        height: image.getHeight(),
        matrix: [...matrix],
        opaqueUnclipped: false,
      });
    },
  });
  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    device.destroy();
  }
  if (exhausted)
    return {
      profile: PDF_RASTER_SAMPLING_PROFILE,
      kind: "unverified",
      minimumSourceDpi: null,
      maximumSourceDpi: null,
      renderScale: 200 / 72,
      warnings: [
        "Original image inspection exceeded its observation budget. Native scan density remains unverified.",
      ],
    };
  return assessPdfRasterSampling(page.getBounds(), region, images);
}
