import type { RecognitionImageSource } from "./recognition-image-source";
import { z } from "zod";
import {
  flattenEvidencePath,
  evidencePathBounds,
  type AreaEvidence,
  type EvidencePath,
} from "./area-evidence";
import { areaPathRole, type AreaPathRole } from "./area-paths";
import { wallMaterialFootprints } from './vector-wall-material';
import type { AreaRegion, AreaBoundary } from "./area-takeoff";
import type { WallHypothesisBinding } from './wall-hypothesis-semantics';

export const AREA_SEMANTIC_VERSION = 1;
export const architecturalKinds = [
  "wall",
  "door",
  "window",
  "column",
  "fixture",
  "furniture",
  "annotation",
  "unknown",
] as const;
export type ArchitecturalKind = (typeof architecturalKinds)[number];
export interface ArchitecturalElement {
  pathId: number;
  kind: ArchitecturalKind;
  basis: "cad" | "visual" | "unknown";
  /** Evidence provenance, NOT a calibrated correctness probability. */
  observationIds: string[];
  conflict: boolean;
}
export const visualPathSchema = z.object({
  pathIds: z.array(z.number().int().nonnegative()).min(1).max(160),
  kind: z.enum(architecturalKinds),
});
const anchorSchema = z.object({
  pathId: z.number().int().nonnegative(),
  commandIndex: z.number().int().nonnegative(),
});
export const visualOpeningSchema = z.object({
  a: anchorSchema,
  b: anchorSchema,
  doorPathIds: z.array(z.number().int().nonnegative()).min(1).max(8),
});
export const visualWallHypothesisSchema=z.object({hypothesisId:z.string().min(1).max(100),kind:z.enum(['wall','not-wall','unknown'])});
export const visualInterpretationSchema = z.object({
  elements: z.array(visualPathSchema).max(160),
  openings: z.array(visualOpeningSchema).max(40).default([]),
  wallHypotheses: z.array(visualWallHypothesisSchema).max(160).optional(),
});
/** Provider JSON schemas must require every property. Runtime parsing remains
 * backward-compatible with older observations that omitted openings. */
export const visualInterpretationProviderSchema =
  visualInterpretationSchema.omit({wallHypotheses:true}).extend({
    openings: z.array(visualOpeningSchema).max(40),
  });
export const wallHypothesisInterpretationProviderSchema=visualInterpretationProviderSchema.extend({wallHypotheses:z.array(visualWallHypothesisSchema).max(160)});
export interface AreaVisualObservation {
  sourceImage?: RecognitionImageSource;
  /** Original image provenance is retained when exact source facts acquire
   * new extraction IDs. This is continuity evidence, never an accuracy score. */
  sourceReuse?: { version: 1; recordDigest: string; scope: string; priorEvidenceHash: string; currentEvidenceHash: string };
  id: string;
  region: AreaRegion;
  /** IDs actually supplied with this crop. Prevents guesses about unseen paths. */
  suppliedPathIds: number[];
  /** Complete visible context paths, not eligible for role votes in this observation. */
  contextPathIds?: number[];
  elements: z.infer<typeof visualPathSchema>[];
  openings?: z.infer<typeof visualOpeningSchema>[];
  suppliedWallHypotheses?: WallHypothesisBinding[];
  wallHypotheses?: z.infer<typeof visualInterpretationSchema>['wallHypotheses'];
}

/** An opening is a hypothesis anchored to two actual source wall vertices and
 * a nearby source door. Source positions, not model coordinates, form the edge.
 * Reject unsupported endpoints and edges passing through source wall paint.
 * This geometric check is necessary but not a correctness certification. */
