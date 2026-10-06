import type { AreaPoint } from "./area-evidence";
type SegmentEndpoints = { a: AreaPoint; b: AreaPoint };

/** Broad-phase index in physical drawing units. Long segments retain a
 * fallback bucket so a bounded index never silently loses source evidence. */
export function segmentIndex<T extends SegmentEndpoints>(
  segments: readonly T[],
  cellSize = 4,
) {
  const cells = new Map<string, number[]>(), overflow: number[] = [];
  const bounds = (s: SegmentEndpoints, margin: number) => [
    Math.floor((Math.min(s.a[0], s.b[0]) - margin) / cellSize),
    Math.floor((Math.min(s.a[1], s.b[1]) - margin) / cellSize),
    Math.floor((Math.max(s.a[0], s.b[0]) + margin) / cellSize),
    Math.floor((Math.max(s.a[1], s.b[1]) + margin) / cellSize),
  ];
  segments.forEach((s, i) => {
    const [x0, y0, x1, y1] = bounds(s, 0);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) {
      overflow.push(i);
      return;
    }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = `${x},${y}`, list = cells.get(key) ?? [];
      list.push(i);
      cells.set(key, list);
    }
  });
  return (s: SegmentEndpoints, margin = 0): number[] => {
    const [x0, y0, x1, y1] = bounds(s, margin);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096)
      return segments.map((_, i) => i);
    const found = new Set(overflow);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++)
      for (const i of cells.get(`${x},${y}`) ?? []) found.add(i);
    return [...found];
  };
}
