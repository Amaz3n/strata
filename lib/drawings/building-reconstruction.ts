import { validRecognitionImageSource, type RecognitionImageSource } from "./recognition-image-source";
/** Source-backed building reconstruction. Coordinates remain in the original
 * normalized sheet frame; quantities and 3D are projections of this document. */
import type { AreaArchitecture } from "./area-architecture";
import { flattenEvidencePath, evidencePathBounds, type AreaPoint } from "./area-evidence";
import { geometricStructureIds } from "./area-structure";
import { wallMaterialFootprints } from './vector-wall-material';
import { sourceWallNetwork, withDoorCorroboratedFlanks } from "./vector-wall-network";
import type { VectorLeafDoor } from './vector-leaf-doors';
import { validRasterGeometryTiling, type RasterGeometryTiling } from "./raster-geometry-tiles";
import { validRasterContext, type RasterContextEvidence } from "./raster-context";
import { sourceLeafDoors } from './source-leaf-doors';
import { reconcileMeasuredWallBodies } from './wall-body-reconciliation';
import { groupSourceAssemblyReviews } from './reconstruction-review-groups';
import { areasOverlap, containsPoint, type AreaInput } from "./area-takeoff";
import { interpretArchitecturalElements } from "./area-semantics";
import { segmentIndex } from "./segment-index";
import { measuredWindowHosts } from "./building-window-hosts";
import { measuredJambWindowHosts } from "./window-jamb-hosts";
import { unrepresentedWindows } from "./building-window-coverage";
import { alignRasterWallRun } from "./raster-wall-alignment";
import { rasterWindowAssemblies } from "./raster-window-assemblies";
import { rasterSourceFaces } from './raster-source-faces';
import type { OpeningWidthBasis } from "./opening-dimensions";
import { reconcileWindowScheduleTags, type WindowScheduleAssociation, type UnmatchedWindowScheduleTag } from "./window-schedule-matching";

export const BUILDING_RECONSTRUCTION_VERSION = 1;
export interface BuildingWall {
  id: string;
  a: AreaPoint;
  b: AreaPoint;
  thicknessFt: number;
  pathIds: number[];
  basis: "paired-faces" | "opening-host";
  roomIds: string[];
}
export interface BuildingOpening {
  id: string;
  wallId: string;
  kind: "door" | "window" | "cased";
  offsetFt: number;
  widthFt: number;
  widthBasis?: OpeningWidthBasis;
  clearWidthFt?: number;
  leafWidthFt?: number;
  pathIds: number[];
  spaceIds: string[];
  style?: "garage" | "sliding";
}
export interface ReconstructionIssue {
  id: string;
  code: string;
  message: string;
  severity: "error" | "review";
  pathIds: number[];
  point?: AreaPoint;
  objectId?: string;
  members?: Array<{id:string;message:string;point?:AreaPoint}>;
}
export interface BuildingReconstruction {
  scheduleAssociations?: WindowScheduleAssociation[];
  unmatchedScheduleTags?: UnmatchedWindowScheduleTag[];
  version: typeof BUILDING_RECONSTRUCTION_VERSION;
  walls: BuildingWall[];
  openings: BuildingOpening[];
  issues: ReconstructionIssue[];
  source: {
    kind?: "vector" | "raster";
    rasterContext?: RasterContextEvidence;
    rasterTiling?: RasterGeometryTiling;
    recognitionImages?: Array<{observationId:string;image:RecognitionImageSource}>;
    wallPathCount: number;
    representedWallPathCount: number;
    excludedPathCount: number;
  };
  status: "needs-review" | "incomplete";
}
interface Line {
  a: AreaPoint;
  b: AreaPoint;
  ux: number;
  uy: number;
  nx: number;
  ny: number;
  offset: number;
  start: number;
  end: number;
  ids: number[];
}
const dot = (a: AreaPoint, b: AreaPoint) => a[0] * b[0] + a[1] * b[1];
const dist = (a: AreaPoint, b: AreaPoint) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]);
const at = (l: Line, t: number, offset = l.offset): AreaPoint => [
  l.ux * t + l.nx * offset,
  l.uy * t + l.ny * offset,
];
function line(a: AreaPoint, b: AreaPoint, ids: number[]): Line | null {
  const length = dist(a, b);
  if (length < 0.04) return null;
  let ux = (b[0] - a[0]) / length,
    uy = (b[1] - a[1]) / length;
  if (ux < -0.000001 || (Math.abs(ux) < 0.000001 && uy < 0)) {
    ux = -ux;
    uy = -uy;
  }
  const nx = -uy,
    ny = ux,
    s = dot(a, [ux, uy]),
    e = dot(b, [ux, uy]);
  return {
    a,
    b,
    ux,
    uy,
    nx,
    ny,
    offset: dot(a, [nx, ny]),
    start: Math.min(s, e),
    end: Math.max(s, e),
    ids,
  };
}
const parallel = (a: Line, b: Line) =>
  Math.abs(a.ux * b.uy - a.uy * b.ux) < 0.006;
const key = (p: AreaPoint) => p.map((v) => v.toFixed(6)).join(",");
const identity = (prefix: string, a: AreaPoint, b: AreaPoint) =>
  `${prefix}:${[key(a), key(b)].sort().join(":")}`;
function clipped(
  a: AreaPoint,
  b: AreaPoint,
  r: AreaInput["region"],
): [AreaPoint, AreaPoint] | null {
  let lo = 0,
    hi = 1;
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  for (const [p, q] of [
    [-dx, a[0] - r.x0],
    [dx, r.x1 - a[0]],
    [-dy, a[1] - r.y0],
    [dy, r.y1 - a[1]],
  ]) {
    if (Math.abs(p) < 1e-14) {
      if (q < 0) return null;
      continue;
    }
    if (p < 0) lo = Math.max(lo, q / p);
    else hi = Math.min(hi, q / p);
    if (lo > hi) return null;
  }
  return [
    [a[0] + dx * lo, a[1] + dy * lo],
    [a[0] + dx * hi, a[1] + dy * hi],
  ];
}
/** Clip all supported convex PDF masks, including geometry on a clip edge.
 * Reject non-convex masks explicitly instead of dropping arbitrary wall ends. */
function isConvex(points: AreaPoint[]): boolean {
  const ring =
    points.length > 1 && dist(points[0], points.at(-1)!) < 1e-10
      ? points.slice(0, -1)
      : points;
  if (ring.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length],
      c = ring[(i + 2) % ring.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-12) continue;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return sign !== 0;
}
function clipSegmentToConvexPolygon(
  a: AreaPoint,
  b: AreaPoint,
  points: AreaPoint[],
): [AreaPoint, AreaPoint] | null {
  const ring =
    dist(points[0], points.at(-1)!) < 1e-10 ? points.slice(0, -1) : points;
  const orientation = Math.sign(
    ring.reduce(
      (sum, p, i) =>
        sum +
        p[0] * ring[(i + 1) % ring.length][1] -
        p[1] * ring[(i + 1) % ring.length][0],
      0,
    ),
  );
  let lo = 0,
    hi = 1;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i],
      q = ring[(i + 1) % ring.length],
      dx = q[0] - p[0],
      dy = q[1] - p[1];
    const start = orientation * (dx * (a[1] - p[1]) - dy * (a[0] - p[0]));
    const rate = orientation * (dx * (b[1] - a[1]) - dy * (b[0] - a[0]));
    if (Math.abs(rate) < 1e-14) {
      if (start < -1e-10) return null;
      continue;
    }
    const t = -start / rate;
    if (rate > 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
    if (lo > hi) return null;
  }
  return [
    [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo],
    [a[0] + (b[0] - a[0]) * hi, a[1] + (b[1] - a[1]) * hi],
  ];
}
/** Coalesce fragments on an identical source line, never bridge a room-sized gap. */
function fuse(lines: Line[], gap = 0.025): Line[] {
  const result: Line[] = [];
  for (const current of [...lines].sort(
    (a, b) => a.offset - b.offset || a.start - b.start,
  )) {
    const found = result.find(
      (l) => {
        const range = [dot(current.a, [l.ux, l.uy]), dot(current.b, [l.ux, l.uy])].sort((a, b) => a - b);
        return parallel(l, current) &&
          Math.max(Math.abs(dot(current.a, [l.nx, l.ny]) - l.offset), Math.abs(dot(current.b, [l.nx, l.ny]) - l.offset)) < 0.018 &&
          Math.max(l.start, range[0]) <= Math.min(l.end, range[1]) + gap;
      },
    );
    if (!found) {
      result.push({ ...current, ids: [...current.ids] });
      continue;
    }
    const range = [dot(current.a, [found.ux, found.uy]), dot(current.b, [found.ux, found.uy])].sort((a, b) => a - b);
    found.start = Math.min(found.start, range[0]);
    found.end = Math.max(found.end, range[1]);
    found.a = at(found, found.start);
    found.b = at(found, found.end);
    found.ids = [...new Set([...found.ids, ...current.ids])];
  }
  return result;
}

