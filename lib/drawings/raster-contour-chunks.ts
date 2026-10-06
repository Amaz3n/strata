import type { AreaPoint } from "./area-evidence";
export interface SourceContourChunk {
  id: number;
  points: AreaPoint[];
}
export interface SourceContourRoute extends SourceContourChunk {
  segmentPathIds: number[];
}
/** The contour encoder may split one observed ink route across path records.
 * Join exact shared endpoints only when two chunk ends uniquely meet. Every
 * segment keeps its original path ID. Coordinates and disconnected ink stay
 * unchanged; ambiguous junctions and closed source rings are not extended. */
export function joinRasterContourChunks(
  chunks: readonly SourceContourChunk[],
  work: () => boolean,
): SourceContourRoute[] {
  const key = (p: AreaPoint) => JSON.stringify(p),
    nodes = new Map<string, number[]>(),
    closed = new Set<string>();
  for (let i = 0; i < chunks.length; i++) {
    if (!work()) return [];
    const p = chunks[i].points;
    if (p.length < 2) continue;
    const a = key(p[0]),
      b = key(p.at(-1)!);
    if (a === b) {
      closed.add(a);
      continue;
    }
    for (const k of [a, b]) nodes.set(k, [...(nodes.get(k) ?? []), i]);
  }
  const used = new Set<number>(),
    result: SourceContourRoute[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (!work()) return [];
    if (used.has(i) || chunks[i].points.length < 2) continue;
    used.add(i);
    type Part = { id: number; points: readonly AreaPoint[]; reverse: boolean };
    const before: Part[] = [],
      after: Part[] = [],
      initial = chunks[i].points;
    for (const front of [false, true]) {
      let endpoint = front ? initial[0] : initial.at(-1)!;
      for (;;) {
        if (!work()) return [];
        const k = key(endpoint),
          next = nodes.get(k);
        if (closed.has(k) || next?.length !== 2) break;
        const index = next.find((j) => !used.has(j));
        if (index === undefined) break;
        const chunk = chunks[index],
          original = chunk.points,
          forward = key(front ? original.at(-1)! : original[0]) === k;
        used.add(index);
        (front ? before : after).push({
          id: chunk.id,
          points: original,
          reverse: !forward,
        });
        endpoint = front
          ? forward
            ? original[0]
            : original.at(-1)!
          : forward
            ? original.at(-1)!
            : original[0];
      }
    }
    const points: AreaPoint[] = [],
      segmentPathIds: number[] = [];
    // Flatten once, charging every retained source vertex to the caller budget.
    // Repeated array concatenation would make a long chunk chain quadratic.
    for (const part of [
      ...before.reverse(),
      { id: chunks[i].id, points: initial, reverse: false },
      ...after,
    ]) {
      const count = part.points.length;
      for (let j = 0; j < count; j++) {
        if (!work()) return [];
        if (j === 0 && points.length) continue;
        points.push(part.points[part.reverse ? count - 1 - j : j]);
        if (points.length > 1) segmentPathIds.push(part.id);
      }
    }
    result.push({ id: chunks[i].id, points, segmentPathIds });
  }
  return result;
}
