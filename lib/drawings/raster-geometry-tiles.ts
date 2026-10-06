import type { AreaEvidence, EvidencePath, PathCommand } from "./area-evidence";
import type { AreaRegion } from "./area-takeoff";
import { validRasterContextRegion } from "./raster-context";
import { RASTER_PLAN_PROFILE } from "./raster-plan-evidence";

export const RASTER_GEOMETRY_TILING_PROFILE = "native-plan-windows-2";
export interface RasterGeometryWindow {
  id: number;
  core: AreaRegion;
  window: AreaRegion;
}
export interface RasterGeometryWindowObservation extends RasterGeometryWindow {
  region: AreaRegion;
  width: number;
  height: number;
  threshold: number;
  feetPerPixel: number;
  renderDpi: number;
  evidenceSha256: string;
  pathCount: number;
  complete: boolean;
}
export interface RasterGeometryTiling {
  profile: typeof RASTER_GEOMETRY_TILING_PROFILE;
  requestedRegion: AreaRegion;
  nativeWidth: number;
  nativeHeight: number;
  plannedWindows: number;
  processedWindows: number;
  sampledPixels: number;
  windows: RasterGeometryWindowObservation[];
  /** Header raster dimensions describe a logical sheet frame, not one bitmap. */
  logicalFrame: true;
  status: "complete" | "partial";
  reason?:
    | "window-budget"
    | "pixel-budget"
    | "path-budget"
    | "time-budget"
    | "read-failed"
    | "incomplete-window";
}

/** Native pixel cores partition the request; halos provide independent full
 * observations of architectural symbols near internal seams. Never shrink
 * source sampling to fit a large view into one image. */
export function planNativeRasterGeometry(input: {
  width: number;
  height: number;
  feetPerPixel: number;
  region: AreaRegion;
}) {
  const { width, height, feetPerPixel, region } = input;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > 100000 ||
    height > 100000 ||
    !Number.isFinite(feetPerPixel) ||
    feetPerPixel <= 0 ||
    !validRasterContextRegion(region)
  )
    throw Error("Invalid native geometry frame");
  const padding = Math.ceil(4.5 / feetPerPixel) + 5,
    core = Math.min(2048, 4094 - 2 * padding);
  if (core < 512)
    return {
      windows: [] as RasterGeometryWindow[],
      reason: "window-budget" as const,
    };
  const x0 = Math.floor(region.x0 * width),
    x1 = Math.ceil(region.x1 * width),
    y0 = Math.floor(region.y0 * height),
    y1 = Math.ceil(region.y1 * height);
  const windows: RasterGeometryWindow[] = [];
  let sampledPixels = 0;
  for (let y = y0; y < y1; y += core)
    for (let x = x0; x < x1; x += core) {
      const right = Math.min(x1, x + core),
        bottom = Math.min(y1, y + core),
        left = Math.max(x0, x - padding),
        top = Math.max(y0, y - padding),
        endX = Math.min(x1, right + padding),
        endY = Math.min(y1, bottom + padding);
      sampledPixels += (endX - left + 2) * (endY - top + 2);
      if (windows.length >= 32 || sampledPixels > 128000000)
        return {
          windows: [] as RasterGeometryWindow[],
          reason: (windows.length >= 32
            ? "window-budget"
            : "pixel-budget") as RasterGeometryTiling["reason"],
        };
      const rect = (
        a: number,
        b: number,
        c: number,
        d: number,
      ): AreaRegion => ({
        x0: Math.max(region.x0, a / width),
        y0: Math.max(region.y0, b / height),
        x1: Math.min(region.x1, c / width),
        y1: Math.min(region.y1, d / height),
      });
      windows.push({
        id: windows.length,
        core: rect(x, y, right, bottom),
        window: rect(left, top, endX, endY),
      });
    }
  return { windows, reason: undefined };
}

