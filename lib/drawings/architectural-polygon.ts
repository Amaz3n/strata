import { Earcut } from "three/src/extras/Earcut.js";
import type { PlanPoint } from "./architectural-model";

/** Earcut is imported alone, without loading the Three renderer. */
export function triangulatePolygon(
  ring: PlanPoint[],
  holes: PlanPoint[][] = [],
) {
  const points = [...ring, ...holes.flat()];
  let offset = ring.length;
  const starts = holes.map((hole) => {
    const start = offset;
    offset += hole.length;
    return start;
  });
  return { points, indices: Earcut.triangulate(points.flat(), starts, 2) };
}

/** Pick the centroid of the largest triangle, which is inside even a concave
 * polygon with courtyards/voids. A polygon's area centroid need not be inside. */
export function interiorPoint(
  ring: PlanPoint[],
  holes: PlanPoint[][] = [],
): PlanPoint {
  const { points, indices } = triangulatePolygon(ring, holes);
  let largest = -1;
  let result: PlanPoint = ring[0] ?? [0, 0];
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3).map((j) => points[j]);
    const area = Math.abs(
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    );
    if (area > largest) {
      largest = area;
      result = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    }
  }
  return result;
}
