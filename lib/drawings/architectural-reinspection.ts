import type { AreaInput } from "./area-takeoff";
import type { AreaArchitecture } from "./area-architecture";
import type { AreaRecognizer, AreaRecognitionRequest } from "./area-engine";
import { evidencePathBounds, flattenEvidencePath, type AreaPoint } from "./area-evidence";
import { measuredWindowHosts } from "./building-window-hosts";
import { windowFloorBoundaries } from "./area-windows";
import {
  interpretArchitecturalElements,
  visualInterpretationSchema,
  visualPathCatalogue,
  type ArchitecturalKind,
  type AreaVisualObservation,
} from "./area-semantics";

export interface ArchitecturalReinspectionTarget {
  reason: "window-host-missing" | "window-candidate";
  spaceId?: string;
  request: AreaRecognitionRequest;
}

/** Ask about measured candidate faces, without telling the classifier which
 * label would make the reconstruction succeed. Never manufacture new paths. */
export function planArchitecturalReinspection(
  input: AreaInput,
  architecture: AreaArchitecture,
): ArchitecturalReinspectionTarget[] {
  const evidence = input.evidence;
  if (!evidence) return [];
  const sx = input.imageWidth * input.feetPerImagePx,
    sy = input.imageHeight * input.feetPerImagePx;
  if (!(sx > 0 && sy > 0 && Number.isFinite(sx) && Number.isFinite(sy))) return [];
  const paths = new Map(evidence.paths.map(p => [p.id, p]));
  const seen = new Set<string>();
  const hosts = measuredWindowHosts(input, architecture, { includeReinspection: true }).flatMap(candidate => {
    if (candidate.host || !candidate.reinspectionPathIds.length) return [];
    const ids = new Set(candidate.reinspectionPathIds);
    const bounds = [...ids].flatMap(id => {
      const path = paths.get(id), bounds = path && evidencePathBounds(path);
      return bounds ? [bounds] : [];
    });
    if (!bounds.length || ids.size > 16) return [];
    const { a, b } = candidate.boundary;
    const region = {
      x0: Math.max(input.region.x0, Math.min(a[0], b[0], ...bounds.map(b => b.x0)) - 1 / sx),
      y0: Math.max(input.region.y0, Math.min(a[1], b[1], ...bounds.map(b => b.y0)) - 1 / sy),
      x1: Math.min(input.region.x1, Math.max(a[0], b[0], ...bounds.map(b => b.x1)) + 1 / sx),
      y1: Math.min(input.region.y1, Math.max(a[1], b[1], ...bounds.map(b => b.y1)) + 1 / sy),
    };
    if (region.x1 <= region.x0 || region.y1 <= region.y0) return [];
    const catalogue = visualPathCatalogue(evidence, region, Infinity, {sx,sy}).filter(p => ids.has(p.id));
    // Partial candidate pairs give misleading context. Leave them unresolved.
    if (catalogue.length !== ids.size) return [];
    const key = JSON.stringify([region, [...ids].sort((a, b) => a - b)]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ reason: "window-host-missing" as const, spaceId: candidate.spaceId, request: { region, catalogue } }];
  });
  return [...hosts, ...planWindowCandidateReinspection(input)];
}

/** A room may not exist yet because pane linework was called fixture/unknown.
 * Paired strokes between returning wall tips warrant inspection, not automatic
 * promotion to a window. Reuse the exact closure geometry checks as a probe. */