export function validRasterGeometryTiling(
  value: unknown,
  requested: AreaRegion,
): value is RasterGeometryTiling {
  if (!value || typeof value !== "object") return false;
  const t = value as RasterGeometryTiling;
  if (
    t.profile !== RASTER_GEOMETRY_TILING_PROFILE ||
    !validRasterContextRegion(t.requestedRegion) ||
    !validRasterContextRegion(requested) ||
    ["x0", "y0", "x1", "y1"].some(
      (k) =>
        t.requestedRegion[k as keyof AreaRegion] !==
        requested[k as keyof AreaRegion],
    ) ||
    ![t.nativeWidth, t.nativeHeight].every(
      (n) => Number.isInteger(n) && n >= 2 && n <= 100000,
    ) ||
    !Number.isInteger(t.plannedWindows) ||
    t.plannedWindows < 0 ||
    t.plannedWindows > 32 ||
    !Number.isInteger(t.processedWindows) ||
    t.processedWindows < 0 ||
    t.processedWindows > t.plannedWindows ||
    !Number.isInteger(t.sampledPixels) ||
    t.sampledPixels < 0 ||
    t.sampledPixels > 128000000 ||
    t.logicalFrame !== true ||
    !Array.isArray(t.windows) ||
    t.windows.length !== t.processedWindows ||
    !["complete", "partial"].includes(t.status) ||
    (t.status === "complete" &&
      (t.plannedWindows < 1 ||
        t.reason !== undefined ||
        t.processedWindows !== t.plannedWindows))
  )
    return false;
  if (
    t.sampledPixels !==
      t.windows.reduce((n, w) => n + (w?.width ?? 0) * (w?.height ?? 0), 0) ||
    (t.status === "partial" &&
      ![
        "window-budget",
        "pixel-budget",
        "path-budget",
        "time-budget",
        "read-failed",
        "incomplete-window",
      ].includes(t.reason ?? ""))
  )
    return false;
  if (t.status === "complete") {
    const area = t.windows.reduce(
        (n, w) => n + (w?.core?.x1 - w?.core?.x0) * (w?.core?.y1 - w?.core?.y0),
        0,
      ),
      expected = (requested.x1 - requested.x0) * (requested.y1 - requested.y0);
    if (!Number.isFinite(area) || Math.abs(area - expected) > 1e-10)
      return false;
    for (let i = 0; i < t.windows.length; i++)
      for (let j = i + 1; j < t.windows.length; j++) {
        const a = t.windows[i]?.core,
          b = t.windows[j]?.core;
        if (!a || !b) return false;
        if (
          Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1e-12 &&
          Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1e-12
        )
          return false;
      }
  }
  return t.windows.every(
    (w, i) =>
      !!w &&
      typeof w === "object" &&
      !!w.region &&
      w.id === i &&
      validRasterContextRegion(w.core) &&
      validRasterContextRegion(w.window) &&
      w.core.x0 >= requested.x0 &&
      w.core.y0 >= requested.y0 &&
      w.core.x1 <= requested.x1 &&
      w.core.y1 <= requested.y1 &&
      w.window.x0 <= w.core.x0 &&
      w.window.y0 <= w.core.y0 &&
      w.window.x1 >= w.core.x1 &&
      w.window.y1 >= w.core.y1 &&
      [w.region.x0, w.region.y0, w.region.x1, w.region.y1].every(
        Number.isFinite,
      ) &&
      w.region.x0 >= -2 / t.nativeWidth &&
      w.region.y0 >= -2 / t.nativeHeight &&
      w.region.x1 <= 1 + 2 / t.nativeWidth &&
      w.region.y1 <= 1 + 2 / t.nativeHeight &&
      w.region.x1 > w.region.x0 &&
      w.region.y1 > w.region.y0 &&
      w.region.x0 <= w.window.x0 &&
      w.region.y0 <= w.window.y0 &&
      w.region.x1 >= w.window.x1 &&
      w.region.y1 >= w.window.y1 &&
      [w.width, w.height].every(
        (n) => Number.isInteger(n) && n >= 2 && n <= 4096,
      ) &&
      Number.isInteger(w.threshold) &&
      w.threshold >= 0 &&
      w.threshold <= 255 &&
      Number.isFinite(w.feetPerPixel) &&
      w.feetPerPixel > 0 &&
      Number.isFinite(w.renderDpi) &&
      w.renderDpi > 0 &&
      w.renderDpi <= 600.01 &&
      Math.abs(w.renderDpi - t.windows[0].renderDpi) < 0.01 &&
      Math.abs(w.feetPerPixel / t.windows[0].feetPerPixel - 1) < 0.001 &&
      /^[a-f0-9]{64}$/.test(w.evidenceSha256) &&
      Number.isInteger(w.pathCount) &&
      w.pathCount >= 0 &&
      w.pathCount <= 12000 &&
      typeof w.complete === "boolean" &&
      (t.status !== "complete" || w.complete),
  );
}

