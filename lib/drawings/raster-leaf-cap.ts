import type { AreaPoint as Point } from "./area-evidence";
type Contour = { id: number; points: Point[] };
/** Inspect consecutive original contour segments in the measured leaf-tip
 * window. Clipping trims observed ink; it never connects separate contours. */
export function observedLeafCap(
  contours: readonly Contour[],
  end: Point,
  axis: Point,
  depth: number,
  error: number,
  pixel: number,
  work: () => boolean,
): { id: number } | null {
  const along = (p: Point) =>
    (p[0] - end[0]) * axis[0] + (p[1] - end[1]) * axis[1];
  const normal = (p: Point) =>
    axis[0] * (p[1] - end[1]) - axis[1] * (p[0] - end[0]);
  const inside = (p: Point) =>
    Math.abs(along(p)) <= error && Math.abs(normal(p)) <= depth / 2 + pixel;
  const clip = (a: Point, b: Point): [Point, Point] | null => {
    let lo = 0,
      hi = 1;
    for (const [v, d, min, max] of [
      [along(a), along(b) - along(a), -error, error],
      [normal(a), normal(b) - normal(a), -depth / 2 - pixel, depth / 2 + pixel],
    ]) {
      if (Math.abs(d) < 1e-12) {
        if (v < min || v > max) return null;
        continue;
      }
      const t = [(min - v) / d, (max - v) / d].sort((a, b) => a - b);
      lo = Math.max(lo, t[0]);
      hi = Math.min(hi, t[1]);
      if (hi <= lo) return null;
    }
    return [
      [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo],
      [a[0] + (b[0] - a[0]) * hi, a[1] + (b[1] - a[1]) * hi],
    ];
  };
  for (const contour of contours) {
    let points = contour.points;
    const first = points[0],
      last = points.at(-1);
    if (!first || !last) continue;
    if (first[0] === last[0] && first[1] === last[1]) {
      const open = points.slice(0, -1),
        start = open.findIndex((p) => !inside(p));
      if (start > 0)
        points = [...open.slice(start), ...open.slice(0, start + 1)];
    }
    let route: Point[] = [];
    const accepts = () => {
      if (route.length < 2) return false;
      const first = route[0],
        last = route.at(-1)!,
        offsets = [normal(first), normal(last)],
        length = route
          .slice(1)
          .reduce(
            (n, p, i) => n + Math.hypot(p[0] - route[i][0], p[1] - route[i][1]),
            0,
          );
      return (
        Math.min(...offsets) <= -depth / 2 + pixel &&
        Math.max(...offsets) >= depth / 2 - pixel &&
        length <= depth + error * 2 &&
        Math.abs(along(last) - along(first)) <= error &&
        Math.hypot(
          (first[0] + last[0]) / 2 - end[0],
          (first[1] + last[1]) / 2 - end[1],
        ) <=
          error + depth / 2
      );
    };
    for (let i = 1; i < points.length; i++) {
      if (!work()) return null;
      const segment = clip(points[i - 1], points[i]);
      if (!segment) {
        if (accepts()) return { id: contour.id };
        route = [];
        continue;
      }
      if (
        route.length &&
        Math.hypot(
          route.at(-1)![0] - segment[0][0],
          route.at(-1)![1] - segment[0][1],
        ) > 1e-8
      ) {
        if (accepts()) return { id: contour.id };
        route = [];
      }
      if (!route.length) route.push(segment[0]);
      route.push(segment[1]);
      if (route.length > 256) route = [];
    }
    if (accepts()) return { id: contour.id };
  }
  return null;
}
