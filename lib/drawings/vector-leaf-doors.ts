import {
  flattenEvidencePath,
  type AreaEvidence,
  type AreaPoint,
} from "./area-evidence";
import type { VectorWallHypothesis } from "./vector-wall-network";
import { vectorSourceVisibility } from "./vector-source-visibility";
import { areaPathRole } from "./area-paths";

export interface VectorLeafDoorResult {
  doors: VectorLeafDoor[];
  limited: boolean;
  diagnostics: {
    clippedRasterArcIds?: number[];
    edges: number;
    rectangles: number;
    leaves: number;
    frames: number;
    framePairs: number;
    hostPairs: number;
    leafMatches: number;
    operations: number;
  };
}
export interface VectorLeafDoor {
  basis?: "raster-swing-leaf";
  sourceUncertaintyFt?: number;
  clearSpan?: [AreaPoint, AreaPoint];
  leafWidthFt?: number;
  widthBasis?: import("./opening-dimensions").OpeningWidthBasis;
  a: AreaPoint;
  b: AreaPoint;
  thicknessFt: number;
  doorPathIds: number[];
  framePathIds: number[];
  wallPathIds: number[];
  /** Exact revalidated raster flanks, not a role vote for their whole parents. */
  wallSpans?: VectorWallHypothesis[];
  jambs: Array<{ a: AreaPoint; b: AreaPoint; pathIds: number[] }>;
}
interface Rectangle {
  points: AreaPoint[];
  u: AreaPoint;
  v: AreaPoint;
  long: number;
  short: number;
  pathIds: number[];
  paint: string;
  style: string;
  leafEligible: boolean;
}
const sub = (a: AreaPoint, b: AreaPoint): AreaPoint => [
  a[0] - b[0],
  a[1] - b[1],
];
const dot = (a: AreaPoint, b: AreaPoint) => a[0] * b[0] + a[1] * b[1];
const cross = (a: AreaPoint, b: AreaPoint) => a[0] * b[1] - a[1] * b[0];
const dist = (a: AreaPoint, b: AreaPoint) => Math.hypot(...sub(a, b));
const key = (p: AreaPoint) => p.map((x) => x.toFixed(5)).join(",");
/** Arc-less open leaf plus two complete measured jamb linings. A rectangle or
 * a wall gap alone is insufficient. Both opaque flanks must independently
 * match the frame depth/axis. The rough aperture follows outer jamb faces;
 * clear opening and leaf width remain distinct measurements. No fitted arc,
 * catalog width, generic gap closure or default host thickness is used. */