/** Keep original source coordinates. Remove artificial crop-edge observations,
 * retaining disconnected actual contour pieces as separate paths. A tile edge
 * never becomes a jamb or wall face merely because outside pixels were absent. */
function observedPieces(
  path: EvidencePath,
  r: NonNullable<AreaEvidence["raster"]>,
): EvidencePath[] {
  const dx = (r.region.x1 - r.region.x0) / r.width,
    dy = (r.region.y1 - r.region.y0) / r.height;
  const artificial = (a: PathCommand, b: PathCommand) => {
    if (!["M", "L"].includes(a[0]) || !["M", "L"].includes(b[0])) return false;
    const near = (v: number | undefined, e: number, d: number) =>
      v !== undefined && Math.abs(v - e) <= d * 0.51;
    return (
      (r.region.x0 > dx &&
        near(a[1], r.region.x0, dx) &&
        near(b[1], r.region.x0, dx)) ||
      (r.region.x1 < 1 - dx &&
        near(a[1], r.region.x1, dx) &&
        near(b[1], r.region.x1, dx)) ||
      (r.region.y0 > dy &&
        near(a[2], r.region.y0, dy) &&
        near(b[2], r.region.y0, dy)) ||
      (r.region.y1 < 1 - dy &&
        near(a[2], r.region.y1, dy) &&
        near(b[2], r.region.y1, dy))
    );
  };
  if (path.rasterFeature === "linework")
    return path.commands.length === 2 &&
      artificial(path.commands[0], path.commands[1])
      ? []
      : [path];
  if (path.rasterFeature !== "paint-boundary") return [path];
  const pieces: EvidencePath[] = [],
    commands: PathCommand[] = [];
  const emit = () => {
    if (commands.length >= 2)
      pieces.push({ ...path, commands: commands.splice(0) });
    else commands.length = 0;
  };
  for (let i = 1; i < path.commands.length; i++) {
    const a = path.commands[i - 1],
      b = path.commands[i];
    if (b[0] === "M" || b[0] === "Z" || a[0] === "Z" || artificial(a, b)) {
      emit();
      continue;
    }
    if (!commands.length && (a[0] === "M" || a[0] === "L"))
      commands.push(["M", a[1], a[2]]);
    if (b[0] === "L" || b[0] === "C") commands.push(b);
  }
  emit();
  return pieces;
}

