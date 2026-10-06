import type { AreaPoint } from "./area-evidence";
import { segmentIndex } from "./segment-index";

export const WALL_BODY_RECONCILIATION_PROFILE = "measured-body-coverage-1";
export interface MeasuredWallBody {
  /** Physical feet, before projection into takeoff or 3D. */
  a: AreaPoint;
  b: AreaPoint;
  thicknessFt: number;
  pathIds: readonly number[];
  /** Caller must prove the complete body from independent source pairs. */
  independent: boolean;
}
export interface WallBodyFragment {
  sourceIndex: number;
  a: AreaPoint;
  b: AreaPoint;
  thicknessFt: number;
  pathIds: number[];
}
export interface WallBodyReconciliation {
  profile: typeof WALL_BODY_RECONCILIATION_PROFILE;
  bodies: WallBodyFragment[];
  covered: Array<{
    sourceIndex: number;
    by: number[];
    startFt: number;
    endFt: number;
  }>;
  invalidIndices: number[];
  limited: boolean;
  operations: number;
}
const sub = (a: AreaPoint, b: AreaPoint): AreaPoint => [
  a[0] - b[0],
  a[1] - b[1],
];
const dot = (a: AreaPoint, b: AreaPoint) => a[0] * b[0] + a[1] * b[1];
const cross = (a: AreaPoint, b: AreaPoint) => a[0] * b[1] - a[1] * b[0];

/** Subtract only a weaker body's complete cross-section already represented
 * by an independently proven wall body sharing a source face. Mere centerline
 * proximity, partial depth overlap or common paint are insufficient. Source
 * anchors are never changed; all uncovered intervals, including tiny tails and
 * gaps, survive with original depth/provenance. This is body reconciliation,
 * not classification, endpoint extension, room-perimeter extrusion or certainty. */
export function reconcileMeasuredWallBodies(
  input: readonly MeasuredWallBody[],
): WallBodyReconciliation {
  const original = input.map((b, sourceIndex) => ({
    sourceIndex,
    a: [...b.a] as AreaPoint,
    b: [...b.b] as AreaPoint,
    thicknessFt: b.thicknessFt,
    pathIds: [...b.pathIds],
  }));
  const invalidIndices = input.flatMap((b, i) =>
    ![...b.a, ...b.b, b.thicknessFt].every(Number.isFinite) ||
    b.thicknessFt <= 0 ||
    Math.hypot(...sub(b.b, b.a)) <= 1e-8
      ? [i]
      : [],
  );
  const result: WallBodyReconciliation = {
    profile: WALL_BODY_RECONCILIATION_PROFILE,
    bodies: [],
    covered: [],
    invalidIndices,
    limited: false,
    operations: 0,
  };
  // A budget/invalid-input fallback preserves all source geometry. It must be
  // surfaced as unresolved by the caller, never returned as partial success.
  const fallback = () => {
    result.bodies = original;
    result.covered = [];
    return result;
  };
  if (input.length > 12000) {
    result.limited = true;
    return fallback();
  }
  if (invalidIndices.length) return fallback();
  const anchors = input.flatMap((b, index) =>
    b.independent ? [{ ...b, index }] : [],
  );
  if (!anchors.length) return fallback();
  const near = segmentIndex(anchors),
    maxHalf = Math.max(...anchors.map((b) => b.thicknessFt / 2));
  for (const [sourceIndex, body] of input.entries()) {
    if (body.independent) {
      result.bodies.push(original[sourceIndex]);
      continue;
    }
    const axis = sub(body.b, body.a),
      length = Math.hypot(...axis),
      u: AreaPoint = [axis[0] / length, axis[1] / length],
      n: AreaPoint = [-u[1], u[0]],
      half = body.thicknessFt / 2;
    const point = (t: number): AreaPoint => [
      body.a[0] + u[0] * t,
      body.a[1] + u[1] * t,
    ];
    const coverage: Array<{ lo: number; hi: number; by: number[] }> = [];
    for (const j of near(body, half + maxHalf)) {
      if (++result.operations > 2_000_000) {
        result.limited = true;
        return fallback();
      }
      const anchor = anchors[j],
        other = sub(anchor.b, anchor.a),
        otherLength = Math.hypot(...other),
        au: AreaPoint = [other[0] / otherLength, other[1] / otherLength],
        an: AreaPoint = [-au[1], au[0]];
      if (
        Math.abs(cross(u, au)) > 0.002 ||
        !body.pathIds.some((id) => anchor.pathIds.includes(id))
      )
        continue;
      let lo = 0,
        hi = length;
      // A slice's ENTIRE width must fit in the source rectangle. Project both
      // width corners analytically; sample-point overlap cannot prove coverage.
      for (const [basis, min, max] of [
        [au, 0, otherLength],
        [an, -anchor.thicknessFt / 2, anchor.thicknessFt / 2],
      ] as Array<[AreaPoint, number, number]>) {
        const base = dot(sub(body.a, anchor.a), basis),
          slope = dot(u, basis),
          margin = Math.abs(dot(n, basis)) * half;
        const low = min + margin,
          high = max - margin;
        if (low > high + 1e-8) {
          hi = lo;
          break;
        }
        if (Math.abs(slope) < 1e-10) {
          if (base < low - 1e-8 || base > high + 1e-8) {
            hi = lo;
            break;
          }
        } else {
          const bounds = [(low - base) / slope, (high - base) / slope].sort(
            (a, b) => a - b,
          );
          lo = Math.max(lo, bounds[0]);
          hi = Math.min(hi, bounds[1]);
        }
      }
      if (hi - lo <= 1e-8) continue;
      // At least one measured face must coincide over the entire covered
      // interval. A nested steel/symbol rectangle merely inside a wall does
      // not become a duplicate wall through containment alone.
      const sharedFace = [-1, 1].some((side) =>
        [-1, 1].some((otherSide) =>
          [lo, hi].every((t) => {
            const p = point(t),
              face: AreaPoint = [
                p[0] + side * n[0] * half,
                p[1] + side * n[1] * half,
              ];
            return (
              Math.abs(
                dot(sub(face, anchor.a), an) -
                  (otherSide * anchor.thicknessFt) / 2,
              ) <= 1e-5
            );
          }),
        ),
      );
      if (sharedFace) coverage.push({ lo, hi, by: [anchor.index] });
    }
    coverage.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    const union: Array<{ lo: number; hi: number; by: Set<number> }> = [];
    for (const c of coverage) {
      const previous = union.at(-1);
      // Numerical epsilon only: never bridge a meaningful measured gap.
      if (previous && c.lo <= previous.hi + 1e-8) {
        previous.hi = Math.max(previous.hi, c.hi);
        c.by.forEach((id) => previous.by.add(id));
      } else union.push({ ...c, by: new Set(c.by) });
    }
    let cursor = 0;
    for (const c of union) {
      if (c.lo - cursor > 1e-8)
        result.bodies.push({
          ...original[sourceIndex],
          a: point(cursor),
          b: point(c.lo),
        });
      result.covered.push({
        sourceIndex,
        by: [...c.by],
        startFt: c.lo,
        endFt: c.hi,
      });
      cursor = Math.max(cursor, c.hi);
    }
    if (length - cursor > 1e-8)
      result.bodies.push({
        ...original[sourceIndex],
        a: point(cursor),
        b: point(length),
      });
  }
  return result;
}
