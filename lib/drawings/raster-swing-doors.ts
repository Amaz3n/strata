import { flattenEvidencePath, type AreaPoint } from "./area-evidence";
import { joinRasterContourChunks } from "./raster-contour-chunks";
import { observedLeafCap } from "./raster-leaf-cap";
import { observedRasterSwings } from "./raster-swing-observations";
import { RASTER_STRAIGHT_RUN_PROFILE } from "./raster-straight-runs";
import { segmentIndex } from "./segment-index";
import type { AreaVisualObservation } from "./area-semantics";
import {
  sourceWallNetwork,
  type VectorWallHypothesis,
} from "./vector-wall-network";
import type {
  vectorLeafDoors,
  VectorLeafDoorResult,
  VectorLeafDoor,
} from "./vector-leaf-doors";

type Input = Parameters<typeof vectorLeafDoors>[0] & {
  visualObservations?: readonly AreaVisualObservation[];
};
const sub = (a: AreaPoint, b: AreaPoint): AreaPoint => [
  a[0] - b[0],
  a[1] - b[1],
];
const dot = (a: AreaPoint, b: AreaPoint) => a[0] * b[0] + a[1] * b[1];
const cross = (a: AreaPoint, b: AreaPoint) => a[0] * b[1] - a[1] * b[0];
const distance = (a: AreaPoint, b: AreaPoint) => Math.hypot(...sub(a, b));
const mid = (a: AreaPoint, b: AreaPoint): AreaPoint => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
];
interface Span {
  a: AreaPoint;
  b: AreaPoint;
  u: AreaPoint;
  length: number;
  id: number;
  error: number;
}
function span(
  a: AreaPoint,
  b: AreaPoint,
  id: number,
  error: number,
): Span | null {
  const length = distance(a, b);
  return length > 1e-8
    ? {
        a,
        b,
        id,
        error,
        length,
        u: [(b[0] - a[0]) / length, (b[1] - a[1]) / length],
      }
    : null;
}

/** An observed swing alone never establishes a door. Require two independently
 * measured wall flanks, transverse source jambs, a two-face open leaf and its
 * drawn far-end cap. Source contours supply only the selected jamb spans, not
 * an architectural label for their entire compound path. Clipped swings require
 * more source context. All geometry stays provisional and source-addressable. */