export function visualOpeningBoundaries(
  evidence: AreaEvidence,
  observations: AreaVisualObservation[],
  sx: number,
  sy: number,
): AreaBoundary[] {
  const paths = new Map(evidence.paths.map((p) => [p.id, p]));
  const elements = new Map(
    interpretArchitecturalElements(evidence, observations, {sx,sy}).map((e) => [
      e.pathId,
      e,
    ]),
  );
  const result: AreaBoundary[] = [],
    seen = new Set<string>(),
    openingSources: number[][] = [];
  for (const observation of observations)
    for (const opening of observation.openings ?? []) {
      const allowed = new Set([...observation.suppliedPathIds,...(observation.contextPathIds ?? [])]);
      if (observation.contextPathIds?.length && !opening.doorPathIds.some(id=>observation.suppliedPathIds.includes(id))) continue;
      const anchor = (ref: z.infer<typeof anchorSchema>) => {
        const path = paths.get(ref.pathId),
          element = elements.get(ref.pathId),
          c = path?.commands[ref.commandIndex];
        const b = path && evidencePathBounds(path),
          r = observation.region;
        if (
          !allowed.has(ref.pathId) ||
          path?.kind === "clip" ||
          element?.kind !== "wall" ||
          element.conflict ||
          !c ||
          !["M", "L"].includes(c[0]) ||
          path?.dashes.length ||
          !b ||
          b.x0 < r.x0 ||
          b.y0 < r.y0 ||
          b.x1 > r.x1 ||
          b.y1 > r.y1
        )
          return null;
        return [c[1]!, c[2]!] as [number, number];
      };
      const a = anchor(opening.a),
        b = anchor(opening.b);
      if (!a || !b) continue;
      const dx = (b[0] - a[0]) * sx,
        dy = (b[1] - a[1]) * sy,
        length = Math.hypot(dx, dy);
      if (length < 1.5 || length > 12) continue;
      const nearbyDoor = opening.doorPathIds.some((id) => {
        const path = paths.get(id),
          element = elements.get(id),
          bounds = path && evidencePathBounds(path);
        if (
          !allowed.has(id) ||
          element?.kind !== "door" ||
          element.conflict ||
          !bounds
        )
          return false;
        const r = observation.region;
        if (
          bounds.x0 < r.x0 ||
          bounds.y0 < r.y0 ||
          bounds.x1 > r.x1 ||
          bounds.y1 > r.y1
        )
          return false;
        // An open leaf starts at the hinge, not at the middle of its threshold.
        // Require physical leaf/swing extent and contact at a proposed jamb.
        const extent = Math.hypot(
          (bounds.x1 - bounds.x0) * sx,
          (bounds.y1 - bounds.y0) * sy,
        );
        return (
          extent >= length * 0.45 &&
          [a, b].some(
            (p) =>
              p[0] >= bounds.x0 - 0.15 / sx &&
              p[0] <= bounds.x1 + 0.15 / sx &&
              p[1] >= bounds.y0 - 0.15 / sy &&
              p[1] <= bounds.y1 + 0.15 / sy,
          )
        );
      });
      if (!nearbyDoor) continue;
      const key = [a, b]
        .map((p) => p.join(","))
        .sort()
        .join("|");
      if (seen.has(key)) continue;
      // Do not add a threshold coincident with an existing wall face. Intersections
      // strictly inside a wall segment also indicate an unsupported interpretation.
      let crossesWall = false;
      for (const path of evidence.paths) {
        if (elements.get(path.id)?.kind !== "wall" || path.kind === "clip")
          continue;
        for (const line of flattenEvidencePath(path))
          for (let i = 1; i < line.length; i++) {
            const previous = line[i - 1],
              next = line[i];
            const px = (previous[0] - a[0]) * sx,
              py = (previous[1] - a[1]) * sy;
            const ex = (next[0] - previous[0]) * sx,
              ey = (next[1] - previous[1]) * sy;
            const determinant = dx * ey - dy * ex;
            if (Math.abs(determinant) > 1e-9) {
              const t = (px * ey - py * ex) / determinant,
                u = (px * dy - py * dx) / determinant;
              if (
                t > 0.02 / length &&
                t < 1 - 0.02 / length &&
                u >= 0 &&
                u <= 1
              )
                crossesWall = true;
            } else if (Math.abs(px * dy - py * dx) / length < 0.01) {
              const t0 = (px * dx + py * dy) / (length * length),
                t1 = ((px + ex) * dx + (py + ey) * dy) / (length * length);
              if (
                Math.min(1, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)) >
                0.02 / length
              )
                crossesWall = true;
            }
          }
      }
      if (!crossesWall) {
        // Two crops can choose opposite faces of the same wall opening. Keeping
        // both would turn the traversable doorway footprint into a false void.
        const sameOpening = result.findIndex((edge, index) => {
          if (
            !openingSources[index].some((id) =>
              opening.doorPathIds.includes(id),
            )
          )
            return false;
          const ex = (edge.b[0] - edge.a[0]) * sx,
            ey = (edge.b[1] - edge.a[1]) * sy,
            otherLength = Math.hypot(ex, ey);
          if (
            Math.abs(ex * dy - ey * dx) > 0.01 * otherLength * length ||
            Math.abs(otherLength - length) > 0.15
          )
            return false;
          const distance = (p: [number, number], q: [number, number]) =>
            Math.hypot((p[0] - q[0]) * sx, (p[1] - q[1]) * sy);
          return (
            Math.min(
              Math.max(distance(a, edge.a), distance(b, edge.b)),
              Math.max(distance(a, edge.b), distance(b, edge.a)),
            ) <= 1.5
          );
        });
        const edge: AreaBoundary = {
          a,
          b,
          source: "doorway",
          observationId: observation.id,
        };
        if (sameOpening >= 0) {
          const previous = result[sameOpening],
            oldKey = [previous.a, previous.b]
              .map((p) => p.join(","))
              .sort()
              .join("|");
          if (key < oldKey) result[sameOpening] = edge;
          openingSources[sameOpening] = [
            ...new Set([
              ...openingSources[sameOpening],
              ...opening.doorPathIds,
            ]),
          ];
        } else {
          result.push(edge);
          openingSources.push(opening.doorPathIds);
        }
        seen.add(key);
      }
    }
  return result;
}

