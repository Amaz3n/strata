import type { AreaEvidence, AreaPoint } from "./area-evidence";
import { evidencePathBounds } from "./area-evidence";
import type { AreaRegion } from "./area-takeoff";
import { visualPathCatalogue } from "./area-semantics";
import { validRasterContextRegion } from "./raster-context";

export interface RecognitionWindowPlan {
  windows: Array<{
    region: AreaRegion;
    pathIds: number[];
    supplemental: boolean;
  }>;
  eligiblePaths: number;
  unassignedPathIds: number[];
  limited: boolean;
  work: number;
}

/** Every catalogue-eligible source path gets a complete view or an explicit
 * unassigned result. Window limits describe pixel capacity, never wall meaning.
 * Source paths/commands/IDs are retained; no clipped replacements are created. */
export function planRecognitionWindows(input: {
  evidence: AreaEvidence;
  region: AreaRegion;
  targets: readonly AreaPoint[];
  sx: number;
  sy: number;
  maximumSpan?: { x: number; y: number };
}): RecognitionWindowPlan {
  if (
    !validRasterContextRegion(input.region) ||
    ![input.sx, input.sy].every((n) => Number.isFinite(n) && n > 0) ||
    (input.maximumSpan &&
      ![input.maximumSpan.x, input.maximumSpan.y].every(
        (n) => Number.isFinite(n) && n > 0,
      ))
  )
    throw Error("Invalid recognition planning frame or source window budget");
  const eligible = visualPathCatalogue(input.evidence, input.region, Infinity);
  const byId = new Map(input.evidence.paths.map((p) => [p.id, p]));
  const indexed = eligible.map((p) => ({
    id: p.id,
    bounds: evidencePathBounds(byId.get(p.id)!)!,
  }));
  const assigned = new Set<number>(),
    visited: AreaRegion[] = [],
    windows: RecognitionWindowPlan["windows"] = [];
  let work = 0,
    limited = false;
  const limits = input.maximumSpan ?? { x: 36 / input.sx, y: 36 / input.sy };
  const fits = (r: AreaRegion) =>
    r.x1 - r.x0 <= limits.x + 1e-12 && r.y1 - r.y0 <= limits.y + 1e-12;
  const admit = (region: AreaRegion, supplemental: boolean) => {
    if (!validRasterContextRegion(region) || !fits(region)) return;
    const pathIds: number[] = [];
    for (const p of indexed) {
      if (++work > 2_000_000) {
        limited = true;
        break;
      }
      if (
        !assigned.has(p.id) &&
        p.bounds.x0 >= region.x0 &&
        p.bounds.y0 >= region.y0 &&
        p.bounds.x1 <= region.x1 &&
        p.bounds.y1 <= region.y1
      )
        pathIds.push(p.id);
    }
    if (!pathIds.length) return;
    pathIds.forEach((id) => assigned.add(id));
    windows.push({ region, pathIds, supplemental });
  };
  const rx = Math.min(18 / input.sx, limits.x / 2),
    ry = Math.min(18 / input.sy, limits.y / 2);
  // Retain first-pass source ordering for stable cache reuse; complete-path
  // admission below repairs holes left by target-centre suppression.
  for (const target of input.targets) {
    if (limited) break;
    if (!target.every(Number.isFinite)) continue;
    if (
      visited.some(
        (r) =>
          target[0] > r.x0 + (r.x1 - r.x0) * 0.2 &&
          target[0] < r.x1 - (r.x1 - r.x0) * 0.2 &&
          target[1] > r.y0 + (r.y1 - r.y0) * 0.2 &&
          target[1] < r.y1 - (r.y1 - r.y0) * 0.2,
      )
    )
      continue;
    const r = {
      x0: Math.max(input.region.x0, target[0] - rx),
      y0: Math.max(input.region.y0, target[1] - ry),
      x1: Math.min(input.region.x1, target[0] + rx),
      y1: Math.min(input.region.y1, target[1] + ry),
    };
    if (!validRasterContextRegion(r) || !fits(r)) continue;
    visited.push(r);
    admit(r, false);
  }
  const axis = (
    lo: number,
    hi: number,
    outerLo: number,
    outerHi: number,
    maximum: number,
    preferred: number,
    margin: number,
  ) => {
    if (hi - lo > maximum + 1e-12) return null;
    const width = Math.min(
      maximum,
      outerHi - outerLo,
      Math.max(preferred, hi - lo + 2 * margin),
    );
    // Place the full original span inside the crop, including view edges. No
    // rounding of source bounds or assumed page-centre alignment is allowed.
    const start = Math.max(
      outerLo,
      Math.min((lo + hi - width) / 2, outerHi - width, lo),
    );
    const end = Math.min(outerHi, Math.max(start + width, hi));
    return end - start <= maximum + 1e-12 && start <= lo && end >= hi
      ? [start, end]
      : null;
  };
  for (const p of indexed) {
    if (limited) break;
    if (assigned.has(p.id)) continue;
    const b = p.bounds;
    const x = axis(
      b.x0,
      b.x1,
      input.region.x0,
      input.region.x1,
      limits.x,
      36 / input.sx,
      0.75 / input.sx,
    );
    const y = axis(
      b.y0,
      b.y1,
      input.region.y0,
      input.region.y1,
      limits.y,
      36 / input.sy,
      0.75 / input.sy,
    );
    if (!x || !y) continue;
    admit({ x0: x[0], x1: x[1], y0: y[0], y1: y[1] }, true);
  }
  return {
    windows,
    eligiblePaths: indexed.length,
    unassignedPathIds: indexed
      .filter((p) => !assigned.has(p.id))
      .map((p) => p.id),
    limited,
    work,
  };
}