function planWindowCandidateReinspection(input: AreaInput): ArchitecturalReinspectionTarget[] {
  const evidence = input.evidence;
  if (!evidence?.raster) return [];
  const sx = input.imageWidth * input.feetPerImagePx, sy = input.imageHeight * input.feetPerImagePx;
  const elements = new Map(interpretArchitecturalElements(evidence, input.visualObservations, {sx:input.imageWidth*input.feetPerImagePx,sy:input.imageHeight*input.feetPerImagePx}).map(e => [e.pathId, e]));
  const paths = evidence.paths.filter(p => {
    const b = evidencePathBounds(p), r = input.region;
    return b && p.kind !== "clip" && !p.clips.length && !p.dashes.length && p.opacity >= .5 && b.x0 >= r.x0 && b.x1 <= r.x1 && b.y0 >= r.y0 && b.y1 <= r.y1;
  });
  const feet = (p: AreaPoint): AreaPoint => [p[0] * sx, p[1] * sy];
  const edges = paths.flatMap(p => flattenEvidencePath(p).flatMap(r => r.slice(1).map((b, i) => ({ a: feet(r[i]), b: feet(b), pathId: p.id, source: "drawn" as const }))));
  const probeKinds = new Map(paths.map(p => {
    const e = elements.get(p.id)!;
    return [p.id, !e.conflict && e.kind === "wall" ? "wall" : e.basis === "cad" ? e.kind : "window"] as const;
  }));
  const candidates = windowFloorBoundaries(edges, probeKinds, evidence.raster.feetPerPixel * 2);
  const seen = new Set<string>();
  return candidates.flatMap(boundary => {
    const dx = boundary.b[0] - boundary.a[0], dy = boundary.b[1] - boundary.a[1], length = Math.hypot(dx, dy), u: AreaPoint = [dx / length, dy / length];
    const project = (p: AreaPoint) => (p[0] - boundary.a[0]) * u[0] + (p[1] - boundary.a[1]) * u[1];
    const normal = (p: AreaPoint) => (p[0] - boundary.a[0]) * u[1] - (p[1] - boundary.a[1]) * u[0];
    const ids = new Set(edges.filter(e => {
      if (probeKinds.get(e.pathId) !== "window") return false;
      const span = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]), ts = [project(e.a), project(e.b)].sort((a, b) => a - b);
      return span >= 1.5 && Math.abs(normal(e.a) - normal(e.b)) <= span * .02 && Math.abs(normal(e.a)) <= 1.5 && ts[0] >= -.1 && ts[1] <= length + .1 && ts[1] - ts[0] >= length * .6;
    }).map(e => e.pathId));
    if (!ids.size || ids.size > 16 || [...ids].every(id => elements.get(id)?.kind === "window" && !elements.get(id)?.conflict)) return [];
    const bounds = paths.filter(p => ids.has(p.id)).map(p => evidencePathBounds(p)!);
    const region = {
      x0: Math.max(input.region.x0, Math.min(boundary.a[0] / sx, boundary.b[0] / sx, ...bounds.map(b => b.x0)) - 1 / sx),
      y0: Math.max(input.region.y0, Math.min(boundary.a[1] / sy, boundary.b[1] / sy, ...bounds.map(b => b.y0)) - 1 / sy),
      x1: Math.min(input.region.x1, Math.max(boundary.a[0] / sx, boundary.b[0] / sx, ...bounds.map(b => b.x1)) + 1 / sx),
      y1: Math.min(input.region.y1, Math.max(boundary.a[1] / sy, boundary.b[1] / sy, ...bounds.map(b => b.y1)) + 1 / sy),
    };
    const catalogue = visualPathCatalogue(evidence, region, Infinity, {sx,sy}).filter(p => ids.has(p.id));
    if (catalogue.length !== ids.size) return [];
    const key = [...ids].sort((a, b) => a - b).join(",");
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ reason: "window-candidate" as const, request: { region, catalogue } }];
  });
}

export interface ArchitecturalReinspection {
  qualification: "unqualified-alternative";
  attempts: Array<{
    target: ArchitecturalReinspectionTarget;
    status: "answered" | "unavailable" | "budget-exhausted";
    observation?: AreaVisualObservation;
  }>;
  changes: Array<{
    pathId: number;
    before: ArchitecturalKind;
    proposed: ArchitecturalKind;
    contradictsPrior: boolean;
    priorObservationIds: string[];
    observationIds: string[];
  }>;
}