export function mergeNativeRasterGeometry(input: {
  region: AreaRegion;
  width: number;
  height: number;
  feetPerPixel: number;
  observations: Array<{
    window: RasterGeometryWindow;
    evidence: AreaEvidence;
    sha256: string;
    renderDpi: number;
  }>;
  plannedWindows: number;
  reason?: RasterGeometryTiling["reason"];
}): AreaEvidence {
  const paths: EvidencePath[] = [],
    pairs: NonNullable<AreaEvidence["rasterPairPaint"]> = [],
    windows: RasterGeometryWindowObservation[] = [];
  const lookup = new Map<string, number>();
  let incomplete = !!input.reason,
    pixels = 0;
  // Exact primitive duplicates only. The key tolerates sub-millionth-pixel
  // floating arithmetic; coordinates are never snapped, averaged or extended.
  const key = (p: EvidencePath) =>
    JSON.stringify([
      p.rasterFeature,
      p.kind,
      p.commands.map((c) =>
        c.map((v, i) =>
          i && typeof v === "number"
            ? (v * (i % 2 ? input.width : input.height)).toFixed(6)
            : v,
        ),
      ),
      p.colorSpace,
      p.color,
      p.opacity,
      p.width,
      p.dashes,
      p.layer,
      p.clips,
    ]);
  for (const observation of input.observations) {
    const e = observation.evidence,
      r = e.raster;
    if (!r) throw Error("Native geometry window lacks a source frame");
    const ids = new Map<number, number[]>();
    pixels += r.width * r.height;
    windows.push({
      ...observation.window,
      ...r,
      region: r.region,
      evidenceSha256: observation.sha256,
      pathCount: e.paths.length,
      complete: !e.truncated,
      renderDpi: observation.renderDpi,
    });
    incomplete ||= e.truncated;
    for (const original of e.paths) {
      const mapped: number[] = [];
      for (const p of observedPieces(original, r)) {
        const signature = key(p),
          existing = lookup.get(signature);
        if (existing !== undefined) {
          const keep = paths[existing];
          if (keep.rasterArc?.clipped && p.rasterArc?.clipped === false) {
            keep.rasterArc = p.rasterArc;
            keep.rasterWindowIds = [
              observation.window.id,
              ...(keep.rasterWindowIds ?? []),
            ];
          }
          keep.rasterWindowIds = [
            ...new Set([
              ...(keep.rasterWindowIds ?? []),
              observation.window.id,
            ]),
          ];
          mapped.push(existing);
          continue;
        }
        if (paths.length >= 24000) {
          incomplete = true;
          continue;
        }
        const id = paths.length;
        paths.push({ ...p, id, rasterWindowIds: [observation.window.id] });
        lookup.set(signature, id);
        mapped.push(id);
      }
      ids.set(original.id, mapped);
    }
    for (const pair of e.rasterPairPaint ?? []) {
      const a = ids.get(pair.pathIds[0]),
        b = ids.get(pair.pathIds[1]);
      if (a?.length === 1 && b?.length === 1 && a[0] !== b[0])
        pairs.push({ ...pair, pathIds: [a[0], b[0]] });
    }
  }
  const tiling: RasterGeometryTiling = {
    profile: RASTER_GEOMETRY_TILING_PROFILE,
    requestedRegion: input.region,
    nativeWidth: input.width,
    nativeHeight: input.height,
    plannedWindows: input.plannedWindows,
    processedWindows: windows.length,
    sampledPixels: pixels,
    windows,
    logicalFrame: true,
    status:
      incomplete || windows.length !== input.plannedWindows
        ? "partial"
        : "complete",
    ...(incomplete || windows.length !== input.plannedWindows
      ? {
          reason:
            input.reason ??
            (paths.length >= 24000 ? "path-budget" : "incomplete-window"),
        }
      : {}),
  };
  return {
    version: 1,
    extractionProfile: RASTER_PLAN_PROFILE,
    paths,
    rasterPairPaint: pairs,
    truncated: tiling.status !== "complete",
    raster: {
      width: Math.ceil((input.region.x1 - input.region.x0) * input.width),
      height: Math.ceil((input.region.y1 - input.region.y0) * input.height),
      feetPerPixel: Math.max(
        input.feetPerPixel,
        ...windows.map((w) => w.feetPerPixel),
      ),
      threshold: windows[0]?.threshold ?? 0,
      maximumDeviationPixels: 2.5,
      region: input.region,
      tiling,
    },
  };
}