export function vectorLeafDoors(input: {
  evidence: AreaEvidence | null | undefined;
  sx: number;
  sy: number;
  wallBodies: readonly VectorWallHypothesis[];
  candidateWallBodies?: readonly VectorWallHypothesis[];
  pathKinds: ReadonlyMap<number, string>;
}): VectorLeafDoorResult {
  const { evidence, sx, sy, wallBodies, pathKinds } = input;
  const result: VectorLeafDoorResult = {
    doors: [],
    limited: false,
    diagnostics: {
      edges: 0,
      rectangles: 0,
      leaves: 0,
      frames: 0,
      framePairs: 0,
      hostPairs: 0,
      leafMatches: 0,
      operations: 0,
    },
  };
  if (
    !evidence ||
    evidence.raster ||
    evidence.truncated ||
    ![sx, sy].every((x) => Number.isFinite(x) && x > 0) ||
    !wallBodies.length
  )
    return result;
  const feet = (p: AreaPoint): AreaPoint => [p[0] * sx, p[1] * sy],
    norm = (p: AreaPoint): AreaPoint => [p[0] / sx, p[1] / sy];
  const clips = new Map<number, number[]>();
  for (const p of evidence.paths.filter(
    (p) => p.kind === "clip" && !p.commands.some((c) => c[0] === "C"),
  )) {
    const r = flattenEvidencePath(p);
    if (r.length !== 1 || r[0].length !== 5) continue;
    const xs = r[0].map((p) => p[0]),
      ys = r[0].map((p) => p[1]),
      b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (
      r[0].every(
        (p, i) =>
          (p[0] === b[0] || p[0] === b[2]) &&
          (p[1] === b[1] || p[1] === b[3]) &&
          (!i || p[0] === r[0][i - 1][0] || p[1] === r[0][i - 1][1]),
      )
    )
      clips.set(p.id, b);
  }
  const visible = vectorSourceVisibility(evidence),
    paths = new Map(evidence.paths.map((p) => [p.id, p]));
  const rectangles: Rectangle[] = [],
    seen = new Set<string>();
  const add = (
    points: AreaPoint[],
    ids: number[],
    paint: string,
    style: string,
    leafEligible: boolean,
  ) => {
    if (points.length !== 4 || new Set(points.map(key)).size !== 4) return;
    const vectors = points.map((p, i) => sub(points[(i + 1) % 4], p)),
      lengths = vectors.map((v) => Math.hypot(...v));
    if (
      lengths.some((n) => n < 0.04) ||
      Math.max(...lengths) > 4.5 ||
      Math.min(...lengths) > 0.25
    )
      return;
    if (
      vectors.some(
        (v, i) =>
          Math.abs(dot(v, vectors[(i + 1) % 4])) /
            (lengths[i] * lengths[(i + 1) % 4]) >
          0.002,
      )
    )
      return;
    if (
      Math.abs(lengths[0] - lengths[2]) > 0.005 ||
      Math.abs(lengths[1] - lengths[3]) > 0.005
    )
      return;
    const longest = lengths.indexOf(Math.max(...lengths)),
      u: AreaPoint = [
        vectors[longest][0] / lengths[longest],
        vectors[longest][1] / lengths[longest],
      ],
      v: AreaPoint = [-u[1], u[0]],
      signature = points.map(key).sort().join("|") + "|" + style;
    if (seen.has(signature)) return;
    seen.add(signature);
    rectangles.push({
      points,
      u,
      v,
      long: Math.max(...lengths),
      short: Math.min(...lengths),
      pathIds: [...new Set(ids)],
      paint,
      style,
      leafEligible,
    });
  };
  const edgeKeys = new Set<string>();
  const edges: Array<{
    a: AreaPoint;
    b: AreaPoint;
    id: number;
    paint: string;
    style: string;
    leafEligible: boolean;
  }> = [];
  for (const p of evidence.paths) {
    const kind = pathKinds.get(p.id) ?? "unknown",
      dark =
        (p.colorSpace === "DeviceGray" &&
          p.color.length === 1 &&
          p.color[0] <= 0.8) ||
        (p.colorSpace === "DeviceRGB" &&
          p.color.length === 3 &&
          p.color.every((c) => c <= 0.8));
    if (
      !["unknown", "door", "wall"].includes(kind) ||
      !["unknown", "structure", "doorway"].includes(areaPathRole(p)) ||
      p.kind === "clip" ||
      !dark ||
      p.opacity < 0.95 ||
      p.dashes.length ||
      p.commands.some((c) => c[0] === "C") ||
      !visible(p)
    )
      continue;
    const rings = flattenEvidencePath(p);
    if (
      rings.length !== 1 ||
      rings[0].length > 5 ||
      p.clips.some((id) => {
        const b = clips.get(id);
        return (
          !b ||
          rings[0].some(
            (q) =>
              q[0] < b[0] - 1e-9 ||
              q[0] > b[2] + 1e-9 ||
              q[1] < b[1] - 1e-9 ||
              q[1] > b[3] + 1e-9,
          )
        );
      })
    )
      continue;
    const points = rings[0].map(feet),
      paint = JSON.stringify([p.colorSpace, p.color, p.opacity]),
      style = JSON.stringify([paint, p.kind, p.width, p.clips]),
      leafEligible = kind !== "wall";
    if (points.length === 5 && dist(points[0], points[4]) < 0.00001)
      add(points.slice(0, 4), [p.id], paint, style, leafEligible);
    else if (
      p.kind === "stroke" &&
      p.commands.length === 2 &&
      points.length === 2 &&
      dist(points[0], points[1]) >= 0.04 &&
      dist(points[0], points[1]) <= 4.5
    ) {
      const edgeKey =
        style + "|" + leafEligible + "|" + points.map(key).sort().join("|");
      if (edgeKeys.has(edgeKey)) continue;
      edgeKeys.add(edgeKey);
      edges.push({
        a: points[0],
        b: points[1],
        id: p.id,
        paint,
        style,
        leafEligible,
      });
      if (edges.length > 24000) {
        result.limited = true;
        result.diagnostics.edges = edges.length;
        return result;
      }
    }
  }
  const exhausted = () => ++result.diagnostics.operations > 250000;
  const stop = () => {
    result.limited = true;
    result.doors = [];
    result.diagnostics.edges = edges.length;
    result.diagnostics.rectangles = rectangles.length;
    return result;
  };
  const nodes = new Map<string, number[]>();
  edges.forEach((e, i) => {
    for (const p of [e.a, e.b]) {
      const k = e.style + "|" + key(p);
      nodes.set(k, [...(nodes.get(k) ?? []), i]);
    }
  });
  const other = (e: (typeof edges)[number], p: AreaPoint) =>
    key(e.a) === key(p) ? e.b : e.a;
  for (let i = 0; i < edges.length; i++) {
    const first = edges[i],
      a = first.a,
      b = first.b;
    for (const j of nodes.get(first.style + "|" + key(b)) ?? []) {
      if (exhausted()) return stop();
      if (j <= i) continue;
      const second = edges[j],
        c = other(second, b);
      if (
        Math.abs(dot(sub(b, a), sub(c, b))) / (dist(a, b) * dist(b, c)) >
        0.002
      )
        continue;
      for (const k of nodes.get(first.style + "|" + key(c)) ?? []) {
        if (exhausted()) return stop();
        if (k === j || k <= i) continue;
        const third = edges[k],
          d = other(third, c);
        for (const l of nodes.get(first.style + "|" + key(d)) ?? []) {
          if (exhausted()) return stop();
          if (
            l <= i ||
            l === j ||
            l === k ||
            key(other(edges[l], d)) !== key(a)
          )
            continue;
          add(
            [a, b, c, d],
            [first.id, second.id, third.id, edges[l].id],
            first.paint,
            first.style,
            [first, second, third, edges[l]].every((e) => e.leafEligible),
          );
        }
      }
    }
    if (rectangles.length > 4000) {
      result.limited = true;
      result.diagnostics.rectangles = rectangles.length;
      return result;
    }
  }
  const leaves = rectangles.filter(
      (r) =>
        r.leafEligible && r.long >= 1.5 && r.long <= 4.5 && r.short >= 0.07,
    ),
    frames = rectangles.filter(
      (r) => r.long >= 0.2 && r.long <= 1.5 && r.short <= 0.2,
    ),
    results: VectorLeafDoor[] = [],
    unique = new Set<string>();
  result.diagnostics = {
    ...result.diagnostics,
    edges: edges.length,
    rectangles: rectangles.length,
    leaves: leaves.length,
    frames: frames.length,
  };
  const validBody = (h: VectorWallHypothesis) => {
    const source = h.pathIds.map((id) => paths.get(id));
    if (
      source.length !== 2 ||
      source[0]?.id === source[1]?.id ||
      source.some(
        (p) =>
          !p ||
          p.kind !== "stroke" ||
          p.commands.length !== 2 ||
          p.commands[0][0] !== "M" ||
          p.commands[1][0] !== "L" ||
          p.opacity < 0.95 ||
          p.dashes.length ||
          !visible(p) ||
          !["unknown", "wall"].includes(pathKinds.get(p.id) ?? "unknown") ||
          !["unknown", "structure"].includes(areaPathRole(p)),
      )
    )
      return false;
    const [a, b] = source as NonNullable<(typeof source)[number]>[];
    if (
      JSON.stringify([a.colorSpace, a.color, a.width, a.opacity, a.clips]) !==
        JSON.stringify([b.colorSpace, b.color, b.width, b.opacity, b.clips]) ||
      h.strokeWidth !== a.width
    )
      return false;
    const dark = (p: typeof a) =>
      (p.colorSpace === "DeviceGray" &&
        p.color.length === 1 &&
        p.color[0] <= 0.8) ||
      (p.colorSpace === "DeviceRGB" &&
        p.color.length === 3 &&
        p.color.every((c) => c <= 0.8));
    if (!dark(a) || !dark(b)) return false;
    const point = (p: typeof a, i: number) =>
        feet([p.commands[i][1]!, p.commands[i][2]!]),
      aa = point(a, 0),
      ab = point(a, 1),
      ba = point(b, 0),
      bb = point(b, 1),
      axis = sub(ab, aa),
      length = Math.hypot(...axis),
      other = sub(bb, ba),
      otherLength = Math.hypot(...other);
    if (!length || !otherLength) return false;
    const u: AreaPoint = [axis[0] / length, axis[1] / length],
      n: AreaPoint = [-u[1], u[0]],
      offset = dot(sub(ba, aa), n),
      ends = [dot(sub(ba, aa), u), dot(sub(bb, aa), u)].sort((a, b) => a - b),
      lo = Math.max(0, ends[0]),
      hi = Math.min(length, ends[1]);
    if (
      hi - lo < 0.18 ||
      Math.abs(cross(u, [other[0] / otherLength, other[1] / otherLength])) >
        0.002 ||
      Math.abs(dot(sub(bb, aa), n) - offset) > 0.01 ||
      Math.abs(h.thicknessFt - Math.abs(offset)) > 0.00001
    )
      return false;
    const ha = feet(h.a),
      hb = feet(h.b),
      span = [dot(sub(ha, aa), u), dot(sub(hb, aa), u)].sort((a, b) => a - b);
    return (
      Math.abs(span[0] - lo) < 0.00001 &&
      Math.abs(span[1] - hi) < 0.00001 &&
      [ha, hb].every((p) => Math.abs(dot(sub(p, aa), n) - offset / 2) < 0.00001)
    );
  };
  const candidates = (input.candidateWallBodies ?? wallBodies).filter(
    validBody,
  );
  const anchors = wallBodies.filter(validBody);
  const anchored = (h: VectorWallHypothesis) =>
    anchors.some((b) => b.pathIds.every((id) => h.pathIds.includes(id)));
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      if (exhausted()) return stop();
      const a = frames[i],
        b = frames[j];
      if (
        a.style !== b.style ||
        Math.abs(cross(a.u, b.u)) > 0.002 ||
        Math.abs(a.long - b.long) > 0.02
      )
        continue;
      const u = a.u,
        v = a.v,
        range = (r: Rectangle, axis: AreaPoint) => [
          Math.min(...r.points.map((p) => dot(p, axis))),
          Math.max(...r.points.map((p) => dot(p, axis))),
        ],
        depth = range(a, u),
        depthB = range(b, u);
      if (depth.some((n, i) => Math.abs(n - depthB[i]) > 0.02)) continue;
      const ra = range(a, v),
        rb = range(b, v),
        before = ra[0] < rb[0] ? a : b,
        after = before === a ? b : a,
        r0 = range(before, v),
        r1 = range(after, v),
        clear = r1[0] - r0[1],
        rough = r1[1] - r0[0];
      if (clear < 1.5 || rough > 5 || clear <= 0) continue;
      result.diagnostics.framePairs++;
      const centre = (depth[0] + depth[1]) / 2,
        point = (t: number, d = centre): AreaPoint => [
          v[0] * t + u[0] * d,
          v[1] * t + u[1] * d,
        ];
      const supports = (side: "before" | "after") =>
        candidates.filter((h) => {
          if (Math.abs(h.thicknessFt - (depth[1] - depth[0])) > 0.03)
            return false;
          const ha = feet(h.a),
            hb = feet(h.b),
            axis = sub(hb, ha),
            length = Math.hypot(...axis);
          if (
            !length ||
            Math.abs(cross([axis[0] / length, axis[1] / length], v)) > 0.002 ||
            Math.abs(dot(ha, u) - centre) > 0.02
          )
            return false;
          const span = [dot(ha, v), dot(hb, v)].sort((a, b) => a - b);
          return side === "before"
            ? Math.abs(span[1] - r0[0]) <= 0.02 && span[0] <= r0[0] - 0.18
            : Math.abs(span[0] - r1[1]) <= 0.02 && span[1] >= r1[1] + 0.18;
        });
      const low = supports("before"),
        high = supports("after");
      if (!low.length || !high.length || ![...low, ...high].some(anchored))
        continue;
      result.diagnostics.hostPairs++;
      const matches = leaves.filter(
        (leaf) =>
          leaf.paint === a.paint &&
          Math.abs(cross(leaf.u, u)) <= 0.002 &&
          Math.abs(leaf.long - clear) <= 0.03 &&
          leaf.pathIds.every(
            (id) => !a.pathIds.includes(id) && !b.pathIds.includes(id),
          ) &&
          leaf.points.some((p) =>
            [before, after].some((frame) =>
              frame.points.some((q) => dist(p, q) < 0.02),
            ),
          ),
      );
      result.diagnostics.leafMatches += matches.length;
      if (matches.length !== 1) continue;
      const signature = [key(point(r0[0])), key(point(r1[1]))].sort().join("|");
      if (unique.has(signature)) continue;
      unique.add(signature);
      results.push({
        a: norm(point(r0[0])),
        b: norm(point(r1[1])),
        thicknessFt: depth[1] - depth[0],
        doorPathIds: matches[0].pathIds,
        framePathIds: [...a.pathIds, ...b.pathIds],
        wallPathIds: [...new Set([...low, ...high].flatMap((h) => h.pathIds))],
        jambs: [
          {
            a: norm(point(r0[0], depth[0])),
            b: norm(point(r0[0], depth[1])),
            pathIds: before.pathIds,
          },
          {
            a: norm(point(r1[1], depth[0])),
            b: norm(point(r1[1], depth[1])),
            pathIds: after.pathIds,
          },
        ],
      });
    }
  result.doors = results;
  return result;
}
