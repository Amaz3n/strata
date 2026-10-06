import type { AreaPoint } from "./area-evidence";

/** Consolidate cells of the same planar subdivision, using only exactly shared
 * edges. This is not a gap-closing or semantic classifier. An annular union
 * cannot be represented by one flat deduction ring, so its original cells stay.
 * Unsupported topology and exhausted budgets likewise preserve all input. */
export function consolidateAreaDeductions(rings: AreaPoint[][]): {
  rings: AreaPoint[][];
  consolidatedCells: number;
  unresolved: boolean;
} {
  const original = (unresolved = false) => ({
    rings,
    consolidatedCells: 0,
    unresolved,
  });
  if (rings.length < 2) return original();
  if (
    rings.length > 20_000 ||
    rings.reduce((n, r) => n + r.length, 0) > 200_000
  )
    return original(true);
  const key = (p: AreaPoint) => `${p[0]},${p[1]}`;
  const signedArea = (r: AreaPoint[]) => {
    const [ox, oy] = r[0];
    return (
      r.reduce((n, p, i) => {
        const q = r[(i + 1) % r.length];
        return n + (p[0] - ox) * (q[1] - oy) - (p[1] - oy) * (q[0] - ox);
      }, 0) / 2
    );
  };
  type Edge = {
    a: AreaPoint;
    b: AreaPoint;
    from: string;
    to: string;
    owner: number;
  };
  const edges = new Map<string, Edge[]>(),
    parent = rings.map((_r, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (const [owner, source] of rings.entries()) {
    if (
      source.length < 3 ||
      source.some((p) => p.length !== 2 || !p.every(Number.isFinite)) ||
      !Number.isFinite(signedArea(source)) ||
      !signedArea(source)
    )
      return original(true);
    const ring = signedArea(source) > 0 ? source : [...source].reverse();
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length],
        from = key(a),
        to = key(b);
      if (from === to) return original(true);
      const edgeKey = [from, to].sort().join("|"),
        list = edges.get(edgeKey) ?? [];
      list.push({ a, b, from, to, owner });
      edges.set(edgeKey, list);
      if (
        list.length > 2 ||
        (list.length === 2 &&
          (list[0].owner === owner || list[0].from === from))
      )
        return original(true);
      if (list.length === 2) parent[root(owner)] = root(list[0].owner);
    }
  }
  const components = new Map<number, number[]>(),
    boundaries = new Map<number, Edge[]>();
  rings.forEach((_r, i) => {
    const r = root(i);
    const owners = components.get(r) ?? [];
    owners.push(i);
    components.set(r, owners);
  });
  for (const list of edges.values())
    if (list.length === 1) {
      const e = list[0],
        r = root(e.owner);
      const boundary = boundaries.get(r) ?? [];
      boundary.push(e);
      boundaries.set(r, boundary);
    }
  const result: AreaPoint[][] = [];
  let consolidatedCells = 0,
    unresolved = false;
  for (const [component, owners] of components) {
    if (owners.length === 1) {
      result.push(rings[owners[0]]);
      continue;
    }
    const boundary = boundaries.get(component) ?? [],
      outgoing = new Map<string, number[]>();
    boundary.forEach((e, i) => {
      const list = outgoing.get(e.from) ?? [];
      list.push(i);
      outgoing.set(e.from, list);
    });
    const visited = new Set<number>(),
      loops: AreaPoint[][] = [];
    let valid = boundary.length > 0;
    for (let start = 0; valid && start < boundary.length; start++) {
      if (visited.has(start)) continue;
      const loop: AreaPoint[] = [],
        vertices = new Set<string>();
      let current = start;
      do {
        const e = boundary[current];
        if (visited.has(current) || vertices.has(e.from)) {
          valid = false;
          break;
        }
        visited.add(current);
        vertices.add(e.from);
        loop.push(e.a);
        const options = outgoing.get(e.to) ?? [];
        if (!options.length) {
          valid = false;
          break;
        }
        // Follow the boundary with selected cells on the left. At an
        // articulation, take the first clockwise edge from the incoming twin.
        const reverse = Math.atan2(e.a[1] - e.b[1], e.a[0] - e.b[0]);
        current = options.reduce((best, candidate) => {
          const turn = (index: number) => {
            const next = boundary[index];
            return (
              (reverse -
                Math.atan2(next.b[1] - next.a[1], next.b[0] - next.a[0]) +
                Math.PI * 2) %
              (Math.PI * 2)
            );
          };
          return turn(candidate) < turn(best) ? candidate : best;
        }, options[0]);
      } while (current !== start && loop.length <= boundary.length);
      if (
        !valid ||
        current !== start ||
        loop.length < 3 ||
        signedArea(loop) <= 0
      ) {
        valid = false;
        break;
      }
      // Remove only collinear forward subdivisions within roundoff. Original
      // corner coordinates remain; no tolerance-based straightening or snapping.
      const simple = loop.filter((p, i) => {
        const a = loop[(i + loop.length - 1) % loop.length],
          b = loop[(i + 1) % loop.length];
        const ux = p[0] - a[0],
          uy = p[1] - a[1],
          vx = b[0] - p[0],
          vy = b[1] - p[1];
        const cross = ux * vy - uy * vx;
        return (
          ux * vx + uy * vy <= 0 ||
          Math.abs(cross) >
            32 * Number.EPSILON * (Math.abs(ux * vy) + Math.abs(uy * vx))
        );
      });
      if (simple.length < 3 || simple.length > 500) {
        valid = false;
        break;
      }
      loops.push(simple);
    }
    const sourceArea = owners.reduce(
      (n, i) => n + Math.abs(signedArea(rings[i])),
      0,
    );
    const unionArea = loops.reduce((n, r) => n + signedArea(r), 0);
    if (
      !valid ||
      visited.size !== boundary.length ||
      Math.abs(sourceArea - unionArea) > Math.max(1e-8, sourceArea * 1e-10)
    ) {
      result.push(...owners.map((i) => rings[i]));
      unresolved = true;
    } else {
      result.push(...loops);
      consolidatedCells += owners.length - loops.length;
    }
  }
  return { rings: result, consolidatedCells, unresolved };
}
