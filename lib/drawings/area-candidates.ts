import { areasOverlap, type AreaProposal } from "./area-takeoff";

/** Canonical geometry identity includes deductions and ignores vertex start and winding. */
export function areaGeometryKey(
  area: Pick<AreaProposal, "points" | "holes">,
): string {
  const ring = (points: AreaProposal["points"]) => {
    const corners = points.filter((p, i) => {
      const a = points[(i + points.length - 1) % points.length],
        b = points[(i + 1) % points.length];
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        length = Math.hypot(dx, dy);
      return (
        !length ||
        Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) > length * 1e-10 ||
        (p[0] - a[0]) * (p[0] - b[0]) + (p[1] - a[1]) * (p[1] - b[1]) > 0
      );
    });
    const values = corners.map((p) => p.map((n) => n.toFixed(8)).join(","));
    return [values, [...values].reverse()]
      .map((v) => {
        const first = v.reduce((best, p, i) => (p < v[best] ? i : best), 0);
        return [...v.slice(first), ...v.slice(0, first)].join(";");
      })
      .sort()[0];
  };
  return ring(area.points) + "|" + area.holes.map(ring).sort().join("|");
}
export interface AreaCandidate {
  area: AreaProposal;
  support: number;
  interpretation: string;
  /** Retain the primary vector preview when a counter-interpretation adds no
   * stronger boundary evidence. This is a fallback, never a correctness claim. */
  primary?: boolean;
}
export interface AreaConflict {
  selectedIds: string[];
  alternativeKeys: string[];
  boundedSearch: boolean;
}

/** Select compatible interpretations by evidenced floor extent, not arrival or
 * room count. Evidence strength precedes floor extent: a much larger uncertain
 * enclosure must not win just because it increases the total proposed quantity.
 * Equal evidence preserves the primary preview, while retaining
 * all competing interpretations. This is deterministic ranking, not proof that
 * the selected partition is correct or a globally optimal architectural model. */
export function reconcileAreaCandidates(candidates: AreaCandidate[]): {
  proposals: AreaProposal[];
  conflicts: AreaConflict[];
  alternatives: AreaCandidate[];
} {
  const unique = new Map<string, AreaCandidate>();
  for (const candidate of candidates) {
    const key = areaGeometryKey(candidate.area),
      previous = unique.get(key);
    if (
      !previous ||
      candidate.support > previous.support ||
      (candidate.support === previous.support &&
        ((candidate.primary && !previous.primary) ||
          (Boolean(candidate.primary) === Boolean(previous.primary) &&
            candidate.interpretation < previous.interpretation)))
    )
      unique.set(key, candidate);
  }
  const entries = [...unique].sort(([a], [b]) => a.localeCompare(b));
  const adjacency = entries.map(() => new Set<number>());
  const boxes = entries.map(([, c]) => ({
    x0: Math.min(...c.area.points.map((p) => p[0])),
    x1: Math.max(...c.area.points.map((p) => p[0])),
    y0: Math.min(...c.area.points.map((p) => p[1])),
    y1: Math.max(...c.area.points.map((p) => p[1])),
  }));
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++) {
      const a = boxes[i],
        b = boxes[j];
      if (a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0)
        continue;
      if (areasOverlap(entries[i][1].area, entries[j][1].area)) {
        adjacency[i].add(j);
        adjacency[j].add(i);
      }
    }
  const visited = new Set<number>(),
    selected = new Set<number>(),
    groups: Array<{ component: number[]; chosen: number[] }> = [];
  for (let start = 0; start < entries.length; start++) {
    if (visited.has(start)) continue;
    const component = [start];
    visited.add(start);
    for (let n = 0; n < component.length; n++)
      for (const neighbor of adjacency[component[n]])
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          component.push(neighbor);
        }
    component.sort((a, b) => a - b);
    const chosen: number[] = [];
    const ranked = [...component].sort(
      (a, b) =>
        entries[b][1].support - entries[a][1].support ||
        Number(Boolean(entries[b][1].primary)) -
          Number(Boolean(entries[a][1].primary)) ||
        entries[a][1].area.areaSqft - entries[b][1].area.areaSqft ||
        a - b,
    );
    for (const i of ranked)
      if (!chosen.some((j) => adjacency[i].has(j))) chosen.push(i);
    chosen.forEach((i) => selected.add(i));
    if (component.length > chosen.length) groups.push({ component, chosen });
  }
  const byIndex = new Map<number, string>();
  const proposals = [...selected]
    .sort((a, b) => a - b)
    .map((i, n) => {
      const area = entries[i][1].area,
        id = `sheet-${n}`;
      byIndex.set(i, id);
      const conflict = adjacency[i].size > 0;
      return {
        ...area,
        id,
        warnings: [
          ...area.warnings,
          ...(conflict
            ? [
                "Competing boundary interpretations exist. Review this area before accepting.",
              ]
            : []),
        ],
      };
    });
  return {
    proposals,
    conflicts: groups.map(({ component, chosen }) => ({
      selectedIds: chosen.map((i) => byIndex.get(i)!),
      alternativeKeys: component
        .filter((i) => !selected.has(i))
        .map((i) => entries[i][0]),
      boundedSearch: false,
    })),
    alternatives: entries
      .filter((_, i) => !selected.has(i))
      .map(([, candidate]) => candidate),
  };
}
