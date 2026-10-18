import {
  evidencePathBounds,
  flattenEvidencePath,
  type AreaEvidence,
  type AreaPoint,
  type EvidencePath,
} from "./area-evidence";

/** Conservative centerline visibility for straight source assemblies. Curved
 * erase paint and unsupported mask clips cannot certify visible linework.
 * Any measured positive-length erased interval invalidates a complete face;
 * this helper does not invent fragments or treat sampled visibility as proof. */
export function vectorSourceVisibility(
  evidence: AreaEvidence,
): (path: EvidencePath) => boolean {
  const rectangles = new Map<number, [number, number, number, number]>();
  for (const p of evidence.paths.filter(
    (p) => p.kind === "clip" && !p.commands.some((c) => c[0] === "C"),
  )) {
    const rings = flattenEvidencePath(p),
      r = rings[0];
    if (rings.length !== 1 || r.length !== 5) continue;
    const b: [number, number, number, number] = [
      Math.min(...r.map((p) => p[0])),
      Math.min(...r.map((p) => p[1])),
      Math.max(...r.map((p) => p[0])),
      Math.max(...r.map((p) => p[1])),
    ];
    if (
      new Set(r.slice(0, 4).map((p) => p.join(","))).size === 4 &&
      r.every(
        (p, i) =>
          (p[0] === b[0] || p[0] === b[2]) &&
          (p[1] === b[1] || p[1] === b[3]) &&
          (!i || p[0] === r[i - 1][0] || p[1] === r[i - 1][1]),
      )
    )
      rectangles.set(p.id, b);
  }
  const cross = (a: AreaPoint, b: AreaPoint) => a[0] * b[1] - a[1] * b[0];
  const sub = (a: AreaPoint, b: AreaPoint): AreaPoint => [
    a[0] - b[0],
    a[1] - b[1],
  ];
  const inside = (p: AreaPoint, rings: AreaPoint[][], evenOdd: boolean) => {
    let winding = 0;
    for (const ring of rings)
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1],
          b = ring[i],
          q = sub(p, a),
          v = sub(b, a);
        if (v[0] ** 2 + v[1] ** 2 < 1e-24) continue;
        if (
          Math.abs(cross(v, q)) < 1e-12 &&
          q[0] * v[0] + q[1] * v[1] >= 0 &&
          q[0] * v[0] + q[1] * v[1] <= v[0] ** 2 + v[1] ** 2
        )
          return true;
        if (a[1] <= p[1] && b[1] > p[1] && cross(v, q) > 0) winding++;
        else if (a[1] > p[1] && b[1] <= p[1] && cross(v, q) < 0) winding--;
      }
    return evenOdd ? Math.abs(winding) % 2 === 1 : winding !== 0;
  };
  const masks = evidence.paths
    .filter(
      (p) =>
        p.kind === "fill" &&
        p.opacity >= 0.99 &&
        ((p.colorSpace === "DeviceGray" &&
          p.color.length === 1 &&
          p.color[0] >= 0.98) ||
          (p.colorSpace === "DeviceRGB" &&
            p.color.length === 3 &&
            p.color.every((c) => c >= 0.98))),
    )
    .map((p) => ({
      p,
      bounds: evidencePathBounds(p),
      rings: flattenEvidencePath(p),
      unsupported:
        p.commands.some((c) => c[0] === "C") ||
        p.clips.some((id) => !rectangles.has(id)),
    }));
  const cached = new Map<number, boolean>();
  return (path) => {
    const prior = cached.get(path.id);
    if (prior !== undefined) return prior;
    const rings = flattenEvidencePath(path);
    let visible =
      !path.commands.some((c) => c[0] === "C") &&
      path.clips.every((id) => {
        const b = rectangles.get(id);
        return (
          b &&
          rings
            .flat()
            .every(
              (p) =>
                p[0] >= b[0] - 1e-10 &&
                p[0] <= b[2] + 1e-10 &&
                p[1] >= b[1] - 1e-10 &&
                p[1] <= b[3] + 1e-10,
            )
        );
      });
    for (const ring of rings)
      for (let i = 1; visible && i < ring.length; i++) {
        const a = ring[i - 1],
          b = ring[i],
          v = sub(b, a);
        if (Math.hypot(...v) < 1e-12) continue;
        for (const mask of masks) {
          const box = mask.bounds;
          if (
            mask.p.id <= path.id ||
            !box ||
            box.x0 > Math.max(a[0], b[0]) ||
            box.x1 < Math.min(a[0], b[0]) ||
            box.y0 > Math.max(a[1], b[1]) ||
            box.y1 < Math.min(a[1], b[1])
          )
            continue;
          if (mask.unsupported) {
            visible = false;
            break;
          }
          const clips = mask.p.clips.map((id) => rectangles.get(id)!);
          const clipEdges = clips.flatMap(([x0, y0, x1, y1]) => [
            [
              [x0, y0],
              [x1, y0],
              [x1, y1],
              [x0, y1],
              [x0, y0],
            ] as AreaPoint[],
          ]);
          const times = [0, 1];
          for (const boundary of [...mask.rings, ...clipEdges])
            for (let j = 1; j < boundary.length; j++) {
              const c = boundary[j - 1],
                d = sub(boundary[j], c),
                q = sub(c, a),
                den = cross(v, d);
              if (Math.abs(den) > 1e-14) {
                const t = cross(q, d) / den,
                  u = cross(q, v) / den;
                if (t > 0 && t < 1 && u >= -1e-10 && u <= 1 + 1e-10)
                  times.push(t);
              } else if (Math.abs(cross(v, q)) < 1e-12) {
                const length = v[0] ** 2 + v[1] ** 2;
                for (const p of [c, boundary[j]]) {
                  const t =
                    ((p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1]) / length;
                  if (t > 0 && t < 1) times.push(t);
                }
              }
            }
          times.sort((a, b) => a - b);
          if (
            times.slice(1).some((end, j) => {
              if (end - times[j] <= 1e-10) return false;
              const t = (end + times[j]) / 2,
                p: AreaPoint = [a[0] + t * v[0], a[1] + t * v[1]];
              return (
                clips.every(
                  (b) =>
                    p[0] >= b[0] &&
                    p[0] <= b[2] &&
                    p[1] >= b[1] &&
                    p[1] <= b[3],
                ) && inside(p, mask.rings, mask.p.evenOdd)
              );
            })
          ) {
            visible = false;
            break;
          }
        }
      }
    cached.set(path.id, visible);
    return visible;
  };
}
