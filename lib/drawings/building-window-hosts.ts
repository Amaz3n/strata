import { containsPoint, type AreaInput } from './area-takeoff';
import type { AreaArchitecture } from './area-architecture';
import { flattenEvidencePath, type AreaPoint } from './area-evidence';
import { interpretArchitecturalElements } from './area-semantics';

/** Recover the body under a supported window from measured exterior pier
 * faces. Never use pane depth or a default wall thickness as the missing face. */
export function measuredWindowHosts(input: AreaInput, architecture: AreaArchitecture, options: { includeReinspection?: boolean } = {}) {
  if (!architecture.spaces.some(space => space.sourceBoundaries?.some(b => b.source === 'window'))) return [];
  const sx = input.imageWidth * input.feetPerImagePx, sy = input.imageHeight * input.feetPerImagePx;
  const feet = (p: AreaPoint): AreaPoint => [p[0] * sx, p[1] * sy], norm = (p: AreaPoint): AreaPoint => [p[0] / sx, p[1] / sy];
  const elements = new Map(interpretArchitecturalElements(input.evidence, input.visualObservations, {sx:input.imageWidth*input.feetPerImagePx,sy:input.imageHeight*input.feetPerImagePx}).map(e => [e.pathId, e]));
  const paths = new Map(input.evidence?.paths.map(p => [p.id, p]) ?? []);
  const outerFaces = [...paths.values()].flatMap(p => {
    const kind = elements.get(p.id);
    if (p.kind === 'clip' || p.clips.length || p.dashes.length || p.opacity < .5) return [];
    const structural = !!kind && !kind.conflict && ['wall', 'column'].includes(kind.kind);
    if (!structural && !options.includeReinspection) return [];
    return flattenEvidencePath(p).flatMap(r => r.slice(1).map((b, i) => ({ a: feet(r[i]), b: feet(b), id: p.id, structural })));
  });
  return architecture.spaces.flatMap(space => (space.sourceBoundaries ?? []).filter(b => b.source === 'window').map(boundary => {
    const a = feet(boundary.a), b = feet(boundary.b), length = Math.hypot(b[0] - a[0], b[1] - a[1]), u: AreaPoint = [(b[0] - a[0]) / length, (b[1] - a[1]) / length], n: AreaPoint = [-u[1], u[0]];
    const project = (p: AreaPoint) => (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
    const offset = (p: AreaPoint) => (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1];
    const at = (t: number, d: number): AreaPoint => [a[0] + u[0] * t + n[0] * d, a[1] + u[1] * t + n[1] * d];
    const inside = (side: number) => {
      const p = norm(at(length / 2, side * .05));
      return containsPoint(p, space.points) && !space.holes.some(h => containsPoint(p, h));
    };
    const side = inside(1) && !inside(-1) ? -1 : inside(-1) && !inside(1) ? 1 : 0;
    const element = boundary.pathId === undefined ? undefined : elements.get(boundary.pathId);
    const path = element?.kind === 'window' && !element.conflict && boundary.pathId !== undefined ? paths.get(boundary.pathId) : undefined;
    const pane = path && flattenEvidencePath(path).flatMap(r => r.slice(1).map((end, i) => {
      const start = feet(r[i]), b = feet(end), span = Math.hypot(b[0] - start[0], b[1] - start[1]);
      return { start: Math.min(project(start), project(b)), end: Math.max(project(start), project(b)), offset: offset(start), span, normalDrift: Math.abs(offset(b) - offset(start)) };
    })).filter(p => p.span >= 1.5 && p.normalDrift <= p.span * .02 && p.start >= -.1 && p.end <= length + .1).sort((a, b) => b.span - a.span)[0];
    const unresolved = { boundary, spaceId: space.id, host: null, reinspectionPathIds: [] as number[] };
    if (!side || !pane || pane.offset * side < -.02) return unresolved;
    const candidates = outerFaces.flatMap(face => {
      const span = Math.hypot(face.b[0] - face.a[0], face.b[1] - face.a[1]), depth = offset(face.a) * side;
      if (span < .25 || depth < .2 || depth > 1.5 || depth < pane.offset * side + .02 || Math.abs(offset(face.b) - offset(face.a)) > span * .015) return [];
      return [{ ...face, depth, start: Math.min(project(face.a), project(face.b)), end: Math.max(project(face.a), project(face.b)) }];
    });
    const pairs = candidates.filter(p => p.start < pane.start && p.end >= pane.start - 1).flatMap(before => candidates.filter(after => after.end > pane.end && after.start <= pane.end + 1 && Math.abs(before.depth - after.depth) <= .04).map(after => ({ before, after, depth: (before.depth + after.depth) / 2 }))).sort((a, b) => a.depth - b.depth);
    const pair = pairs.find(p => p.before.structural && p.after.structural);
    // Geometry can suggest which source paths merit a closer look; it cannot
    // turn an annotation or unknown path into a measured structural face.
    if (!pair) return { ...unresolved, reinspectionPathIds: [...new Set(pairs.flatMap(p => [p.before, p.after].filter(f => !f.structural).map(f => f.id)))].sort((a, b) => a - b) };
    const depth = pair.depth, pathIds = [...new Set([boundary.pathId!, pair.before.id, pair.after.id])];
    return { boundary, spaceId: space.id, reinspectionPathIds: [], host: { a: norm(at(0, side * depth / 2)), b: norm(at(length, side * depth / 2)), thicknessFt: depth, pathIds,
      offsetFt: Math.max(0, pane.start), widthFt: Math.min(length, pane.end) - Math.max(0, pane.start) } };
  }));
}
