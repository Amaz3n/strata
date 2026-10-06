import type { TextRun } from "./text-runs";
import type { AreaRegion } from "./area-takeoff";
import type { PdfRasterSampling } from "./pdf-raster-sampling";
import { validPdfRasterSampling } from "./pdf-raster-sampling";

export const RASTER_TEXT_PROFILE = "local-tesseract-7-eng-2";
export const RASTER_TEXT_MIN_CONFIDENCE = 70;
export interface RasterTextEvidence {
  profile: typeof RASTER_TEXT_PROFILE;
  /** Processing status, not a statement that every source word was read. */
  status: "processed" | "partial" | "unavailable";
  runs: TextRun[];
  windows: number;
  warnings: string[];
  source?:
    | { kind: "stored-tiles" }
    | { kind: "original-pdf"; hash: string; sampling: PdfRasterSampling };
}

/** Windows at full stored-image resolution overlap so seam text has another full
 * observation. The window boundary never becomes architectural geometry. */
export function rasterTextWindows(
  width: number,
  height: number,
  region: AreaRegion,
): AreaRegion[] {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    ![region.x0, region.y0, region.x1, region.y1].every(Number.isFinite) ||
    region.x0 < 0 ||
    region.y0 < 0 ||
    region.x1 > 1 ||
    region.y1 > 1 ||
    region.x1 <= region.x0 ||
    region.y1 <= region.y0
  )
    throw new Error("Invalid raster text frame");
  const axis = (lo: number, hi: number, size: number) => {
    const start = Math.floor(lo * size),
      end = Math.ceil(hi * size),
      spans: number[][] = [];
    for (let at = start; at < end; ) {
      const stop = Math.min(end, at + 2048);
      spans.push([at / size, stop / size]);
      if (stop === end) break;
      at = stop - 96;
    }
    return spans;
  };
  const xs = axis(region.x0, region.x1, width),
    ys = axis(region.y0, region.y1, height);
  if (
    xs.length * ys.length > 64 ||
    xs.reduce((n, [a, b]) => n + (b - a) * width, 0) *
      ys.reduce((n, [a, b]) => n + (b - a) * height, 0) >
      100_000_000
  )
    throw new Error(
      "Native scan text exceeds the processing budget. Select a smaller plan view.",
    );
  return ys.flatMap(([y0, y1]) => xs.map(([x0, x1]) => ({ x0, y0, x1, y1 })));
}

/** OCR boxes are measured in the actual rendered crop, never its requested
 * frame. Low-confidence, partial-edge and invalid observations remain absent;
 * no character substitution or dimension guessing is performed. */
export function rasterTextRuns(
  lines: unknown,
  width: number,
  height: number,
  region: AreaRegion,
): TextRun[] {
  if (
    !Array.isArray(lines) ||
    lines.length > 4000 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    ![region.x0, region.y0, region.x1, region.y1].every(Number.isFinite) ||
    region.x1 <= region.x0 ||
    region.y1 <= region.y0
  )
    throw new Error("Invalid OCR output frame");
  return lines.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const line = raw as {
      text?: unknown;
      confidence?: unknown;
      bbox?: { x0: number; y0: number; x1: number; y1: number };
    };
    const box = line.bbox,
      confidence = line.confidence;
    if (
      typeof line.text !== "string" ||
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < RASTER_TEXT_MIN_CONFIDENCE ||
      confidence > 100 ||
      !box ||
      ![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) ||
      box.x0 < 1 ||
      box.y0 < 1 ||
      box.x1 >= width - 1 ||
      box.y1 >= height - 1 ||
      box.x1 <= box.x0 ||
      box.y1 <= box.y0
    )
      return [];
    const text = line.text.replace(/\s+/g, " ").trim();
    if (!text || text.length > 120 || !/[\p{L}\p{N}]/u.test(text)) return [];
    return [
      {
        text,
        x: region.x0 + (box.x0 / width) * (region.x1 - region.x0),
        y: region.y0 + (box.y0 / height) * (region.y1 - region.y0),
        w: ((box.x1 - box.x0) / width) * (region.x1 - region.x0),
        h: ((box.y1 - box.y0) / height) * (region.y1 - region.y0),
        ocr: { profile: RASTER_TEXT_PROFILE, confidence },
      },
    ];
  });
}

/** Original positioned PDF text wins any overlapping OCR observation. Across
 * overlapping scan windows retain the stronger complete observation, without
 * averaging its coordinates or turning transcription scores into certainty. */
export function mergeArchitecturalTextRuns(
  original: TextRun[],
  extracted: TextRun[],
): TextRun[] {
  const overlaps = (a: TextRun, b: TextRun) =>
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
  const result = [...original];
  if (result.length >= 4000) return result;
  for (const run of [...extracted].sort(
    (a, b) =>
      (b.ocr?.confidence ?? 0) - (a.ocr?.confidence ?? 0) ||
      b.text.length - a.text.length ||
      a.y - b.y ||
      a.x - b.x,
  )) {
    if (!result.some((existing) => overlaps(existing, run))) result.push(run);
    if (result.length >= 4000) break;
  }
  return result;
}

/** OCR transcription is useful source context, but may not change calibrated
 * scale or erase dimension/wall geometry as though it were exact PDF text. */
export const authoritativeDimensionText = (run: TextRun) => !run.ocr;

export function validRasterTextEvidence(
  value: unknown,
): value is RasterTextEvidence {
  if (!value || typeof value !== "object") return false;
  const text = value as RasterTextEvidence;
  return (
    text.profile === RASTER_TEXT_PROFILE &&
    (text.source === undefined ||
      (!!text.source &&
        typeof text.source === "object" &&
        (text.source.kind === "stored-tiles" ||
          (text.source.kind === "original-pdf" &&
            /^[a-f0-9]{64}$/.test(text.source.hash) &&
            validPdfRasterSampling(text.source.sampling))))) &&
    ["processed", "partial", "unavailable"].includes(text.status) &&
    Number.isInteger(text.windows) &&
    text.windows >= 0 &&
    text.windows <= 64 &&
    (text.status !== "processed" || text.windows > 0) &&
    Array.isArray(text.warnings) &&
    text.warnings.length <= 16 &&
    text.warnings.every((w) => typeof w === "string" && w.length <= 500) &&
    Array.isArray(text.runs) &&
    text.runs.length <= 4000 &&
    text.runs.every(
      (r) =>
        r &&
        typeof r.text === "string" &&
        !!r.text.trim() &&
        r.text.length <= 120 &&
        [r.x, r.y, r.w, r.h].every(Number.isFinite) &&
        r.x >= 0 &&
        r.y >= 0 &&
        r.w > 0 &&
        r.h > 0 &&
        r.x + r.w <= 1 + 1e-6 &&
        r.y + r.h <= 1 + 1e-6 &&
        r.ocr?.profile === RASTER_TEXT_PROFILE &&
        Number.isFinite(r.ocr.confidence) &&
        r.ocr.confidence >= RASTER_TEXT_MIN_CONFIDENCE &&
        r.ocr.confidence <= 100,
    )
  );
}