export function cadArchitecturalKind(path: EvidencePath): ArchitecturalKind {
  const role = areaPathRole(path);
  const words = path.layer
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  if (role === "structure") {
    if (words.some((w) => ["wall", "walls"].includes(w))) return "wall";
    if (words.some((w) => ["column", "columns", "cols"].includes(w)))
      return "column";
    if (words.some((w) => ["door", "doors"].includes(w))) return "door";
    return "window";
  }
  if (role === "fixture") return "fixture";
  if (role === "decoration")
    return words.some((w) =>
      [
        "furniture",
        "furn",
        "cabinet",
        "cabinetry",
        "casework",
        "millwork",
      ].includes(w),
    )
      ? "furniture"
      : "annotation";
  return "unknown";
}

export function architecturalRole(kind: ArchitecturalKind): AreaPathRole {
  if (["wall", "door", "window", "column"].includes(kind)) return "structure";
  if (kind === "fixture") return "fixture";
  if (kind === "furniture" || kind === "annotation") return "decoration";
  return "unknown";
}

/** All observations refer to immutable source geometry. Conflicting visual
 * votes leave the original role intact. Explicit CAD evidence is never silently
 * overwritten. A model's self-reported confidence is intentionally not accepted. */
export function interpretArchitecturalElements(
  evidence: AreaEvidence | null | undefined,
  observations: AreaVisualObservation[] = [],
  physicalScale?: {sx: number; sy: number},
): ArchitecturalElement[] {
  const materials = physicalScale ? wallMaterialFootprints(evidence, physicalScale.sx, physicalScale.sy) : new Map();
  const votes = new Map<
    number,
    Array<{ kind: ArchitecturalKind; id: string }>
  >();
  const paths = new Map(evidence?.paths.map((p) => [p.id, p]) ?? []);
  for (const observation of observations) {
    const supplied = new Set(observation.suppliedPathIds);
    for (const element of observation.elements)
      for (const id of element.pathIds) {
        const path = paths.get(id),
          b = path && evidencePathBounds(path),
          r = observation.region;
        if (
          !supplied.has(id) ||
          !path ||
          path.kind === "clip" ||
          !b ||
          element.kind === "unknown" ||
          b.x0 < r.x0 - 1e-8 ||
          b.y0 < r.y0 - 1e-8 ||
          b.x1 > r.x1 + 1e-8 ||
          b.y1 > r.y1 + 1e-8
        )
          continue;
        const entries = votes.get(id) ?? [];
        entries.push({ kind: element.kind, id: observation.id });
        votes.set(id, entries);
      }
  }
  return [...paths.values()].map((path) => {
    const cad = materials.has(path.id) ? 'wall' as const : cadArchitecturalKind(path),
      entries = votes.get(path.id) ?? [];
    const kinds = new Set(entries.map((e) => e.kind));
    const conflict =
      kinds.size > 1 ||
      (cad !== "unknown" && entries.some((e) => e.kind !== cad));
    const visual = cad === "unknown" && !conflict && kinds.size === 1;
    return {
      pathId: path.id,
      kind: visual ? entries[0].kind : cad,
      basis: visual ? "visual" : cad === "unknown" ? "unknown" : "cad",
      observationIds: [...new Set(entries.map((e) => e.id))].sort(),
      conflict,
    };
  });
}

/** A bounded catalogue in crop coordinates. Only complete paths are offered;
 * long cross-crop strokes cannot be classified using an incomplete view. */
export function visualPathCatalogue(
  evidence: AreaEvidence,
  region: AreaRegion,
  maximum = 160,
  physicalScale?: {sx:number;sy:number},
) {
  const materials = physicalScale ? wallMaterialFootprints(evidence,physicalScale.sx,physicalScale.sy) : new Map();
  return evidence.paths
    .flatMap((path) => {
      if (
        path.kind === "clip" ||
        path.opacity < 0.5 ||
        path.commands.length > 80
      )
        return [];
      const b = evidencePathBounds(path);
      if (
        !b ||
        b.x0 < region.x0 ||
        b.y0 < region.y0 ||
        b.x1 > region.x1 ||
        b.y1 > region.y1
      )
        return [];
      const normalize = (n: number, axis: number) =>
        Math.round(
          ((n - (axis ? region.y0 : region.x0)) /
            (axis ? region.y1 - region.y0 : region.x1 - region.x0)) *
            10000,
        ) / 10000;
      return [
        {
          id: path.id,
          ...(path.rasterFeature ? { geometryHint: path.rasterFeature } : {}),
          prior: materials.has(path.id) ? 'wall' as const : cadArchitecturalKind(path),
          kind: path.kind,
          bounds: [
            normalize(b.x0, 0),
            normalize(b.y0, 1),
            normalize(b.x1, 0),
            normalize(b.y1, 1),
          ],
          commands: path.commands.map((c) => [
            c[0],
            ...c.slice(1).map((n, i) => normalize(n as number, i % 2)),
          ]),
          extent: Math.hypot(b.x1 - b.x0, b.y1 - b.y0),
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(a.prior !== "unknown") - Number(b.prior !== "unknown") ||
        b.extent - a.extent ||
        a.id - b.id,
    )
    .slice(0, maximum)
    .map(({ extent: _extent, ...path }) => path);
}