export function reconstructBuilding(
  input: AreaInput,
  architecture: AreaArchitecture,
): BuildingReconstruction {
  const sx = input.imageWidth * input.feetPerImagePx,
    sy = input.imageHeight * input.feetPerImagePx;
  const feet = ([x, y]: AreaPoint): AreaPoint => [x * sx, y * sy],
    norm = ([x, y]: AreaPoint): AreaPoint => [x / sx, y / sy];
  const issues: ReconstructionIssue[] = [],
    wallLines: Line[] = [],
    windowLines: Line[] = [],
    doorPanels: Line[] = [];
  for(const [index,conflict] of (architecture.conflicts??[]).entries()){
    const spaces=architecture.spaces.filter(s=>conflict.selectedIds.includes(s.proposalId));
    const first=spaces[0];
    const point=first?.points.length?[first.points.reduce((n,p)=>n+p[0],0)/first.points.length,first.points.reduce((n,p)=>n+p[1],0)/first.points.length] as AreaPoint:undefined;
    issues.push({id:`floor-interpretation-conflict:${index}`,code:'floor-boundary-interpretations',severity:'review',pathIds:[...new Set(spaces.flatMap(s=>s.sourceBoundaries.filter(b=>b.pathId!==undefined).map(b=>b.pathId!)))],point,objectId:first?.id,message:'Competing source floor-boundary interpretations remain. Review the original partitions, fixtures and voids against the retained takeoff alternatives before accepting this 3D room.'});
  }
  const elements = interpretArchitecturalElements(
    input.evidence,
    input.visualObservations,
    {sx,sy},
  );
  const materials = wallMaterialFootprints(input.evidence,sx,sy);
  const kinds = new Map(elements.map((e) => [e.pathId, e]));
  const roomFaces = architecture.spaces.flatMap((s) =>
    (s.sourceBoundaries ?? []).flatMap((b) => {
      if (b.source !== "drawn" || b.pathId === undefined) return [];
      const kind = kinds.get(b.pathId);
      if (kind?.conflict || !["unknown", "wall"].includes(kind?.kind ?? "unknown")) return [];
      const face = line(feet(b.a), feet(b.b), [b.pathId]);
      return face ? [face] : [];
    }),
  );
  const nearRoomFaces = segmentIndex(roomFaces);
  const inferredSource = new Set<number>();
  const raster = input.evidence?.raster;
  const rasterTiling=raster?.tiling && validRasterGeometryTiling(raster.tiling,raster.tiling.requestedRegion)?raster.tiling:undefined;
  if(raster?.tiling&&!rasterTiling)issues.push({id:'raster-tiling-invalid',code:'raster-tiling-invalid',severity:'error',pathIds:[],message:'Source-window geometry provenance is invalid. Re-read the original plan before approval.'});
  if(rasterTiling)issues.push({id:'raster-tiling',code:'raster-tiling',severity:rasterTiling.status==='complete'?'review':'error',pathIds:[],message:rasterTiling.status==='complete'?`Geometry was read in ${rasterTiling.processedWindows} overlapping source-resolution windows. Per-window frames and hashes are retained; seams are not architectural walls. Inspect source roles and cross-window topology before approval.`:`Source-window geometry is incomplete (${rasterTiling.reason}); ${rasterTiling.processedWindows}/${rasterTiling.plannedWindows} windows were processed. Missing geometry was not inferred.`});
  const rasterContext = raster?.context && validRasterContext(raster.context, raster.context.requestedRegion, raster.region) ? raster.context : undefined;
  if (raster?.context && !rasterContext) issues.push({id:'raster-context-invalid',code:'raster-context-invalid',severity:'error',pathIds:[],message:'Scan source-context provenance is invalid. Re-read this source before approving geometry.'});
  if (rasterContext?.status !== 'unchanged' && rasterContext) issues.push({id:'raster-context',code:'raster-context',severity:'review',pathIds:[],message:rasterContext.status==='expanded'?'Clipped source swing ink triggered one bounded context read. The original selection and sheet frame are preserved. Inspect the recovered leaf, jambs and wall host; expanded context does not verify recognition.':`Clipped source context remains unresolved (${rasterContext.reason}). No missing geometry was guessed; inspect or select more source context.`});
  const recognitionImages=(input.visualObservations??[]).flatMap(observation=>{
    if(!observation.sourceImage)return [];
    if(!validRecognitionImageSource(observation.sourceImage)){
      issues.push({id:`recognition-image-invalid:${observation.id}`,code:'recognition-image-invalid',severity:'error',pathIds:observation.suppliedPathIds,message:'Recorded classification image provenance is invalid. Read the original drawing again before approving geometry.'});return [];
    }
    if(observation.sourceImage.kind==='display-tiles')issues.push({id:`recognition-image-quality:${observation.id}`,code:'recognition-image-quality',severity:'review',pathIds:observation.suppliedPathIds,message:'This classification used display tiles without verified original pixel density. Inspect or reprocess the original drawing before approval.'});
    return [{observationId:observation.id,image:observation.sourceImage}];
  });
  let strokeNetwork=sourceWallNetwork({evidence:input.evidence,sx,sy,textRuns:input.textRuns,visualObservations:input.visualObservations,classifiedWallPathIds:new Set(elements.filter(e=>!e.conflict&&e.kind==='wall').map(e=>e.pathId)),excludedPathIds:new Set(elements.filter(e=>e.conflict||!["unknown","wall"].includes(e.kind)).map(e=>e.pathId))});
  if(strokeNetwork.diagnostics.classifiedPairs)issues.push({id:'classified-wall-pairs',code:'classified-wall-pairs',severity:'review',pathIds:strokeNetwork.diagnostics.classifiedPairPathIds??[],message:'Both source faces of these individually measured wall pairs have resolved architectural wall classifications. Their original overlaps and depths are retained; neighboring unclassified pairs remain unresolved. Confirm source roles, competing depths and junctions before approval.'});
  if(strokeNetwork.diagnostics.localizedPairs)issues.push({id:'localized-wall-decisions',code:'localized-wall-decisions',severity:'review',pathIds:strokeNetwork.diagnostics.localizedPairPathIds??[],message:'Visual decisions support these exact measured wall spans. Unrelated source-parent tails remain unclassified; confirm source meaning, competing bodies and junctions before approval.'});
  for(const conflict of strokeNetwork.diagnostics.localizedPairConflicts??[])issues.push({id:`wall-hypothesis-conflict:${conflict.id}`,code:'wall-hypothesis-conflict',severity:'error',pathIds:conflict.pathIds,point:conflict.point,message:'Source-bound span decisions disagree with each other or with existing wall support. Resolve this physical wall meaning before approval; retained geometry is only a provisional preview.'});
  if(strokeNetwork.diagnostics.rasterWidthVariationBands)issues.push({id:'raster-wall-depth-fit',code:'raster-wall-depth-fit',severity:'review',pathIds:strokeNetwork.diagnostics.rasterWidthVariationPathIds??[],message:'Measured source face separations vary within their pixel-fit uncertainty intervals. Constant-depth wall hypotheses use the middle separation; inspect these spans against the original plan before approval.'});
  if(strokeNetwork.diagnostics.rasterCompositeBands)issues.push({id:'raster-wall-layering',code:'raster-wall-layering',severity:'review',pathIds:strokeNetwork.diagnostics.rasterCompositePathIds??[],message:'Long internal faces separate adjacent measured material bands. Combined wall depth and architectural layer roles remain unresolved; inspect the original scan before combining them.'});

  const leafResult=sourceLeafDoors({evidence:input.evidence,sx,sy,visualObservations:input.visualObservations,wallBodies:strokeNetwork.bodies,candidateWallBodies:strokeNetwork.candidates,pathKinds:new Map(elements.map(e=>[e.pathId,e.conflict?'annotation':e.kind]))});
  const leafDoors=leafResult.doors.filter(d=>[d.a,d.b].every(p=>p[0]>=input.region.x0&&p[0]<=input.region.x1&&p[1]>=input.region.y0&&p[1]<=input.region.y1));
  const leafIds=new Set(leafDoors.flatMap(d=>d.doorPathIds)),leafWallIds=new Set(leafDoors.flatMap(d=>d.wallPathIds));
  strokeNetwork=withDoorCorroboratedFlanks(strokeNetwork,leafWallIds,input.evidence?.raster?leafDoors.flatMap(d=>d.wallSpans??[]):undefined)
  if(input.evidence?.raster && strokeNetwork.bodies.length)issues.push({id:'raster-wall-assembly',code:'raster-wall-assembly',severity:'review',pathIds:[...strokeNetwork.pathIds],message:'Continuous source ink supports paired-face wall hypotheses corroborated by labelled networks, both-face wall classifications or complete observed door assemblies. Confirm architectural role, pixel uncertainty and competing depths; scan geometry remains provisional.'});
  if(leafResult.diagnostics.clippedRasterArcIds?.length)issues.push({id:'raster-swing-context',code:'raster-swing-context',severity:'review',pathIds:leafResult.diagnostics.clippedRasterArcIds,message:'Observed swing ink reaches the scan extraction edge. Expand source context to inspect the complete leaf and jambs; a clipped curve or wall gap cannot establish a door.'});
  if(leafResult.limited)issues.push({id:'door-leaf-limit',code:'door-leaf-limit',severity:'review',pathIds:[],message:'Door-leaf assembly analysis exceeded its source budget. Review unresolved openings.'});
  const inferred = new Set([...geometricStructureIds(input.evidence, sx, sy),...strokeNetwork.pathIds]);
  if(strokeNetwork.limited)issues.push({id:'wall-network-limit',code:'wall-network-limit',severity:'review',pathIds:[],message:'Independent source wall-network analysis exceeded its source budget. Review unresolved linework.'});
  const coverageWeight=(intervals:Array<{span:number[];weight:number}>,start:number,end:number)=>{
    let covered=start,weight=0;
    for(const h of intervals.sort((a,b)=>a.span[0]-b.span[0])){
      if(h.span[1]<covered-.025)continue;
      if(h.span[0]>covered+.025)break;
      covered=Math.max(covered,h.span[1]);weight=Math.max(weight,h.weight);
      if(covered>=end-.025)return weight;
    }
    return 0;
  };
  const networkIntervals=(a:Line,b:Line,thickness:number)=>strokeNetwork.bodies.flatMap(h=>{
    if(!a.ids.some(id=>h.pathIds.includes(id))||!b.ids.some(id=>h.pathIds.includes(id))||Math.abs(h.thicknessFt-thickness)>.02)return[];
    const l=line(feet(h.a),feet(h.b),h.pathIds)!;
    if(!parallel(a,l)||Math.abs(dot(l.a,[a.nx,a.ny])-(a.offset+dot(b.a,[a.nx,a.ny]))/2)>.02)return[];
    return[{span:[dot(l.a,[a.ux,a.uy]),dot(l.b,[a.ux,a.uy])].sort((x,y)=>x-y),weight:h.strokeWidth}];
  });
  const networkWeight=(a:Line,b:Line,start:number,end:number,thickness:number)=>coverageWeight(networkIntervals(a,b,thickness),start,end);
  const networkLines=strokeNetwork.bodies.flatMap(h=>{const l=line(feet(h.a),feet(h.b),h.pathIds);return l?[{...l,thickness:h.thicknessFt}]:[];}),nearNetworkLines=segmentIndex(networkLines);
  const competingPairCuts=(a:Line,b:Line,start:number,end:number,thickness:number)=>{
    const offset=(a.offset+dot(b.a,[a.nx,a.ny]))/2;
    return nearNetworkLines(a,1.5).flatMap(i=>{
      const h=networkLines[i];
      if(!parallel(a,h)||Math.abs(dot(h.a,[a.nx,a.ny])-offset)>=(h.thickness+thickness)/2-.04)return[];
      return[dot(h.a,[a.ux,a.uy]),dot(h.b,[a.ux,a.uy])].filter(t=>t>start&&t<end);
    });
  };
  const usedSource = new Set<number>(),
    represented = new Set<number>();
  let excluded = 0;
  const clipPaths = new Map(
    input.evidence?.paths
      .filter((p) => p.kind === "clip")
      .map((p) => [p.id, p]) ?? [],
  );
  const openingSourceIds=new Set(architecture.openings.map(o=>o.boundary.pathId).filter(id=>id!==undefined));
  const measuredCaps=strokeNetwork.caps.flatMap(c=>{const l=line(feet(c.a),feet(c.b),[c.pathId]);return l?[l]:[];});
  const localizedIds=new Set(strokeNetwork.diagnostics.localizedPairPathIds??[]),localizedFaces=rasterSourceFaces(input.evidence,strokeNetwork,sx,sy);
  for(const c of strokeNetwork.caps){const point:AreaPoint=[(c.a[0]+c.b[0])/2,(c.a[1]+c.b[1])/2];if(point[0]>=input.region.x0&&point[0]<=input.region.x1&&point[1]>=input.region.y0&&point[1]<=input.region.y1)issues.push({id:`measured-wall-cap:${c.pathId}`,code:'measured-wall-cap',severity:'review',pathIds:[c.pathId,...c.ownerPathIds],point,message:'Exact source corners close the end of a measured T return. This transverse cap remains source evidence and was excluded from parallel-face pairing; confirm the wall junction and return.'});}
  for (const p of input.evidence?.paths ?? []) {
    if(leafIds.has(p.id))continue;
    const bounds=evidencePathBounds(p),r=input.region;
    if(bounds&&(bounds.x1<r.x0||bounds.y1<r.y0||bounds.x0>r.x1||bounds.y0>r.y1)){excluded++;continue}
    const e = kinds.get(p.id),
      kind = e?.kind === "unknown" && inferred.has(p.id) ? "wall" : e?.kind;
    // Unlayered vectors can still supply a wall's two drawn faces. Only
    // consider their individual straight spans near a measured floor edge;
    // never promote the entire compound path or a synthetic room closure.
    const recoverUnknown = kind === "unknown" && !input.evidence?.raster && roomFaces.length > 0;
    if (
      p.kind === "clip" ||
      p.dashes.length ||
      p.opacity < 0.5 ||
      e?.conflict ||
      (!recoverUnknown && !["wall", "window", "door"].includes(kind ?? "")) ||
      p.layer.some((l) =>
        /(?:^|[^a-z])(?:demo|demolition)(?:$|[^a-z])/i.test(l),
      )
    ) {
      excluded++;
      continue;
    }
    if (recoverUnknown && p.commands.some((c) => c[0] === "C")) continue;
    // Unsupported clipping is an explicit unresolved source, never invisible geometry.
    const clips = p.clips
      .map((id) => clipPaths.get(id))
      .map((c) =>
        c && !c.commands.some((v) => v[0] === "C")
          ? flattenEvidencePath(c)
          : null,
      );
    if (clips.some((c) => !c || c.length !== 1 || !isConvex(c[0]))) {
      issues.push({
        id: `clip:${p.id}`,
        code: "unsupported-clip",
        severity: "review",
        message: "A structural path has unsupported clipping.",
        pathIds: [p.id],
      });
      continue;
    }
    if (kind === "door") {
      // A closed sliding/overhead panel is not a swing arc. Its two long
      // parallel faces provide a measured opening candidate. Structural jambs
      // at both ends are checked below; a lone leaf cannot cut a random wall.
      if (p.commands.some(c => c[0] === "C")) continue;
      for (const ring of flattenEvidencePath(p)) {
        if (ring.length !== 5 || dist(ring[0], ring[4]) > 1e-8) continue;
        if (ring.some(q => q[0] < r.x0 || q[0] > r.x1 || q[1] < r.y0 || q[1] > r.y1)) continue;
        if (clips.some(c => c && ring.some(q => !containsPoint(q, c[0])))) continue;
        const sides = ring.slice(0, 4).map((q, i) => line(feet(q), feet(ring[i + 1]), [p.id]));
        if (sides.some(s => !s)) continue;
        const longest = sides.reduce((best, s, i) => s!.end - s!.start > sides[best]!.end - sides[best]!.start ? i : best, 0);
        const a = sides[longest]!, b = sides[(longest + 2) % 4]!;
        const width = Math.abs(dot(b.a, [a.nx, a.ny]) - a.offset);
        if (!parallel(a, b) || width < .04 || width > .5) continue;
        if (Math.abs(a.start - b.start) > .03 || Math.abs(a.end - b.end) > .03) continue;
        const panel = line(at(a, a.start, (a.offset + b.offset) / 2), at(a, a.end, (a.offset + b.offset) / 2), [p.id]);
        if (panel) doorPanels.push(panel);
      }
      continue;
    }
    if (p.commands.some((c) => c[0] === "C") && kind === "wall" && !openingSourceIds.has(p.id)) {
      issues.push({
        id: `curve:${p.id}`,
        code: "curved-wall",
        severity: "review",
        message: "A curved wall needs reconstruction review.",
        pathIds: [p.id],
      });
      continue;
    }
    const geometry=openingSourceIds.has(p.id)?{...p,commands:p.commands.map(c=>c[0]==="C"?["M",c[5],c[6]] as ["M",number,number]:c)}:p;
    const material = materials.get(p.id);
    if(material)issues.push({id:`wall-material:${p.id}`,code:'wall-material-footprint',severity:'review',pathIds:[p.id],message:'Opaque rectangular paint on a wall/hatch layer has measured wall dimensions. Its exterior supplies wall faces; tessellation diagonals and tiny hatch marks were excluded. Confirm material role and drawing scale.'});
    const localizedOnly=input.evidence?.raster&&localizedIds.has(p.id)&&e?.kind==='unknown';
    const rings = (localizedOnly ? localizedFaces.filter(f=>f.pathId===p.id).map(f=>[f.a,f.b]) : material ? [material.ring] : flattenEvidencePath(geometry)).map(ring => {
      if(localizedOnly)return ring;
      if (kind !== "wall" || p.rasterFeature !== "linework" || !input.evidence?.raster || p.clips.length) return ring;
      const aligned = alignRasterWallRun(ring.map(feet), input.evidence.raster.feetPerPixel);
      if (!aligned) return ring;
      if (aligned.maximumDeviationFt > 1e-7) issues.push({
        id: `raster-alignment:${p.id}:${issues.length}`, code: "raster-wall-alignment", severity: "review", pathIds: [p.id],
        point: norm([(aligned.points[0][0] + aligned.points[1][0]) / 2, (aligned.points[0][1] + aligned.points[1][1]) / 2]),
        message: `A continuous scanned wall face was aligned within ${(aligned.maximumDeviationFt * 12).toFixed(2)} inches of its source ink. Check the straight face against the plan.`,
      });
      return aligned.points.map(norm);
    });
    for (const ring of rings)
      for (let i = 1; i < ring.length; i++) {
        let span = clipped(ring[i - 1], ring[i], input.region);
        if (!span) continue;
        for (const clip of clips) {
          if (!span || !clip) break;
          span = clipSegmentToConvexPolygon(span[0], span[1], clip[0]);
        }
        if (!span) continue;
        const l = line(feet(span[0]), feet(span[1]), [p.id]);
        if (l) {
          if (recoverUnknown) {
            const supported = nearRoomFaces(l, 1.5).some((i) => {
              const f = roomFaces[i];
              if (!parallel(l, f) || Math.abs(dot(f.a, [l.nx, l.ny]) - l.offset) > 1.5) return false;
              const start = Math.min(dot(f.a, [l.ux, l.uy]), dot(f.b, [l.ux, l.uy]));
              const end = Math.max(dot(f.a, [l.ux, l.uy]), dot(f.b, [l.ux, l.uy]));
              return Math.min(l.end, end) - Math.max(l.start, start) >= .18;
            });
            if (!supported) continue;
            inferredSource.add(p.id);
          }
          if(kind==='wall'||recoverUnknown){
            let remaining:Array<[number,number]>=[[l.start,l.end]];
            for(const cap of measuredCaps){
              if(!parallel(l,cap)||Math.abs(dot(cap.a,[l.nx,l.ny])-l.offset)>1e-5)continue;
              const bounds=[dot(cap.a,[l.ux,l.uy]),dot(cap.b,[l.ux,l.uy])].sort((a,b)=>a-b);
              remaining=remaining.flatMap(([a,b])=>bounds[1]<=a||bounds[0]>=b?[[a,b] as [number,number]]:[[a,Math.min(b,bounds[0])],[Math.max(a,bounds[1]),b]].filter(([s,e])=>e-s>1e-8) as Array<[number,number]>);
            }
            for(const [a,b]of remaining){const face=line(at(l,a),at(l,b),l.ids);if(face){wallLines.push(face);usedSource.add(p.id);}}
          }else windowLines.push(l);
        }
      }
  }
  const faces = fuse(wallLines);
  if (faces.length > 20000) {
    issues.push({
      id: "capacity",
      code: "capacity",
      severity: "error",
      message:
        "The selected region contains too much structural linework. Select one floor.",
      pathIds: [],
    });
    return {
      version: 1,
      walls: [],
      openings: [],
      issues,
      source: {
        kind: input.evidence?.raster ? "raster" : "vector",
        ...(rasterContext ? {rasterContext} : {}),
        ...(rasterTiling ? {rasterTiling} : {}),
        ...(recognitionImages.length?{recognitionImages}:{}),
        wallPathCount: usedSource.size,
        representedWallPathCount: 0,
        excludedPathCount: excluded,
      },
      status: "incomplete",
    };
  }
  const nearFaces = segmentIndex(faces);
  const raw: Array<{ line: Line; thickness: number; sourceStrokeWidth:number; supportSpan?:[number,number] }> = [];
  for (let i = 0; i < faces.length; i++) {
    const a = faces[i];
    const candidates: Array<{
      b: Line;
      distance: number;
      start: number;
      end: number;
    }> = [];
    for (const j of nearFaces(a, 1.5)) {
      if (j <= i) continue;
      const b = faces[j];
      if (!parallel(a, b)) continue;
      const offset = dot(b.a, [a.nx, a.ny]),
        distance = Math.abs(offset - a.offset);
      if (distance < 0.2 || distance > 1.5) continue;
      const start = Math.max(
          a.start,
          Math.min(dot(b.a, [a.ux, a.uy]), dot(b.b, [a.ux, a.uy])),
        ),
        end = Math.min(
          a.end,
          Math.max(dot(b.a, [a.ux, a.uy]), dot(b.b, [a.ux, a.uy])),
        );
      if (end - start < 0.18) continue;
      // Two lines enclosing walkable room space are not opposite wall faces.
      const middle = norm(at(a, (start + end) / 2, (a.offset + offset) / 2));
      if (
        !networkWeight(a,b,start,end,distance) && architecture.spaces.some(
          (s) =>
            containsPoint(middle, s.points) &&
            !s.holes.some((h) => containsPoint(middle, h)),
        )
      )
        continue;
      candidates.push({ b, distance, start, end });
    }
    // Fused paint faces may extend beyond an independently measured pair.
    // Preserve that pair's actual interval boundaries before ranking source
    // hypotheses. Otherwise a short unproven paint tail can deprive an entire
    // valid span of its support, allowing a narrower core to replace the wall.
    // Competing overlapping hypotheses use the same measured boundaries, so
    // the existing ranked body selection can compare each common interval.
    // These cuts do not extend or classify any source interval.
    const cuts = [...new Set(candidates.flatMap((c) => [c.start, c.end,
      ...networkIntervals(a,c.b,c.distance).flatMap(h=>h.span.filter(t=>t>c.start&&t<c.end)),
      ...competingPairCuts(a,c.b,c.start,c.end,c.distance),
    ]))].sort(
      (x, y) => x - y,
    );
    for (let k = 1; k < cuts.length; k++) {
      const start = cuts[k - 1],
        end = cuts[k];
      if (end - start < 0.1) {
        if(end-start>1e-8){const c=candidates.find(c=>c.start<=start+1e-8&&c.end>=end-1e-8);if(c){const offset=(a.offset+dot(c.b.a,[a.nx,a.ny]))/2,pa=norm(at(a,start,offset)),pb=norm(at(a,end,offset));issues.push({id:identity('wall-pair-small-span',pa,pb),code:'wall-pair-small-span',severity:'review',pathIds:[...new Set([...a.ids,...c.b.ids])],point:norm(at(a,(start+end)/2,offset)),message:`A measured paired-source interval of ${(end-start).toFixed(6)}ft is below the wall-hypothesis representation limit. Its endpoints remain in this source review identity; inspect the interval instead of assuming it is covered.`});}}
        continue;
      }
      const selected = candidates
        .filter((c) => c.start <= start + 0.001 && c.end >= end - 0.001)
        .sort((x, y) => networkWeight(a,y.b,start,end,y.distance)-networkWeight(a,x.b,start,end,x.distance)||x.distance - y.distance)[0];
      if (!selected) continue;
      const offset = (a.offset + dot(selected.b.a, [a.nx, a.ny])) / 2,
        ids = [...new Set([...a.ids, ...selected.b.ids])];
      const l = line(at(a, start, offset), at(a, end, offset), ids);
      if (l) raw.push({ line: l, thickness: selected.distance,sourceStrokeWidth:networkWeight(a,selected.b,start,end,selected.distance),supportSpan:[selected.start,selected.end] });
    }
  }
  // Deduplicate paired hypotheses across multi-line wall assemblies. Keep the
  // strongest matching source-face strokes in an independently supported network,
  // then the narrowest remaining span. No room perimeter is promoted to a wall.
  let accepted: Array<{ line: Line; thickness: number; supportSpan?:[number,number] }> = [];
  for (const candidate of raw.sort((a, b) => b.sourceStrokeWidth-a.sourceStrokeWidth||a.thickness - b.thickness)) {
    const competing=accepted.find(
        (c) =>
          parallel(c.line, candidate.line) &&
          Math.abs(
            dot(candidate.line.a, [c.line.nx, c.line.ny]) - c.line.offset,
          ) <
            (c.thickness + candidate.thickness) / 2 - 0.04 &&
          candidate.line.start >= c.line.start - 0.02 &&
          candidate.line.end <= c.line.end + 0.02,
      );
    if(competing){
      if(Math.abs(competing.thickness-candidate.thickness)>1e-8||Math.abs(dot(candidate.line.a,[competing.line.nx,competing.line.ny])-competing.line.offset)>1e-8)issues.push({id:identity('competing-wall-body',norm(candidate.line.a),norm(candidate.line.b)),code:'competing-wall-body',severity:'review',pathIds:[...new Set([...candidate.line.ids,...competing.line.ids])],point:norm(at(candidate.line,(candidate.line.start+candidate.line.end)/2)),message:'A lower-ranked paired-face hypothesis overlaps an already selected wall interval. Original source evidence remains; confirm the core/finish assembly and retained source tails rather than counting both hypotheses as separate walls.'});
      continue;
    }
    accepted.push(candidate);
  }
  // Room detection follows the interior finish face; masonry cores can sit a
  // few inches behind it because of furring. Expand only to an actual parallel
  // source face, preserving both references, rather than leaving floor gaps or
  // deleting a correctly recognized exterior core as "not adjacent".
  const finishFaces = architecture.spaces.flatMap((s) =>
    (s.sourceBoundaries ?? [])
      .filter(
        (e) =>
          e.source === "drawn" &&
          e.pathId !== undefined &&
          !["annotation", "fixture", "furniture", "door", "window"].includes(
            kinds.get(e.pathId)?.kind ?? "unknown",
          ),
      )
      .flatMap((e) => {
        const l = line(feet(e.a), feet(e.b), [e.pathId!]);
        return l ? [l] : [];
      }),
  );
  for (const c of accepted) {
    const originalLow = c.line.offset - c.thickness / 2,
      originalHigh = c.line.offset + c.thickness / 2;
    let low = originalLow,
      high = originalHigh;
    for (const f of finishFaces) {
      if (!parallel(c.line, f)) continue;
      const overlap =
        Math.min(c.line.end, f.end) - Math.max(c.line.start, f.start);
      if (
        overlap < Math.min(c.line.end - c.line.start, f.end - f.start) * 0.8 ||
        overlap < 0.3
      )
        continue;
      const offset = dot(f.a, [c.line.nx, c.line.ny]);
      if (offset < low - 0.01 && offset >= originalLow - 0.3) {
        low = offset;
        c.line.ids.push(...f.ids);
      }
      if (offset > high + 0.01 && offset <= originalHigh + 0.3) {
        high = offset;
        c.line.ids.push(...f.ids);
      }
    }
    c.line.offset = (low + high) / 2;
    c.thickness = high - low;
    c.line.a = at(c.line, c.line.start);
    c.line.b = at(c.line, c.line.end);
    c.line.ids = [...new Set(c.line.ids)];
  }
  // Named CAD layers also contain window tags, borders and symbol detail.
  // A wall assembly must adjoin reconstructed floor space when such evidence
  // exists; layer membership alone does not establish building membership.
  const inFloor = (p: AreaPoint) =>
    architecture.spaces.some(
      (s) =>
        containsPoint(p, s.points) && !s.holes.some((h) => containsPoint(p, h)),
    );
  const independentCandidate=(c:typeof accepted[number])=>coverageWeight(strokeNetwork.bodies.flatMap(h=>{
    if(!h.pathIds.every(id=>c.line.ids.includes(id))||Math.abs(h.thicknessFt-c.thickness)>.02)return[];
    const l=line(feet(h.a),feet(h.b),h.pathIds)!;
    if(!parallel(c.line,l)||Math.abs(dot(l.a,[c.line.nx,c.line.ny])-c.line.offset)>.02)return[];
    return[{span:[dot(l.a,[c.line.ux,c.line.uy]),dot(l.b,[c.line.ux,c.line.uy])].sort((a,b)=>a-b),weight:h.strokeWidth}];
  }),c.line.start,c.line.end)>0;
  const sourceBodies=accepted;
  const reconciliation=reconcileMeasuredWallBodies(sourceBodies.map(c=>({a:c.line.a,b:c.line.b,thicknessFt:c.thickness,pathIds:c.line.ids,independent:independentCandidate(c)})));
  if(reconciliation.limited||reconciliation.invalidIndices.length)issues.push({id:'wall-body-reconciliation-limit',code:'wall-body-reconciliation-unresolved',severity:'review',pathIds:[],message:'Source wall-body reconciliation could not complete within its geometry budget. Original candidates were preserved; review overlapping bodies.'});
  else{
    accepted=reconciliation.bodies.flatMap(fragment=>{
      const source=sourceBodies[fragment.sourceIndex],l=line(fragment.a,fragment.b,source.line.ids);
      if(l)return[{line:l,thickness:source.thickness,supportSpan:source.supportSpan}];
      issues.push({id:identity('wall-body-tail',norm(fragment.a),norm(fragment.b)),code:'wall-body-small-tail',severity:'review',pathIds:source.line.ids,point:norm([(fragment.a[0]+fragment.b[0])/2,(fragment.a[1]+fragment.b[1])/2]),message:`An uncovered measured source-wall tail of ${dist(fragment.a,fragment.b).toFixed(6)}ft is below the 3D wall-segment representation limit. It was retained as unresolved source evidence; inspect the junction instead of assuming it is covered.`});
      return[];
    });
    const grouped=new Map<number,typeof reconciliation.covered>();
    for(const covered of reconciliation.covered)grouped.set(covered.sourceIndex,[...(grouped.get(covered.sourceIndex)??[]),covered]);
    for(const [sourceIndex,covered]of grouped){const source=sourceBodies[sourceIndex],anchors=[...new Set(covered.flatMap(c=>c.by))];issues.push({id:identity('contained-wall-body',norm(source.line.a),norm(source.line.b)),code:'contained-wall-body',severity:'review',pathIds:[...new Set([...source.line.ids,...anchors.flatMap(i=>sourceBodies[i].line.ids)])],point:norm(at(source.line,(source.line.start+source.line.end)/2)),message:'A weaker wall body shares a measured source face and its full depth is already covered by independently paired wall geometry. Only those proven intervals were consolidated; uncovered source tails and gaps remain. Confirm the assembly rather than counting its detail as another wall.'});}
  }
  const floorSupports=(c:typeof accepted[number],span:[number,number])=>[0.2,0.5,0.8].some(t=>[-1,1].some(side=>inFloor(norm(at(c.line,span[0]+t*(span[1]-span[0]),c.line.offset+side*(c.thickness/2+.06))))));
  const supported = accepted.filter(
    (c) =>
      independentCandidate(c) || !architecture.spaces.length ||
      floorSupports(c,c.supportSpan??[c.line.start,c.line.end]),
  );
  for(const c of supported)if(c.supportSpan&&!independentCandidate(c)&&architecture.spaces.length&&!floorSupports(c,[c.line.start,c.line.end]))issues.push({id:identity('source-pair-continuation',norm(c.line.a),norm(c.line.b)),code:'source-pair-continuation',severity:'review',pathIds:c.line.ids,point:norm(at(c.line,(c.line.start+c.line.end)/2)),message:'This measured paired-face interval belongs to a continuous source assembly adjoining reconstructed floor elsewhere. Splitting competing hypotheses did not change that source context. Confirm the junction/continuation; its endpoints were not extended and its role remains inferred.'});
  for(const c of supported.filter(independentCandidate)){
    const a=norm(c.line.a),b=norm(c.line.b),half=c.thickness/2,body=[norm(at(c.line,c.line.start,c.line.offset-half)),norm(at(c.line,c.line.end,c.line.offset-half)),norm(at(c.line,c.line.end,c.line.offset+half)),norm(at(c.line,c.line.start,c.line.offset+half))];
    const conflict=architecture.spaces.some(s=>areasOverlap({points:body,holes:[]},{points:s.points,holes:s.holes}));
    const interiorConflict=conflict&&[.2,.5,.8].some(t=>inFloor(norm(at(c.line,c.line.start+t*(c.line.end-c.line.start)))));
    issues.push({id:identity('independent-wall-network',a,b),code:interiorConflict?'wall-network-floor-conflict':conflict?'wall-network-floor-contact':'independent-wall-network',severity:interiorConflict?'error':'review',pathIds:c.line.ids,point:norm(at(c.line,(c.line.start+c.line.end)/2)),message:interiorConflict?'Reconstructed floor reaches an independently paired wall centerline. Resolve wall and room topology together before accepting.':conflict?'A reconstructed floor overlaps the face of an independently paired wall without reaching its sampled centerline. Check finish-face convention and source stroke uncertainty.':'Measured source-face pairs with architectural corroboration support this wall independently of detected rooms. Confirm its faces, junctions and source roles.'});
  }
  const jambHosts = measuredJambWindowHosts(input);
  // Room recognition can miss a shower/closet beside an otherwise explicit
  // window. Preserve only the measured common span of its two pier faces.
  // Subtract existing wall bodies before adding anything, including crossing
  // walls and narrower cores; do not stretch a core to an unmeasured finish.
  for (const host of jambHosts) {
    if (host.ambiguous) continue;
    for (const pier of host.piers) {
      const candidate = line(feet(pier.a), feet(pier.b), pier.pathIds);
      if (!candidate) continue;
      let remaining: Array<[number, number]> = [[candidate.start, candidate.end]];
      for (const existing of supported) {
        const l = existing.line;
        let low = candidate.start, high = candidate.end;
        const origin = at(candidate, 0);
        for (const [axis, min, max] of [
          [[l.ux, l.uy], l.start, l.end],
          [[l.nx, l.ny], l.offset - existing.thickness / 2, l.offset + existing.thickness / 2],
        ] as Array<[AreaPoint, number, number]>) {
          const slope = dot([candidate.ux, candidate.uy], axis);
          const base = dot(origin, axis);
          const margin = Math.abs(dot([candidate.nx, candidate.ny], axis)) * host.thicknessFt / 2;
          if (Math.abs(slope) < 1e-8) {
            if (base <= min - margin + 1e-8 || base >= max + margin - 1e-8) high = low;
          } else {
            const bounds = [(min - margin - base) / slope, (max + margin - base) / slope].sort((a,b)=>a-b);
            low = Math.max(low, bounds[0]); high = Math.min(high, bounds[1]);
          }
        }
        if (high <= low) continue;
        remaining = remaining.flatMap(([a,b]) => high <= a || low >= b ? [[a,b] as [number,number]] :
          [[a,Math.min(b,low)],[Math.max(a,high),b]].filter(([s,e])=>e-s>=.18) as Array<[number,number]>);
      }
      for (const [start,end] of remaining) {
        if (end-start < .18) continue;
        const a=norm(at(candidate,start)),b=norm(at(candidate,end)),point=norm(at(candidate,(start+end)/2));
        // Compare the entire body, so a narrow overlapping floor strip cannot
        // fall between sample points. Shared edges and room holes stay valid.
        const body={points:[norm(at(candidate,start,candidate.offset-host.thicknessFt/2)),norm(at(candidate,end,candidate.offset-host.thicknessFt/2)),
          norm(at(candidate,end,candidate.offset+host.thicknessFt/2)),norm(at(candidate,start,candidate.offset+host.thicknessFt/2))],holes:[]};
        const occupiesFloor=architecture.spaces.some(s=>areasOverlap(body,s));
        const pathIds=[...new Set([...host.pathIds,...pier.pathIds])];
        if (occupiesFloor) {
          issues.push({id:identity('window-pier-conflict',a,b),code:'window-pier-conflict',severity:'review',pathIds,point,
            message:'Measured wall faces beside a window conflict with modeled floor space. Check the wall and room boundary against the source.'});
          continue;
        }
        supported.push({line:line(feet(a),feet(b),pathIds)!,thickness:host.thicknessFt});
        issues.push({id:identity('window-pier',a,b),code:'window-pier-recovered',severity:'review',pathIds,point,
          message:'Paired source faces and a measured window jamb establish this wall segment independently of room detection. Confirm the adjoining room boundary.'});
      }
    }
  }
  const merged: Array<{ line: Line; thickness: number }> = [];
  for (const c of supported) {
    const existing = merged.find(
      (m) =>
        Math.abs(m.thickness - c.thickness) < 0.02 &&
        parallel(m.line, c.line) &&
        Math.abs(dot(c.line.a, [m.line.nx, m.line.ny]) - m.line.offset) <
          0.018 &&
        Math.max(m.line.start, c.line.start) <=
          Math.min(m.line.end, c.line.end) + 0.025,
    );
    if (!existing) {
      merged.push(c);
      continue;
    }
    existing.line.start = Math.min(existing.line.start, c.line.start);
    existing.line.end = Math.max(existing.line.end, c.line.end);
    existing.line.a = at(existing.line, existing.line.start);
    existing.line.b = at(existing.line, existing.line.end);
    existing.line.ids = [...new Set([...existing.line.ids, ...c.line.ids])];
  }
  const walls: BuildingWall[] = merged.map((c) => {
    c.line.ids.forEach((id) => represented.add(id));
    const a = norm(at(c.line, c.line.start)),
      b = norm(at(c.line, c.line.end));
    return {
      id: identity("wall", a, b),
      a,
      b,
      thicknessFt: c.thickness,
      pathIds: c.line.ids,
      basis: "paired-faces",
      roomIds: [],
    };
  });
  const openings: BuildingOpening[] = [];
  const thresholds = fuse(
    architecture.openings.flatMap((o) => {
      const l = line(
        feet(o.boundary.a),
        feet(o.boundary.b),
        o.boundary.pathId === undefined ? [] : [o.boundary.pathId],
      );
      return l ? [l] : [];
    }),
    0.1,
  );
  const addOpening = (candidate: Line, kind: BuildingOpening["kind"], closedPanel = false, measuredDoor?:VectorLeafDoor) => {
    const length = candidate.end - candidate.start;
    const rasterDoor=measuredDoor?.basis==="raster-swing-leaf",doorTolerance=rasterDoor?Math.min(.1,measuredDoor.sourceUncertaintyFt??0):.02;
    if (length < 1.25 || length > 20) return;
    // Explicit window geometry can sit inside an otherwise continuous wall
    // assembly. Cut that host directly; do not create an overlapping new wall.
    if (kind === "window" || closedPanel) {
      const host = walls
        .filter((w) => w.basis === "paired-faces")
        .map((w) => ({ w, l: line(feet(w.a), feet(w.b), w.pathIds)! }))
        .filter(
          ({ w, l }) =>
            parallel(candidate, l) &&
            Math.abs(dot(candidate.a, [l.nx, l.ny]) - l.offset) <=
              w.thicknessFt / 2 + 0.08 &&
            candidate.start >= l.start - 0.08 &&
            candidate.end <= l.end + 0.08,
        )
        .sort(
          (a, b) =>
            Math.abs(candidate.offset - a.l.offset) -
            Math.abs(candidate.offset - b.l.offset),
        )[0];
      if (host) {
        const offsetFt = Math.max(0, candidate.start - host.l.start),
          widthFt = Math.min(length, host.l.end - host.l.start - offsetFt);
        if (widthFt < 1.25) return;
        if (
          openings.some(
            (o) =>
              o.wallId === host.w.id &&
              Math.min(o.offsetFt + o.widthFt, offsetFt + widthFt) -
                Math.max(o.offsetFt, offsetFt) >
                0.1,
          )
        )
          return;
        const a = norm(at(host.l, host.l.start + offsetFt)),
          b = norm(at(host.l, host.l.start + offsetFt + widthFt));
        openings.push({
          id: identity(kind, a, b),
          wallId: host.w.id,
          kind,
          offsetFt,
          widthFt,
          ...(kind === "window" ? { widthBasis: "source-linework" as const } : {}),
          pathIds: [...new Set([...candidate.ids, ...host.w.pathIds])],
          spaceIds: [],
        });
        return;
      }
    }
    // Raster assembly axes already carry a measured pixel uncertainty. Apply
    // that same displacement bound at the host handoff; an exact CAD angular
    // cutoff must not discard a complete source assembly because its two
    // independently fitted flanks differ by a pixel. Generic/vector openings
    // retain their existing alignment rules.
    const alignedHost = (l: Line) => rasterDoor
      ? Math.abs(candidate.ux * l.uy - candidate.uy * l.ux) *
          Math.min(length, l.end - l.start) <= doorTolerance
      : parallel(candidate, l);
    // An opening needs structural jambs at both ends, aligned with its host.
    const endpoints = [
      at(candidate, candidate.start),
      at(candidate, candidate.end),
    ];
    const neighbours = endpoints.map(
      (p) =>
        merged
          .flatMap((c) => {
            if (!alignedHost(c.line)) return [];
            const nearestPoint=dist(p,c.line.a)<dist(p,c.line.b)?c.line.a:c.line.b;
            const nearest = dist(p,nearestPoint);
            if(measuredDoor&&(!c.line.ids.some(id=>measuredDoor.wallPathIds.includes(id))||Math.abs(c.thickness-measuredDoor.thicknessFt)>(rasterDoor?doorTolerance:.02)||(rasterDoor?Math.abs(dot(nearestPoint,[candidate.nx,candidate.ny])-candidate.offset)>doorTolerance:Math.abs(c.line.offset-candidate.offset)>.02)||nearest>doorTolerance))return [];
            return nearest <= Math.max(0.8, c.thickness + 0.1)
              ? [{ ...c, nearest, nearestPoint }]
              : [];
          })
          .sort((a, b) => a.nearest - b.nearest)[0],
    );
    if (neighbours.some((n) => !n)) return;
    const thickness = (neighbours[0].thickness + neighbours[1].thickness) / 2;
    const offset =
      (dot(rasterDoor?neighbours[0].nearestPoint:neighbours[0].line.a, [candidate.nx, candidate.ny]) +
        dot(rasterDoor?neighbours[1].nearestPoint:neighbours[1].line.a, [candidate.nx, candidate.ny])) /
      2;
    if (Math.abs(offset - candidate.offset) > thickness + 0.1) return;
    if (
      merged.some(
        (c) =>
          alignedHost(c.line) &&
          Math.abs(dot(c.line.a, [candidate.nx, candidate.ny]) - offset) <
            (thickness + c.thickness) / 2 - 0.04 &&
          Math.min(...[Math.max(dot(c.line.a,[candidate.ux,candidate.uy]),dot(c.line.b,[candidate.ux,candidate.uy])), candidate.end]) -
            Math.max(Math.min(dot(c.line.a,[candidate.ux,candidate.uy]),dot(c.line.b,[candidate.ux,candidate.uy])), candidate.start) >
            0.2,
      )
    )
      return;
    const a = norm(at(candidate, candidate.start, offset)),
      b = norm(at(candidate, candidate.end, offset));
    if (
      openings.some((o) => {
        const w = walls.find((w) => w.id === o.wallId)!;
        return Math.min(Math.max(dist(feet(w.a), feet(a)), dist(feet(w.b), feet(b))), Math.max(dist(feet(w.b), feet(a)), dist(feet(w.a), feet(b)))) < 0.8;
      })
    )
      return;
    const pathIds = [
      ...new Set([...candidate.ids, ...neighbours.flatMap((n) => n.line.ids)]),
    ];
    const id = identity("host", a, b);
    walls.push({
      id,
      a,
      b,
      thicknessFt: thickness,
      pathIds,
      basis: "opening-host",
      roomIds: [],
    });
    const spaceIds = architecture.openings
      .filter((o) => {
        const mid = feet([
          (o.boundary.a[0] + o.boundary.b[0]) / 2,
          (o.boundary.a[1] + o.boundary.b[1]) / 2,
        ]);
        return (
          Math.abs(dot(mid, [candidate.nx, candidate.ny]) - candidate.offset) <
            thickness + 0.1 &&
          dot(mid, [candidate.ux, candidate.uy]) >= candidate.start - 0.1 &&
          dot(mid, [candidate.ux, candidate.uy]) <= candidate.end + 0.1
        );
      })
      .flatMap((o) => o.spaceIds);
    openings.push({
      id: identity(kind, a, b),
      wallId: id,
      kind,
      offsetFt: 0,
      widthFt: length,
      ...(measuredDoor?{widthBasis:measuredDoor.widthBasis??'jamb-span',...(measuredDoor.clearSpan?{clearWidthFt:dist(feet(measuredDoor.clearSpan[0]),feet(measuredDoor.clearSpan[1]))}:{}),...(measuredDoor.leafWidthFt?{leafWidthFt:measuredDoor.leafWidthFt}:{})}:kind === "window" ? { widthBasis: "source-linework" as const } : {}),
      pathIds,
      spaceIds: [...new Set(spaceIds)],
    });
  };
  for(const door of leafDoors){
    const candidate=line(feet(door.a),feet(door.b),[...door.doorPathIds,...door.framePathIds,...door.wallPathIds])!;
    const before=openings.length;addOpening(candidate,'door',false,door);
    issues.push({id:identity('door-leaf',door.a,door.b),code:openings.length>before?'door-leaf-assembly':'door-leaf-host-unresolved',severity:'review',pathIds:candidate.ids,point:norm(at(candidate,(candidate.start+candidate.end)/2)),message:openings.length>before&&door.basis==='raster-swing-leaf'?'Observed swing, open leaf faces and end cap, connected stepped jambs and paired wall flanks support this provisional scan door. Clear passage, leaf width and wall-flank span are separate source measurements; confirm rough opening, operation and vertical dimensions.':openings.length>before?'A measured leaf, both jamb frames and paired wall flanks support this arc-less door. Confirm host, handing and rough-opening width; vertical dimensions remain unverified.':door.basis==='raster-swing-leaf'?'Observed swing, leaf and jamb ink support a scan door hypothesis, but its measured wall host is unresolved. Review the adjoining wall faces and their pixel uncertainty.':'Source leaf and jambs indicate an arc-less door, but its reconstructed wall host is unresolved. Review the adjoining wall topology.'});
  }
  for (const threshold of thresholds)if(!threshold.ids.some(id=>leafIds.has(id)))addOpening(threshold, "door");
  const addClosedPanel = (panel: Line) => {
    const before = openings.length;
    addOpening(panel, "door", true);
    if (openings.length === before) return;
    const opening = openings.at(-1)!;
    const garage = architecture.spaces.some(s =>
      (s.labels ?? []).some(label => /\bgarage\b/i.test(label)) &&
      [-1, 1].some(side => containsPoint(norm(at(panel, (panel.start + panel.end) / 2, panel.offset + side)), s.points)));
    opening.style = garage ? "garage" : "sliding";
    issues.push({
      id: `operation:${opening.id}`, code: "opening-operation", severity: "review",
      message: "A closed door panel is drawn. Confirm its operating style and height.",
      pathIds: opening.pathIds, objectId: opening.id,
    });
  };
  for (const panel of doorPanels) {
    const sourceJambs = [panel.start, panel.end].map(t => wallLines
      .filter(f => f.ids.some(id => kinds.get(id)?.kind === "wall") &&
        Math.abs(f.ux * panel.ux + f.uy * panel.uy) < .006 &&
        f.end - f.start >= .2 && f.end - f.start <= 2 &&
        Math.min(dist(at(panel, t), f.a), dist(at(panel, t), f.b)) <= .8)
      .sort((a, b) => Math.min(dist(at(panel, t), a.a), dist(at(panel, t), a.b)) - Math.min(dist(at(panel, t), b.a), dist(at(panel, t), b.b)))[0]);
    if (sourceJambs.every(Boolean)) {
      const [left, right] = sourceJambs;
      const center = (f: Line): AreaPoint => [(f.a[0] + f.b[0]) / 2, (f.a[1] + f.b[1]) / 2];
      const a = center(left), b = center(right);
      // Recessed panels may sit inside the jamb depth. The clear opening runs
      // between the actual perpendicular jamb faces, not the panel's frame.
      if (Math.abs(dot(a, [panel.nx, panel.ny]) - dot(b, [panel.nx, panel.ny])) < .15) {
        const threshold = line(a, b, [...new Set([...panel.ids, ...left.ids, ...right.ids])]);
        if (threshold && parallel(threshold, panel)) {
          addClosedPanel(threshold);
          continue;
        }
      }
    }
    const jambs = [-1, 1].every(side => merged.some(c => {
      if (!parallel(panel, c.line)) return false;
      const offset = Math.abs(dot(c.line.a, [panel.nx, panel.ny]) - panel.offset);
      if (offset > c.thickness / 2 + .15) return false;
      const start = Math.min(dot(c.line.a, [panel.ux, panel.uy]), dot(c.line.b, [panel.ux, panel.uy]));
      const end = Math.max(dot(c.line.a, [panel.ux, panel.uy]), dot(c.line.b, [panel.ux, panel.uy]));
      // The jamb must extend outside this opening. A continuous inferred wall
      // running through its panel cannot serve as both structural supports.
      return side < 0
        ? start < panel.start - .25 && Math.abs(end - panel.start) <= .8
        : end > panel.end + .25 && Math.abs(start - panel.end) <= .8;
    }));
    if (jambs) addClosedPanel(panel);
  }
  for (const assembly of rasterWindowAssemblies(input)) {
    const candidate = line(assembly.a, assembly.b, assembly.pathIds);
    if (!candidate) continue;
    const count = openings.length;
    addOpening(candidate, "window");
    if (openings.length > count) {
      const opening = openings.at(-1)!;
      opening.widthBasis = "connected-frame";
      issues.push({ id: `frame:${opening.id}`, code: "window-frame-assembly", severity: "review", objectId: opening.id, pathIds: assembly.pathIds,
        message: "Connected window frame and pane linework establish this opening. Confirm its rough opening, mullions, sill and head heights against the plan." });
    }
  }
  for (const window of fuse(windowLines)) addOpening(window, "window");
  // Some exporters draw a closed leaf/panel on the generic wall layer. Preserve
  // its gap only when actual drawn boundary and both wall jambs establish it.
  // Classifying a door vs window still needs review; never guess from width.
  const panelBoundaries = fuse(
    architecture.spaces.flatMap((s) =>
      (s.sourceBoundaries ?? [])
        .filter(
          (e) =>
            e.source === "drawn" &&
            e.pathId !== undefined &&
            kinds.get(e.pathId)?.kind === "wall",
        )
        .flatMap((e) => {
          const l = line(feet(e.a), feet(e.b), [e.pathId!]);
          return l ? [l] : [];
        }),
    ),
  );
  for (const panel of panelBoundaries) {
    const count = openings.length;
    addOpening(panel, "cased");
    if (openings.length > count) {
      const o = openings.at(-1)!;
      issues.push({
        id: `type:${o.id}`,
        code: "opening-type",
        severity: "review",
        message:
          "Source linework establishes an opening; confirm whether it is a door, window or open passage.",
        pathIds: o.pathIds,
        objectId: o.id,
      });
    }
  }
  for (const host of jambHosts) {
    const candidate=line(feet(host.a),feet(host.b),host.pathIds)!;
    const overlaps=(a:AreaPoint,b:AreaPoint,thickness:number)=>{
      const other=line(a,b,[]);
      return other && parallel(candidate,other) && Math.abs(candidate.offset-other.offset)<(host.thicknessFt+thickness)/2+.02 &&
        Math.min(candidate.end,other.end)-Math.max(candidate.start,other.start)>.1;
    };
    const represented=openings.some(o=>{
      if(o.kind!=='window')return false;
      const wall=walls.find(w=>w.id===o.wallId)!;const a=feet(wall.a),b=feet(wall.b),size=dist(a,b);
      if(!size)return false;
      const atOffset=(t:number):AreaPoint=>[a[0]+(b[0]-a[0])*t/size,a[1]+(b[1]-a[1])*t/size];
      return overlaps(atOffset(o.offsetFt),atOffset(o.offsetFt+o.widthFt),wall.thicknessFt);
    });
    if(represented)continue;
    const point=norm(at(candidate,(candidate.start+candidate.end)/2));
    const occupiesFloor=[.25,.5,.75].some(t=>{
      const p=norm(at(candidate,candidate.start+(candidate.end-candidate.start)*t));
      return architecture.spaces.some(s=>containsPoint(p,s.points)&&!s.holes.some(h=>containsPoint(p,h)));
    });
    if(host.ambiguous || occupiesFloor || walls.some(w=>overlaps(feet(w.a),feet(w.b),w.thicknessFt))) {
      issues.push({id:identity('window-jamb-conflict',host.a,host.b),code:'window-jamb-conflict',severity:'review',pathIds:host.pathIds,point,
        message:'Measured window jambs conflict with another host candidate, modeled wall or known floor space. Check the source before placing this opening.'});
      continue;
    }
    const roomIds=architecture.spaces.filter(s=>[-1,1].some(side=>{
      const p=norm(at(candidate,(candidate.start+candidate.end)/2,candidate.offset+side*(host.thicknessFt/2+.05)));
      return containsPoint(p,s.points)&&!s.holes.some(h=>containsPoint(p,h));
    })).map(s=>s.id);
    const id=identity('jamb-window-host',host.a,host.b),openingId=identity('window',host.a,host.b);
    walls.push({id,a:host.a,b:host.b,thicknessFt:host.thicknessFt,pathIds:host.pathIds,basis:'opening-host',roomIds});
    openings.push({id:openingId,wallId:id,kind:'window',offsetFt:0,widthFt:host.widthFt,widthBasis:'jamb-span',pathIds:host.pathIds,spaceIds:roomIds});
    issues.push({id:`review:${id}`,code:'window-jamb-host',severity:'review',objectId:openingId,pathIds:host.pathIds,point,
      message:'Two drawn jambs, paired panes and four supporting wall faces establish this opening. Confirm its frame, sill and head against the source.'});
  }
  for (const candidate of measuredWindowHosts(input, architecture)) {
    const point: AreaPoint = [(candidate.boundary.a[0] + candidate.boundary.b[0]) / 2, (candidate.boundary.a[1] + candidate.boundary.b[1]) / 2];
    const host = candidate.host;
    if (!host) {
      issues.push({ id: identity('window-host-missing', candidate.boundary.a, candidate.boundary.b), code: 'window-host-missing', severity: 'error',
        message: 'A window supports the floor boundary, but its wall thickness lacks matching source faces. Confirm and draw its host wall.', pathIds: candidate.boundary.pathId === undefined ? [] : [candidate.boundary.pathId], point });
      continue;
    }
    const midpoint = feet(point);
    if (openings.some(o => o.kind === 'window' && (() => {
      const wall = walls.find(w => w.id === o.wallId)!;
      const start = feet(wall.a), end = feet(wall.b), length = dist(start, end), t = dot([midpoint[0] - start[0], midpoint[1] - start[1]], [(end[0] - start[0]) / length, (end[1] - start[1]) / length]);
      return t >= o.offsetFt - .1 && t <= o.offsetFt + o.widthFt + .1 && Math.abs((end[0] - start[0]) * (midpoint[1] - start[1]) - (end[1] - start[1]) * (midpoint[0] - start[0])) / length <= wall.thicknessFt / 2 + .1;
    })())) continue;
    const id = identity('window-host', host.a, host.b);
    walls.push({ id, a: host.a, b: host.b, thicknessFt: host.thicknessFt, pathIds: host.pathIds, basis: 'opening-host', roomIds: [candidate.spaceId] });
    const openingId = identity('window', host.a, host.b);
    openings.push({ id: openingId, wallId: id, kind: 'window', offsetFt: host.offsetFt, widthFt: host.widthFt, widthBasis: 'pane-span', pathIds: host.pathIds, spaceIds: [candidate.spaceId] });
    issues.push({ id: `review:${id}`, code: 'window-host-inferred', severity: 'review', objectId: id, point, pathIds: host.pathIds,
      message: 'Window panes and measured pier faces support this host wall. Confirm the finish face, rough opening, sill and head heights.' });
  }
  const windowOpenings = openings.filter(o => o.kind === "window").flatMap(o => {
    const wall = walls.find(w => w.id === o.wallId);
    if (!wall) return [];
    const a = feet(wall.a), b = feet(wall.b), span = dist(a, b);
    if (!span) return [];
    const at = (t: number): AreaPoint => [a[0] + (b[0] - a[0]) * t / span, a[1] + (b[1] - a[1]) * t / span];
    return [{ a: at(o.offsetFt), b: at(o.offsetFt + o.widthFt), thicknessFt: wall.thicknessFt }];
  });
  for (const missing of unrepresentedWindows(fuse(windowLines).map(l => ({ a: l.a, b: l.b, pathIds: l.ids })), windowOpenings)) {
    const a = norm(missing.a), b = norm(missing.b);
    issues.push({ id: identity("unrepresented-window", a, b), code: "unrepresented-window", severity: "review",
      message: "Recognized window panes have no complete opening in the model. Check their frame, wall support and width against the plan.",
      pathIds: missing.pathIds, point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  }
  for (const w of walls) {
    if (w.pathIds.some((id) => inferredSource.has(id))) {
      issues.push({
        id: `inferred:${w.id}`,
        code: "inferred-wall",
        severity: "review",
        message: "Paired source lines beside a room suggest a wall; confirm its type against the drawing.",
        pathIds: w.pathIds,
        objectId: w.id,
      });
    }
    const a = feet(w.a),
      b = feet(w.b),
      length = dist(a, b),
      nx = -(b[1] - a[1]) / length,
      ny = (b[0] - a[0]) / length;
    const probes = [-1, 1].map((side) =>
      norm([
        (a[0] + b[0]) / 2 + nx * (w.thicknessFt / 2 + 0.06) * side,
        (a[1] + b[1]) / 2 + ny * (w.thicknessFt / 2 + 0.06) * side,
      ]),
    );
    w.roomIds = architecture.spaces
      .filter((s) => probes.some((p) => containsPoint(p, s.points)))
      .map((s) => s.id);
  }
  // Assess source coverage by physical span, including coincident material
  // detail inside an accepted wall. One PDF face can have hundreds of paint
  // fragments; they must not become hundreds of duplicate review tasks.
  const unresolved: Line[] = [];
  for (const source of faces) {
    const intervals = merged
      .filter(
        (c) =>
          parallel(source, c.line) &&
          Math.abs(dot(c.line.a, [source.nx, source.ny]) - source.offset) <=
            c.thickness / 2 + 0.035,
      )
      .map((c) => [
        Math.max(source.start, c.line.start),
        Math.min(source.end, c.line.end),
      ])
      .filter((r) => r[1] > r[0])
      .sort((a, b) => a[0] - b[0]);
    let covered = 0,
      end = source.start;
    for (const [a, b] of intervals) {
      covered += Math.max(0, b - Math.max(end, a));
      end = Math.max(end, b);
    }
    if (covered >= (source.end - source.start) * 0.9)
      source.ids.forEach((id) => represented.add(id));
    else if (source.end - source.start >= 1) unresolved.push(source);
  }
  for (const candidate of fuse(unresolved)) {
    if (candidate.ids.every((id) => represented.has(id))) continue;
    const p = norm(at(candidate, (candidate.start + candidate.end) / 2));
    issues.push({
      id: identity("unpaired", norm(candidate.a), norm(candidate.b)),
      code: "unpaired-wall",
      severity: "review",
      message: "This structural source span has no reliable wall assembly.",
      pathIds: candidate.ids,
      point: p,
    });
  }
  if (!walls.length)
    issues.push({
      id: "no-walls",
      code: "no-walls",
      severity: "error",
      message: "No source-supported walls were reconstructed.",
      pathIds: [],
    });
  if (!architecture.spaces.length)
    issues.push({
      id: "no-spaces",
      code: "no-spaces",
      severity: "error",
      message: "Room boundaries could not be reconstructed.",
      pathIds: [],
    });
  if (input.evidence?.truncated)
    issues.push({
      id: "truncated",
      code: "truncated",
      severity: "error",
      message: "Source extraction was truncated.",
      pathIds: [],
    });
  const building: BuildingReconstruction = {
    version: 1,
    walls,
    openings,
    issues,
    source: {
      kind: input.evidence?.raster ? "raster" : "vector",
      ...(rasterContext ? {rasterContext} : {}),
        ...(rasterTiling ? {rasterTiling} : {}),
        ...(recognitionImages.length?{recognitionImages}:{}),
      wallPathCount: usedSource.size,
      representedWallPathCount: represented.size,
      excludedPathCount: excluded,
    },
    status: issues.some((i) => i.severity === "error")
      ? "incomplete"
      : "needs-review",
  };
  if (input.windowScheduleContext) {
    const reconciliation = reconcileWindowScheduleTags(input, building, input.windowScheduleContext);
    building.scheduleAssociations = reconciliation.associations;
    building.unmatchedScheduleTags = reconciliation.unmatchedTags;
    for (const association of building.scheduleAssociations) {
      const tag = association.candidates[0]?.tag;
      issues.push({id:`window-schedule:${association.openingId}`,code:'window-schedule',severity:'review',objectId:association.openingId,
        pathIds:[...new Set(association.candidates.map(c=>c.tag.pathId))],
        point:tag ? [(tag.bounds.x0+tag.bounds.x1)/2,(tag.bounds.y0+tag.bounds.y1)/2] : undefined,
        message:association.reason});
    }
    for (const {tag} of building.unmatchedScheduleTags) issues.push({
      id:`window-tag:${tag.runIndex}:${tag.pathId}`,code:'window-schedule-unrepresented',severity:'review',pathIds:[tag.pathId],
      point:[(tag.bounds.x0+tag.bounds.x1)/2,(tag.bounds.y0+tag.bounds.y1)/2],
      message:`Window tag ${tag.mark} has no reconstructed opening nearby. Check for a missed window or a different plan/detail.`,
    });
  }
  building.issues=groupSourceAssemblyReviews(issues);
  return building;
}