/** Diagnostic-only repair proposals. Results are never merged into accepted
 * source classifications here. A narrow crop may be wrong too. */
export async function reinspectArchitecture(
  input: AreaInput,
  architecture: AreaArchitecture,
  recognize: AreaRecognizer,
  maxRequests = 2,
): Promise<ArchitecturalReinspection> {
  if (!Number.isInteger(maxRequests) || maxRequests < 0 || maxRequests > 4)
    throw new Error("Reinspection request budget must be an integer from 0 to 4.");
  const report: ArchitecturalReinspection = { qualification: "unqualified-alternative", attempts: [], changes: [] };
  const occupied = new Set(input.visualObservations?.map(o => o.id));
  let calls = 0, sequence = 0;
  for (const target of planArchitecturalReinspection(input, architecture)) {
    const attempt: ArchitecturalReinspection["attempts"][number] = { target, status: "unavailable" };
    report.attempts.push(attempt);
    try {
      const cached = await recognize.cached?.(target.request).catch(() => null);
      let parsed = visualInterpretationSchema.safeParse(cached);
      if (!parsed.success || !parsed.data.elements.length) {
        if (calls >= maxRequests) { attempt.status = "budget-exhausted"; continue; }
        calls++;
        parsed = visualInterpretationSchema.safeParse(await recognize(target.request));
      }
      if (!parsed.success || !parsed.data.elements.length) continue;
      let id: string;
      do { id = `reinspection-${++sequence}`; } while (occupied.has(id));
      occupied.add(id);
      attempt.observation = {
        id, region: target.request.region,
        suppliedPathIds: target.request.catalogue.map(p => p.id),
        elements: parsed.data.elements,
        // This pass only rechecks classification, not doorway creation.
        openings: [],
      };
      attempt.status = "answered";
    } catch { /* Preserve remaining targets and the unchanged baseline. */ }
  }
  const observations = report.attempts.flatMap(a => a.observation ? [a.observation] : []);
  const original = new Map(interpretArchitecturalElements(input.evidence, input.visualObservations, {sx:input.imageWidth*input.feetPerImagePx,sy:input.imageHeight*input.feetPerImagePx}).map(e => [e.pathId, e]));
  for (const proposed of interpretArchitecturalElements(input.evidence, observations, {sx:input.imageWidth*input.feetPerImagePx,sy:input.imageHeight*input.feetPerImagePx})) {
    const before = original.get(proposed.pathId)!;
    if (proposed.basis !== "visual" || proposed.conflict || proposed.kind === "unknown" || before.basis === "cad") continue;
    if (before.kind === proposed.kind && !before.conflict) continue;
    report.changes.push({
      pathId: proposed.pathId, before: before.kind, proposed: proposed.kind,
      contradictsPrior: before.kind !== "unknown" || before.conflict,
      priorObservationIds: before.observationIds, observationIds: proposed.observationIds,
    });
  }
  return report;
}

/** Construct an isolated hypothesis for replay/measurement comparison. Keep
 * the original input and the complete report alongside it; never persist this
 * as a user-approved interpretation or call it independent ground truth. */
export function reinspectionAlternative(input: AreaInput, report: ArchitecturalReinspection): AreaInput {
  const replaced = new Set(report.changes.map(c => c.pathId));
  const originals = (input.visualObservations ?? []).map(o => ({
    ...o,
    elements: o.elements.map(e => ({ ...e, pathIds: e.pathIds.filter(id => !replaced.has(id)) })).filter(e => e.pathIds.length),
    openings: o.openings?.filter(e => ![e.a.pathId, e.b.pathId, ...e.doorPathIds].some(id => replaced.has(id))),
  }));
  const focused = report.attempts.flatMap(a => a.observation ? [{
    ...a.observation,
    elements: a.observation.elements.map(e => ({ ...e, pathIds: e.pathIds.filter(id => replaced.has(id)) })).filter(e => e.pathIds.length),
    openings: [],
  }] : []);
  return { ...input, visualObservations: [...originals, ...focused] };
}
