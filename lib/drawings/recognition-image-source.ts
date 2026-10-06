import type { AreaRegion } from "./area-takeoff";
import type { PdfRasterSampling } from "./pdf-raster-sampling";
import { validPdfRasterSampling } from "./pdf-raster-sampling";
import { validRasterContextRegion } from "./raster-context";

export const RECOGNITION_IMAGE_SOURCE_PROFILE = "registered-source-image-1";
export interface RecognitionImageSource {
  profile: typeof RECOGNITION_IMAGE_SOURCE_PROFILE;
  kind: "original-pdf" | "display-tiles";
  fileId: string | null;
  pageIndex: number | null;
  sourceHash: string | null;
  evidenceHash: string;
  requestedRegion: AreaRegion;
  sourceRegion: AreaRegion;
  width: number;
  height: number;
  nativeWidth: number;
  nativeHeight: number;
  renderDpi: number | null;
  sampling: PdfRasterSampling | null;
  nativeDensityPreserved: boolean;
  imageSha256: string;
  annotatedSha256: string;
}

/** A high rendered DPI cannot manufacture or preserve finer source samples. */
export function preservesNativeRecognitionDensity(
  sampling: PdfRasterSampling,
  renderDpi: number,
): boolean {
  return (
    sampling.kind === "native-raster" &&
    sampling.minimumSourceDpi! >= 200 &&
    renderDpi >= sampling.maximumSourceDpi! - 0.01
  );
}

export function validRecognitionImageSource(
  value: unknown,
): value is RecognitionImageSource {
  if (!value || typeof value !== "object") return false;
  const s = value as RecognitionImageSource,
    hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (
    s.profile !== RECOGNITION_IMAGE_SOURCE_PROFILE ||
    !["original-pdf", "display-tiles"].includes(s.kind) ||
    !hash(s.evidenceHash) ||
    !hash(s.imageSha256) ||
    !hash(s.annotatedSha256) ||
    !validRasterContextRegion(s.requestedRegion) ||
    !s.sourceRegion ||
    typeof s.sourceRegion !== "object" ||
    ![s.width, s.height].every(
      (n) => Number.isInteger(n) && n >= 2 && n <= 4096,
    ) ||
    ![s.nativeWidth, s.nativeHeight].every(
      (n) => Number.isInteger(n) && n >= 2 && n <= 100000,
    ) ||
    typeof s.nativeDensityPreserved !== "boolean"
  )
    return false;
  const r = s.sourceRegion,
    q = s.requestedRegion;
  if (
    ![r.x0, r.y0, r.x1, r.y1].every(Number.isFinite) ||
    r.x1 <= r.x0 ||
    r.y1 <= r.y0 ||
    r.x0 < -2 / s.nativeWidth ||
    r.y0 < -2 / s.nativeHeight ||
    r.x1 > 1 + 2 / s.nativeWidth ||
    r.y1 > 1 + 2 / s.nativeHeight ||
    r.x0 > q.x0 + 1e-10 ||
    r.y0 > q.y0 + 1e-10 ||
    r.x1 < q.x1 - 1e-10 ||
    r.y1 < q.y1 - 1e-10
  )
    return false;
  if (s.kind === "display-tiles")
    return (
      s.fileId === null &&
      s.pageIndex === null &&
      s.sourceHash === null &&
      s.renderDpi === null &&
      s.sampling === null &&
      !s.nativeDensityPreserved
    );
  return (
    typeof s.fileId === "string" &&
    s.fileId.length > 0 &&
    s.fileId.length <= 200 &&
    Number.isInteger(s.pageIndex) &&
    s.pageIndex! >= 0 &&
    hash(s.sourceHash) &&
    Number.isFinite(s.renderDpi) &&
    s.renderDpi! > 0 &&
    s.renderDpi! <= 600.01 &&
    validPdfRasterSampling(s.sampling) &&
    Math.abs(s.renderDpi! - s.sampling.renderScale * 72) < 0.01 &&
    s.nativeDensityPreserved ===
      preservesNativeRecognitionDensity(s.sampling, s.renderDpi!) &&
    Math.abs((r.x1 - r.x0) * s.nativeWidth - s.width) <= 2 &&
    Math.abs((r.y1 - r.y0) * s.nativeHeight - s.height) <= 2
  );
}