export function rasterSwingDoors(input: Input): VectorLeafDoorResult {
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
      clippedRasterArcIds: [],
    },
  };
  if (
    !evidence?.raster ||
    evidence.truncated ||
    !(input.candidateWallBodies ?? wallBodies).length ||
    ![sx, sy, evidence.raster.feetPerPixel].every(
      (n) => Number.isFinite(n) && n > 0,
    )
  )
    return result;
  const fpp = evidence.raster.feetPerPixel,
    feet = (p: AreaPoint): AreaPoint => [p[0] * sx, p[1] * sy],
    norm = (p: AreaPoint): AreaPoint => [p[0] / sx, p[1] / sy];
  const work = () => {
    if (++result.diagnostics.operations > 2_000_000) {
      result.limited = true;
      return false;
    }
    return true;
  };
  const contours: Array<{ id: number; points: AreaPoint[] }> = [];
  const caps: Span[] = [],
    leaves: Span[] = [],
    observations = observedRasterSwings({ evidence, sx, sy, pathKinds }),
    arcs = observations.arcs;
  result.diagnostics.clippedRasterArcIds = observations.clippedPathIds;
  // Source arcs bound assembly work before unrelated sheet annotations can
  // exhaust the contour budget. A leaf and both jambs lie within the observed
  // swing radius plus the supported maximum wall depth. No source segment is
  // moved, joined across an excluded run, or assigned an architectural role.
  const arcWindows = arcs.map((arc) => {
    const points = [arc.center, ...arc.points],
      pad = 1.5 + arc.error + fpp * 3;
    return {
      a: [
        Math.min(...points.map((p) => p[0])) - pad,
        Math.min(...points.map((p) => p[1])) - pad,
      ] as AreaPoint,
      b: [
        Math.max(...points.map((p) => p[0])) + pad,
        Math.max(...points.map((p) => p[1])) + pad,
      ] as AreaPoint,
    };
  });
  const nearbyArcs = segmentIndex(arcWindows);
  const nearArc = (a: AreaPoint, b: AreaPoint) => {
    const delta = sub(b, a),
      length2 = dot(delta, delta);
    return nearbyArcs({ a, b }).some((index) => {
      if (!work()) return false;
      const box = arcWindows[index],
        arc = arcs[index];
      if (
        Math.max(a[0], b[0]) < box.a[0] ||
        Math.min(a[0], b[0]) > box.b[0] ||
        Math.max(a[1], b[1]) < box.a[1] ||
        Math.min(a[1], b[1]) > box.b[1]
      )
        return false;
      const t =
        length2 > 0
          ? Math.max(0, Math.min(1, dot(sub(arc.center, a), delta) / length2))
          : 0;
      const nearest: AreaPoint = [a[0] + delta[0] * t, a[1] + delta[1] * t];
      return (
        distance(nearest, arc.center) <= arc.radius + 1.5 + arc.error + fpp * 3
      );
    });
  };
  if (!arcs.length) return result;
  // A complete observed door assembly can corroborate measured flanks even
  // when no room tag seeds their network. Reinspect source pair support rather
  // than trusting caller-supplied bodies or promoting every nearby candidate.
  const measured = sourceWallNetwork({
    evidence,
    sx,
    sy,
    textRuns: [],
    visualObservations: input.visualObservations,
    classifiedWallPathIds:new Set([...pathKinds].filter(([,kind])=>kind==='wall').map(([id])=>id)),
    excludedPathIds: new Set(
      [...pathKinds]
        .filter(([, kind]) => !["unknown", "wall"].includes(kind))
        .map(([id]) => id),
    ),
  });
  if (measured.limited) {
    result.limited = true;
    return result;
  }
  const bodyKey = (body: VectorWallHypothesis) =>
    JSON.stringify([
      body.a,
      body.b,
      body.thicknessFt,
      [...body.pathIds].sort((a, b) => a - b),
    ]);
  const admittedBodies = new Set(measured.bodies.map(bodyKey));
  const conflictedPairs = new Set(measured.diagnostics.localizedPairConflicts?.map(c=>c.id) ?? []);
  // Local semantic observations expose unfilled candidates for inspection.
  // Only the individually admitted original span may become an outline host;
  // nearby unknown pairs cannot borrow its vote. Return fresh source bodies,
  // never caller-supplied sourceBand, depth weight or provenance metadata.
  const supportedBodies = new Map(measured.candidates.filter(body =>
    body.sourceBand !== 'unfilled' || (admittedBodies.has(bodyKey(body)) &&
      !conflictedPairs.has(`wall-pair:${[...body.pathIds].sort((a,b)=>a-b).join(':')}`))
  ).map(body=>[bodyKey(body),body]));
  const candidateBodies = (input.candidateWallBodies ?? wallBodies).flatMap(body => {
    const source = supportedBodies.get(bodyKey(body));
    return source ? [source] : [];
  });
  if (!candidateBodies.length) return result;
  for (const p of evidence.paths) {
    const kind = pathKinds.get(p.id) ?? "unknown";
    if (
      !["unknown", "wall", "door"].includes(kind) ||
      p.kind !== "stroke" ||
      p.clips.length ||
      p.dashes.length ||
      p.opacity < 0.95
    )
      continue;
    if (
      p.rasterFeature === "linework" &&
      p.rasterLine?.profile === RASTER_STRAIGHT_RUN_PROFILE &&
      p.rasterLine.continuousInk === true &&
      Number.isInteger(p.rasterLine.sampleCount) &&
      p.rasterLine.sampleCount >= 12 &&
      p.rasterLine.sampleCount <= 8192 &&
      Number.isFinite(p.rasterLine.boundaryFraction) &&
      p.rasterLine.boundaryFraction >= 0.9 &&
      p.rasterLine.boundaryFraction <= 1 &&
      Number.isFinite(p.rasterLine.maximumDeviationPixels) &&
      p.rasterLine.maximumDeviationPixels >= 0 &&
      p.rasterLine.maximumDeviationPixels <= 1.5 &&
      p.commands.length === 2 &&
      p.commands[0][0] === "M" &&
      p.commands[1][0] === "L"
    ) {
      const line = span(
        feet([p.commands[0][1], p.commands[0][2]]),
        feet([p.commands[1][1], p.commands[1][2]]),
        p.id,
        (p.rasterLine.maximumDeviationPixels + 0.5) * fpp,
      );
      if (
        line &&
        line.length >= 1.5 &&
        line.length <= 4.5 &&
        kind !== "wall" &&
        nearArc(line.a, line.b)
      )
        leaves.push(line);
    }
    if (
      p.rasterFeature === "paint-boundary" &&
      !p.commands.some((c) => c[0] === "C")
    ) {
      for (const ring of flattenEvidencePath(p)) {
        const firstRoute = contours.length;
        let route: AreaPoint[] = [];
        const emit = () => {
          if (route.length >= 2) contours.push({ id: p.id, points: route });
          route = [];
        };
        for (let i = 1; i < ring.length; i++) {
          if (!work()) return result;
          const a = feet(ring[i - 1]),
            b = feet(ring[i]);
          if (!nearArc(a, b)) {
            emit();
            continue;
          }
          if (!route.length) route.push(a);
          route.push(b);
          const line = span(a, b, p.id, fpp);
          if (line && line.length >= 0.025 && line.length <= 1.5)
            caps.push(line);
          if (caps.length > 24000) {
            result.limited = true;
            return result;
          }
        }
        emit();
        // A closed source ring has consecutive ink across its start index.
        // Rejoin only those already observed end/start routes; discarded
        // segments elsewhere still split the contour and are never bridged.
        if (contours.length - firstRoute > 1) {
          const head = contours[firstRoute],
            tail = contours.at(-1)!;
          const last = tail.points.at(-1)!,
            first = head.points[0];
          if (last[0] === first[0] && last[1] === first[1]) {
            head.points = [...tail.points, ...head.points.slice(1)];
            contours.pop();
          }
        }
      }
    }
  }

  // Another observation of the same source curve cannot bypass an explicit
  // conflicting architectural role on its overlapping ink.
  const conflictingCurves = evidence.paths
    .filter(
      (p) =>
        p.rasterFeature === "circular-arc" &&
        !["unknown", "door"].includes(pathKinds.get(p.id) ?? "unknown"),
    )
    .flatMap((p) => flattenEvidencePath(p).map((r) => r.map(feet)));
  for (let i = arcs.length - 1; i >= 0; i--) {
    const arc = arcs[i];
    if (
      conflictingCurves.some(
        (points) =>
          arc.points.filter((p) =>
            points.some((q) => {
              if (!work()) return false;
              return distance(p, q) <= fpp * 2;
            }),
          ).length >=
          arc.points.length * 0.8,
      )
    )
      arcs.splice(i, 1);
    if (result.limited) return result;
  }
  result.diagnostics.edges = caps.length + leaves.length;
  // Leaf faces must overlap and have a real transverse cap at their free end.
  const panels: Array<{
    a: AreaPoint;
    b: AreaPoint;
    length: number;
    depth: number;
    ids: number[];
    error: number;
    capped: AreaPoint;
  }> = [];
  const nearbyLeaves = segmentIndex(leaves),
    nearbyCaps = segmentIndex(caps);
  const contourBoxes = contours.map((contour) => ({
    a: [
      Math.min(...contour.points.map((p) => p[0])),
      Math.min(...contour.points.map((p) => p[1])),
    ] as AreaPoint,
    b: [
      Math.max(...contour.points.map((p) => p[0])),
      Math.max(...contour.points.map((p) => p[1])),
    ] as AreaPoint,
  }));
  const nearbyContours = segmentIndex(contourBoxes);
  for (let i = 0; i < leaves.length; i++)
    for (const j of nearbyLeaves(leaves[i], 0.2 + fpp * 5).sort(
      (a, b) => a - b,
    )) {
      if (j <= i) continue;
      if (!work()) return result;
      const a = leaves[i],
        b = leaves[j],
        error = a.error + b.error + fpp;
      if (Math.abs(cross(a.u, b.u)) * Math.min(a.length, b.length) > error)
        continue;
      const depth = Math.abs(cross(a.u, sub(b.a, a.a)));
      if (depth < 0.03 || depth > 0.2) continue;
      const ts = [dot(sub(b.a, a.a), a.u), dot(sub(b.b, a.a), a.u)].sort(
          (a, b) => a - b,
        ),
        lo = Math.max(0, ts[0]),
        hi = Math.min(a.length, ts[1]);
      if (hi - lo < Math.max(a.length, b.length) * 0.85) continue;
      const centerOffset = cross(a.u, sub(b.a, a.a)) / 2;
      const at = (t: number): AreaPoint => [
        a.a[0] + a.u[0] * t - a.u[1] * centerOffset,
        a.a[1] + a.u[1] * t + a.u[0] * centerOffset,
      ];
      const ends = [at(lo), at(hi)];
      for (const end of ends) {
        const cap = nearbyCaps({ a: end, b: end }, error + depth / 2)
          .sort((a, b) => a - b)
          .map((i) => caps[i])
          .find((c) => {
            if (!work()) return false;
            if (
              Math.abs(dot(c.u, a.u)) * c.length > error ||
              Math.abs(c.length - depth) > error * 2
            )
              return false;
            const offsets = [c.a, c.b]
              .map((p) => cross(a.u, sub(p, end)))
              .sort((a, b) => a - b);
            return (
              offsets[0] <= -depth / 2 + fpp &&
              offsets[1] >= depth / 2 - fpp &&
              distance(mid(c.a, c.b), end) <= error + depth / 2
            );
          }) ?? observedLeafCap(
            nearbyContours({ a: end, b: end }, error + depth / 2 + fpp)
              .sort((a, b) => a - b).map(i => contours[i]),
            end, a.u, depth, error, fpp, work,
          );
        if (cap)
          panels.push({
            a: ends[0],
            b: ends[1],
            length: hi - lo,
            depth,
            ids: [a.id, b.id, cap.id],
            error,
            capped: end,
          });
        if (result.limited) return result;
      }
    }
  result.diagnostics.leaves = panels.length;
  const jambContours = joinRasterContourChunks(contours, work);
  if (result.limited) return result;
  const nearbyJambContours = segmentIndex(jambContours.map(contour => ({
    a: [Math.min(...contour.points.map(p => p[0])), Math.min(...contour.points.map(p => p[1]))] as AreaPoint,
    b: [Math.max(...contour.points.map(p => p[0])), Math.max(...contour.points.map(p => p[1]))] as AreaPoint,
  })));
  const walls = candidateBodies.flatMap((b) => {
    const s = span(feet(b.a), feet(b.b), b.pathIds[0], fpp * 2.5);
    return s ? [{ ...s, depth: b.thicknessFt, ids: b.pathIds, sourceBody:b }] : [];
  });
  const seen = new Set<string>(),
    nearbyWalls = segmentIndex(walls);
  for (let i = 0; i < walls.length; i++)
    for (const j of nearbyWalls(walls[i], 4.5 + fpp * 5).sort(
      (a, b) => a - b,
    )) {
      if (j <= i) continue;
      if (!work()) return result;
      const left = walls[i],
        right = walls[j],
        error = fpp * 5;
      if (
        Math.abs(cross(left.u, right.u)) * Math.min(left.length, right.length) >
          error ||
        Math.abs(left.depth - right.depth) > error
      )
        continue;
      const t = (p: AreaPoint) => dot(sub(p, left.a), left.u),
        d = (p: AreaPoint) => cross(left.u, sub(p, left.a));
      const rs = [t(right.a), t(right.b)].sort((a, b) => a - b);
      let p: AreaPoint, q: AreaPoint;
      if (rs[0] > left.length) {
        p = left.b;
        q = t(right.a) < t(right.b) ? right.a : right.b;
      } else if (rs[1] < 0) {
        p = left.a;
        q = t(right.a) > t(right.b) ? right.a : right.b;
      } else continue;
      const gap = distance(p, q);
      if (gap < 1.5 || gap > 4.5 || Math.abs(d(q)) > error) continue;
      result.diagnostics.hostPairs++;
      const gapU: AreaPoint = [(q[0] - p[0]) / gap, (q[1] - p[1]) / gap],
        depth = (left.depth + right.depth) / 2;
      const selectCap = (end: AreaPoint, facing: number) => {
        const normal = (p: AreaPoint) => cross(gapU, sub(p, end)),
          along = (p: AreaPoint) => dot(sub(p, end), gapU);
        const choices: Array<{
          point: AreaPoint;
          ids: number[];
          segments: Array<{ a: AreaPoint; b: AreaPoint; pathIds: number[] }>;
        }> = [];
        // Clip only actual contour spans to a small end window. Consecutive
        // source segments retain a stepped jamb route; no white gap is joined.
        const clip = (
          a: AreaPoint,
          b: AreaPoint,
        ): [AreaPoint, AreaPoint] | null => {
          let lo = 0,
            hi = 1;
          const da = along(a),
            na = normal(a),
            dd = along(b) - da,
            nd = normal(b) - na;
          for (const [v, d, min, max] of [
            [
              da,
              dd,
              facing > 0 ? -error : -0.25 - error,
              facing > 0 ? 0.25 + error : error,
            ],
            [na, nd, -depth / 2 - error, depth / 2 + error],
          ]) {
            if (Math.abs(d) < 1e-12) {
              if (v < min || v > max) return null;
              continue;
            }
            const ts = [(min - v) / d, (max - v) / d].sort((a, b) => a - b);
            lo = Math.max(lo, ts[0]);
            hi = Math.min(hi, ts[1]);
            if (hi <= lo) return null;
          }
          return [
            [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo],
            [a[0] + (b[0] - a[0]) * hi, a[1] + (b[1] - a[1]) * hi],
          ];
        };
        for (const index of nearbyJambContours(
          { a: end, b: end },
          depth / 2 + 0.25 + error * 2,
        ).sort((a, b) => a - b)) {
          const contour = jambContours[index];
          let route: AreaPoint[] = [], routePaths: number[] = [];
          const emit = () => {
            if (route.length < 2) return;
            if (Math.max(...route.map((p) => along(p) * facing)) < -fpp * 0.5) {
              route = [];
              routePaths = [];
              return;
            }
            const ns = route.map(normal),
              length = route
                .slice(1)
                .reduce((n, p, i) => n + distance(route[i], p), 0);
            if (
              Math.min(...ns) > -depth / 2 + error ||
              Math.max(...ns) < depth / 2 - error ||
              length > depth * 2 + error * 4
            ) {
              route = [];
              routePaths = [];
              return;
            }
            const hits: AreaPoint[] = [];
            for (let i = 1; i < route.length; i++) {
              const a = route[i - 1],
                b = route[i],
                da = normal(a),
                db = normal(b);
              if (da * db > 0 || Math.abs(db - da) < 1e-10) continue;
              const t = -da / (db - da);
              if (t >= 0 && t <= 1)
                hits.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            }
            const point = hits.sort(
              (a, b) => distance(a, end) - distance(b, end),
            )[0];
            if (point)
              choices.push({
                point,
                ids: [...new Set(routePaths)],
                segments: route
                  .slice(1)
                  .map((b, i) => ({ a: route[i], b, pathIds: [routePaths[i]] })),
              });
            route = [];
            routePaths = [];
          };
          let points = contour.points, segmentPathIds = contour.segmentPathIds;
          if (distance(points[0], points.at(-1)!) < 1e-9) {
            const open = points.slice(0, -1),
              start = open.findIndex(
                (p) =>
                  Math.abs(normal(p)) > depth / 2 + error ||
                  along(p) < (facing > 0 ? -error : -0.25 - error) ||
                  along(p) > (facing > 0 ? 0.25 + error : error),
              );
            if (start > 0) {
              points = [...open.slice(start), ...open.slice(0, start + 1)];
              segmentPathIds = [...segmentPathIds.slice(start), ...segmentPathIds.slice(0, start)];
            }
          }
          for (let i = 1; i < points.length; i++) {
            if (!work()) return null;
            const segment = clip(points[i - 1], points[i]);
            if (!segment) {
              emit();
              continue;
            }
            if (route.length && distance(route.at(-1)!, segment[0]) > 1e-8)
              emit();
            if (!route.length) route.push(segment[0]);
            route.push(segment[1]);
            routePaths.push(segmentPathIds[i - 1]);
            if (route.length > 256) {
              route = [];
              routePaths = [];
              continue;
            }
          }
          emit();
        }
        return (
          choices.sort(
            (a, b) => distance(a.point, end) - distance(b.point, end),
          )[0] ?? null
        );
      };
      const capA = selectCap(p, 1),
        capB = selectCap(q, -1);
      if (result.limited) return result;
      if (!capA || !capB) continue;
      result.diagnostics.frames += 2;
      const a = capA.point,
        b = capB.point,
        uncertainty = Math.min(0.1, error);
      const atJamb = (point: AreaPoint, end: AreaPoint) =>
        Math.abs(dot(sub(point, end), gapU)) <= uncertainty &&
        Math.abs(cross(gapU, sub(point, end))) <= depth / 2 + uncertainty;
      for (const arc of arcs) {
        if (!work()) return result;
        const hinge = atJamb(arc.center, a)
          ? a
          : atJamb(arc.center, b)
            ? b
            : null;
        if (!hinge) continue;
        const opposite = hinge === a ? b : a;
        if (!arc.points.some((point) => atJamb(point, opposite))) continue;
        const panel = panels.find((panel) => {
          if (!work()) return false;
          if (
            Math.abs(panel.length - arc.radius) >
            arc.error + panel.error + panel.depth
          )
            return false;
          const near =
              distance(panel.a, arc.center) < distance(panel.b, arc.center)
                ? panel.a
                : panel.b,
            far = near === panel.a ? panel.b : panel.a;
          if (
            distance(near, arc.center) >
            arc.error + panel.error + panel.depth / 2
          )
            return false;
          if (distance(far, panel.capped) > panel.error) return false;
          const leafDirection = sub(far, near);
          if (Math.abs(dot(leafDirection, gapU)) / panel.length > 0.25)
            return false;
          return arc.points.some(
            (point) =>
              distance(point, far) <= arc.error + panel.error + panel.depth / 2,
          );
        });
        if (result.limited) return result;
        if (!panel) continue;
        const signature = [a, b]
          .map((p) => p.map((n) => n.toFixed(4)).join(","))
          .sort()
          .join("|");
        if (seen.has(signature)) continue;
        seen.add(signature);
        const door: VectorLeafDoor = {
          a: norm(p),
          b: norm(q),
          clearSpan: [norm(a), norm(b)],
          leafWidthFt: panel.length,
          widthBasis: "wall-flank-span",
          thicknessFt: depth,
          basis: "raster-swing-leaf",
          sourceUncertaintyFt: uncertainty,
          doorPathIds: [arc.id, ...panel.ids.slice(0, 2)],
          framePathIds: [...new Set([...capA.ids, ...capB.ids, panel.ids[2]])],
          wallPathIds: [...new Set([...left.ids, ...right.ids])],
          wallSpans: [left.sourceBody,right.sourceBody],
          jambs: [...capA.segments, ...capB.segments].map((c) => ({
            a: norm(c.a),
            b: norm(c.b),
            pathIds: c.pathIds,
          })),
        };
        result.doors.push(door);
        result.diagnostics.leafMatches++;
      }
    }
  return result;
}
