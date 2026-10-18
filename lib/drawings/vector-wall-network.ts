import {
  flattenEvidencePath,
  type AreaEvidence,
  type AreaPoint,
} from "./area-evidence";
import { areaPathRole } from "./area-paths";
import { rasterFaceOverlap } from "./raster-face-overlap";
import { areaRoomLabel } from "./area-labels";
import { segmentIndex } from "./segment-index";
import type { TextRun } from "./text-runs";
import { vectorSourceVisibility } from "./vector-source-visibility";
import type { AreaVisualObservation } from './area-semantics';
import { withLocalizedWallDecisions } from './wall-hypothesis-semantics';

export const VECTOR_WALL_NETWORK_PROFILE = "paired-stroke-network-4";
export const RASTER_WALL_NETWORK_PROFILE = "raster-wall-faces-4";
interface Face {
  a: AreaPoint;
  b: AreaPoint;
  id: number;
  width: number;
  style: string;
  u: AreaPoint;
  n: AreaPoint;
  length: number;
  offset: number;
  rasterFitErrorFt?: number;
}
export interface VectorWallHypothesis {
  a: AreaPoint;
  b: AreaPoint;
  thicknessFt: number;
  strokeWidth: number;
  pathIds: [number, number];
  component: number;
  /** Measured empty/unresolved pixel band; not material or wall-role evidence. */
  sourceBand?: "unfilled";
}
export interface VectorWallNetwork {
  profile: typeof VECTOR_WALL_NETWORK_PROFILE | typeof RASTER_WALL_NETWORK_PROFILE;
  pathIds: Set<number>;
  bodies: VectorWallHypothesis[];
  candidates: VectorWallHypothesis[];
  caps: Array<{
    a: AreaPoint;
    b: AreaPoint;
    pathId: number;
    ownerPathIds: [number, number];
  }>;
  limited: boolean;
  diagnostics: {
    faces: number;
    pairs: number;
    capOperations: number;
    rasterCompositeBands?: number;
    rasterCompositePathIds?: number[];
    rasterWidthVariationBands?: number;
    rasterWidthVariationPathIds?: number[];
    classifiedPairs?: number;
    classifiedPairPathIds?: number[];
    unfilledPairObservations?: number;
    localizedPairs?: number;
    localizedPairPathIds?: number[];
    localizedPairConflicts?: Array<{id:string;pathIds:number[];point:AreaPoint}>;
    components: Array<{
      size: number;
      spanFt: number;
      junctions: number;
      seed: boolean;
    }>;
  };
}
const dot = (a: AreaPoint, b: AreaPoint) => a[0] * b[0] + a[1] * b[1];
const sub = (a: AreaPoint, b: AreaPoint): AreaPoint => [
  a[0] - b[0],
  a[1] - b[1],
];
const cross = (a: AreaPoint, b: AreaPoint) => a[0] * b[1] - a[1] * b[0];
const position = (f: Face, t: number, offset = f.offset): AreaPoint => [
  f.a[0] + f.u[0] * t + f.n[0] * (offset - f.offset),
  f.a[1] + f.u[1] * t + f.n[1] * (offset - f.offset),
];
const dark = (p: AreaEvidence["paths"][number]) =>
  (p.colorSpace === "DeviceGray" &&
    p.color.length === 1 &&
    p.color[0] <= 0.8) ||
  (p.colorSpace === "DeviceRGB" &&
    p.color.length === 3 &&
    p.color.every((c) => c <= 0.8));
/** Independent source hypotheses, not a room perimeter extrusion. Only pure
 * straight unknown strokes are eligible, with their exact paired overlap.
 * A connected network needs a measured T/cross junction, substantial span and
 * a source room tag with direct visibility to at least three network sides. Isolated bars, double boxes, fixture layers,
 * unsupported clips and conflicting semantic classifications do not qualify.
 * Returned source IDs remain inferred and must be reviewed; no CAD labels,
 * dimensions, closure edges or spans beyond measured overlap are fabricated. */
interface WallNetworkInput {
  evidence: AreaEvidence | null | undefined;
  sx: number;
  sy: number;
  textRuns: readonly TextRun[];
  excludedPathIds?: ReadonlySet<number>;
  /** Globally resolved wall roles; context-only or conflicting votes are excluded. */
  classifiedWallPathIds?: ReadonlySet<number>;
  /** Inspect measured unfilled bands without assigning their faces wall roles. */
  inspectUnfilledPairs?: boolean;
  visualObservations?: readonly AreaVisualObservation[];
}
export function vectorWallNetwork(input: WallNetworkInput): VectorWallNetwork {
  return measuredWallNetwork(input, false);
}

/** Raster entry requires directly measured continuous ink runs. Skeleton
 * fragments and generic contours cannot enter through the vector classifier.
 * Source-derived pair hypotheses stay provisional and retain pixel uncertainty. */
export function rasterWallNetwork(input: WallNetworkInput): VectorWallNetwork {
  return measuredWallNetwork(input, true);
}

export function sourceWallNetwork(input: WallNetworkInput): VectorWallNetwork {
  const source={...input,inspectUnfilledPairs:input.inspectUnfilledPairs||!!input.visualObservations?.some(o=>o.suppliedWallHypotheses?.length)};
  const measured=input.evidence?.raster ? rasterWallNetwork(source) : vectorWallNetwork(source);
  return withLocalizedWallDecisions(withClassifiedWallPairs(measured,input.classifiedWallPathIds ?? new Set()),input.evidence,input.visualObservations,input.sx,input.sy);
}

/** Classification supplies object meaning, never geometry. Admit each already
 * measured pair only when BOTH original faces have resolved wall roles. Do not
 * propagate that vote to its component, extend its overlap or relax raster ink,
 * depth, visibility and source-work checks. Results remain review hypotheses. */
export function withClassifiedWallPairs(network: VectorWallNetwork, pathIds: ReadonlySet<number>): VectorWallNetwork {
  if(network.limited || !pathIds.size)return network;
  const key=(b:VectorWallHypothesis)=>JSON.stringify([b.a,b.b,b.thicknessFt,[...b.pathIds].sort((a,b)=>a-b)]);
  const represented=new Set(network.bodies.map(key));
  const additions=network.candidates.filter(candidate=>{
    if(!candidate.pathIds.every(id=>pathIds.has(id))||represented.has(key(candidate)))return false;
    represented.add(key(candidate));return true;
  });
  if(!additions.length)return network;
  const addedIds=[...new Set(additions.flatMap(body=>body.pathIds))].sort((a,b)=>a-b);
  return {...network,bodies:[...network.bodies,...additions],pathIds:new Set([...network.pathIds,...addedIds]),diagnostics:{...network.diagnostics,classifiedPairs:additions.length,classifiedPairPathIds:addedIds}};
}

/** Admit only the measured flanks used by complete source door assemblies.
 * This never classifies the rest of an unseeded component or extends a span. */
export function withDoorCorroboratedFlanks(network: VectorWallNetwork, pathIds: ReadonlySet<number>, spans?: readonly VectorWallHypothesis[]): VectorWallNetwork {
  if (network.limited || !pathIds.size) return network;
  const key=(b:VectorWallHypothesis)=>JSON.stringify([b.a,b.b,b.thicknessFt,[...b.pathIds].sort((a,b)=>a-b),b.sourceBand??null]);
  const exact=spans===undefined?null:new Set(spans.map(key));
  const additions = network.candidates.filter(candidate => candidate.pathIds.every(id => pathIds.has(id))
    && (exact===null || exact.has(key(candidate)))
    && !network.bodies.some(body => exact===null
      ? body.pathIds.every(id => candidate.pathIds.includes(id))
      : key(body)===key(candidate)));
  return { ...network, bodies: [...network.bodies, ...additions],
    pathIds: new Set([...network.pathIds, ...additions.flatMap(body => body.pathIds)]) };
}

function measuredWallNetwork(input: WallNetworkInput, rasterMode: boolean): VectorWallNetwork {
  const { evidence, sx, sy, textRuns, excludedPathIds } = input;
  const result: VectorWallNetwork = {
    profile: rasterMode ? RASTER_WALL_NETWORK_PROFILE : VECTOR_WALL_NETWORK_PROFILE,
    pathIds: new Set(),
    bodies: [],
    candidates: [],
    caps: [],
    limited: false,
    diagnostics: { faces: 0, pairs: 0, capOperations: 0, components: [] },
  };
  if (
    !evidence ||
    (!!evidence.raster !== rasterMode) ||
    (rasterMode && (!Number.isFinite(evidence.raster!.feetPerPixel) || evidence.raster!.feetPerPixel <= 0)) ||
    evidence.truncated ||
    ![sx, sy].every((v) => Number.isFinite(v) && v > 0)
  )
    return result;
  const feet = ([x, y]: AreaPoint): AreaPoint => [x * sx, y * sy];
  const clips = new Map<number, number[]>();
  for (const p of evidence.paths.filter(
    (p) => p.kind === "clip" && !p.commands.some((c) => c[0] === "C"),
  )) {
    const rings = flattenEvidencePath(p);
    if (rings.length !== 1 || rings[0].length !== 5) continue;
    const r = rings[0],
      xs = r.map((p) => p[0]),
      ys = r.map((p) => p[1]),
      box = [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
      ];
    if (
      new Set(r.slice(0, 4).map((p) => p.join(","))).size !== 4 ||
      r.some(
        (p, i) =>
          !(p[0] === box[0] || p[0] === box[2]) ||
          !(p[1] === box[1] || p[1] === box[3]) ||
          (i > 0 && p[0] !== r[i - 1][0] && p[1] !== r[i - 1][1]),
      )
    )
      continue;
    clips.set(p.id, box);
  }
  const visible = vectorSourceVisibility(evidence);
  const faces: Face[] = [];
  for (const p of evidence.paths) {
    if (rasterMode && (p.rasterFeature !== 'linework' || p.rasterLine?.profile !== 'pixel-supported-straight-3'
      || p.rasterLine.continuousInk !== true || !Number.isInteger(p.rasterLine.sampleCount) || p.rasterLine.sampleCount < 12 || p.rasterLine.sampleCount > 8192
      || !Number.isFinite(p.rasterLine.boundaryFraction) || p.rasterLine.boundaryFraction < .9 || p.rasterLine.boundaryFraction > 1
      || !Number.isFinite(p.rasterLine.maximumDeviationPixels) || p.rasterLine.maximumDeviationPixels < 0 || p.rasterLine.maximumDeviationPixels > 1.5)) continue;
    if (
      p.kind !== "stroke" ||
      areaPathRole(p) !== "unknown" ||
      excludedPathIds?.has(p.id) ||
      p.opacity < 0.95 ||
      p.dashes.length ||
      !dark(p) ||
      p.commands.length !== 2 ||
      p.commands[0][0] !== "M" ||
      p.commands[1][0] !== "L"
    )
      continue;
    const a: AreaPoint = [p.commands[0][1], p.commands[0][2]],
      b: AreaPoint = [p.commands[1][1], p.commands[1][2]];
    if (
      p.clips.some((id) => {
        const box = clips.get(id);
        return (
          !box ||
          [a, b].some(
            (q) =>
              q[0] < box[0] - 1e-9 ||
              q[0] > box[2] + 1e-9 ||
              q[1] < box[1] - 1e-9 ||
              q[1] > box[3] + 1e-9,
          )
        );
      }) ||
      !visible(p)
    )
      continue;
    let start = feet(a),
      end = feet(b);
    if (
      end[0] < start[0] ||
      (Math.abs(end[0] - start[0]) < 1e-9 && end[1] < start[1])
    )
      [start, end] = [end, start];
    const delta = sub(end, start),
      length = Math.hypot(...delta);
    if (length < 0.18) continue;
    const u: AreaPoint = [delta[0] / length, delta[1] / length],
      n: AreaPoint = [-u[1], u[0]];
    faces.push({
      a: start,
      b: end,
      id: p.id,
      width: p.width,
      length,
      u,
      n,
      offset: dot(start, n),
      ...(rasterMode ? { rasterFitErrorFt: (p.rasterLine!.maximumDeviationPixels + .5) * evidence.raster!.feetPerPixel } : {}),
      style: JSON.stringify([
        p.colorSpace,
        p.color,
        p.width,
        p.opacity,
        p.clips,
      ]),
    });
    if (faces.length > 24000) {
      result.diagnostics.faces = faces.length;
      result.limited = true;
      return result;
    }
  }
  result.diagnostics.faces = faces.length;
  const nearby = segmentIndex(faces),
    pairs: Array<{
      a: AreaPoint;
      b: AreaPoint;
      thicknessFt: number;
      strokeWidth: number;
      style: string;
      pathIds: [number, number];
      u: AreaPoint;
      length: number;
    }> = [];
  const paintEntries=Array.isArray(evidence.rasterPairPaint)?evidence.rasterPairPaint:[];
  const rasterPaint = new Set(paintEntries.filter(p=>p&&typeof p==='object'&&Array.isArray(p.pathIds)&&p.pathIds.length===2
    &&p.pathIds.every(id=>Number.isInteger(id)&&id>=0)&&p.pathIds[0]!==p.pathIds[1]&&(p.profile==='measured-pair-paint-3'||(p.profile==='measured-pair-paint-4'&&Array.isArray(p.normalDepthPixels)&&p.normalDepthPixels.length===2&&p.normalDepthPixels.every(Number.isFinite)&&p.normalDepthPixels[0]*p.normalDepthPixels[1]>0))
    && ['solid-paint','transverse-ink'].includes(p.pattern) && Number.isInteger(p.sections)&&p.sections>=12&&p.sections<=8192
    && Number.isInteger(p.fullSections)&&p.fullSections>=0&&p.fullSections<=p.sections
    && Number.isInteger(p.separatedBands)&&p.separatedBands>=0&&p.separatedBands<=p.fullSections
    && Number.isFinite(p.inkFraction)&&p.inkFraction>=.06&&p.inkFraction<=1
    && (p.pattern==='solid-paint'?p.inkFraction>=.8&&p.fullSections/p.sections>=.8:p.fullSections/p.sections>=.08&&p.separatedBands>=4))
    .map(p=>[...p.pathIds].sort((a,b)=>a-b).join(':')));
  const unfilledBands=new Set(paintEntries.filter(p=>rasterMode
    &&p&&typeof p==='object'&&p.profile==='measured-pair-paint-4'&&p.pattern==='unresolved'
    &&Array.isArray(p.pathIds)&&p.pathIds.length===2&&p.pathIds.every(id=>Number.isInteger(id)&&id>=0)&&p.pathIds[0]!==p.pathIds[1]
    &&(input.inspectUnfilledPairs || p.pathIds.every(id=>input.classifiedWallPathIds?.has(id)))
    &&Array.isArray(p.normalDepthPixels)&&p.normalDepthPixels.length===2&&p.normalDepthPixels.every(Number.isFinite)&&p.normalDepthPixels[0]*p.normalDepthPixels[1]>0
    &&Number.isInteger(p.sections)&&p.sections>=12&&p.sections<=8192&&Number.isInteger(p.fullSections)&&p.fullSections>=0&&p.fullSections<=p.sections
    &&Number.isInteger(p.separatedBands)&&p.separatedBands>=0&&p.separatedBands<=p.fullSections&&Number.isFinite(p.inkFraction)&&p.inkFraction>=0&&p.inkFraction<=1)
    .map(p=>[...p.pathIds].sort((a,b)=>a-b).join(':')));
  const intervalPaint = new Set(paintEntries.filter(p=>p&&typeof p==='object'&&p.profile==='measured-pair-paint-4'&&Array.isArray(p.pathIds)
    &&rasterPaint.has([...p.pathIds].sort((a,b)=>a-b).join(':'))).map(p=>[...p.pathIds].sort((a,b)=>a-b).join(':')));
  let rasterInteriorWork = 0;
  const rasterCompositePathIds = new Set<number>();
  const makePair = (a: Face, b: Face, unfilled=false): (typeof pairs)[number] | null => {
    const pairKey=[a.id,b.id].sort((a,b)=>a-b).join(':');
    if(rasterMode&&!(unfilled?unfilledBands:rasterPaint).has(pairKey))return null;
    const fitErrorFt = (a.rasterFitErrorFt ?? 0) + (b.rasterFitErrorFt ?? 0);
    const intervalMode = rasterMode && (unfilled || intervalPaint.has(pairKey));
    const overlap = intervalMode ? rasterFaceOverlap(a,b,fitErrorFt) : null;
    if (a.style !== b.style || (intervalMode ? !overlap : rasterMode
      ? Math.abs(cross(a.u,b.u))*Math.min(a.length,b.length)>fitErrorFt
      : Math.abs(cross(a.u,b.u))>0.002)) return null;
    const signedDepth = overlap?.depth ?? dot(sub(b.a,a.a),a.n);
    const distance = Math.abs(signedDepth);
    if (distance < 0.2 || distance > 1.5 || overlap?.depths.some(d=>Math.abs(d)<.2||Math.abs(d)>1.5)) return null;
    const endpoints = [dot(sub(b.a, a.a), a.u), dot(sub(b.b, a.a), a.u)].sort((a,b)=>a-b),
      lo = overlap?.lo ?? Math.max(0,endpoints[0]), hi = overlap?.hi ?? Math.min(a.length,endpoints[1]);
    if (hi-lo < .18 || (!intervalMode && Math.abs(Math.abs(dot(sub(b.b,a.a),a.n))-distance)>(rasterMode?fitErrorFt:.01))) return null;
    if(rasterMode){
      const sign=Math.sign(signedDepth);
      for(const j of nearby(a,1.5)){
        if(++rasterInteriorWork>2_000_000){result.limited=true;return null;}
        const f=faces[j];if(f.id===a.id||f.id===b.id)continue;
        const error=fitErrorFt+(f.rasterFitErrorFt??0)+evidence.raster!.feetPerPixel*.5;
        if(Math.abs(cross(a.u,f.u))*Math.min(a.length,f.length)>error)continue;
        const fs=[dot(sub(f.a,a.a),a.u),dot(sub(f.b,a.a),a.u)].sort((a,b)=>a-b),overlap=Math.min(hi,fs[1])-Math.max(lo,fs[0]);
        if(overlap<1||overlap<(hi-lo)*.8)continue;
        const depths=[f.a,f.b].map(p=>sign*dot(sub(p,a.a),a.n));
        if(depths.every(d=>d>error&&d<distance-error)){
          // A long internal face separates material bands. Their combined
          // architectural assembly needs semantic evidence; do not manufacture
          // a second, thicker wall from the same source span.
          if(!unfilled){result.diagnostics.rasterCompositeBands=(result.diagnostics.rasterCompositeBands??0)+1;
          [a.id,b.id,f.id].forEach(id=>rasterCompositePathIds.add(id));
          result.diagnostics.rasterCompositePathIds=[...rasterCompositePathIds];}
          return null;
        }
      }
    }
    if(!unfilled && overlap && Math.abs(overlap.depths[1]-overlap.depths[0])>1e-7){
      result.diagnostics.rasterWidthVariationBands=(result.diagnostics.rasterWidthVariationBands??0)+1;
      result.diagnostics.rasterWidthVariationPathIds=[...new Set([...(result.diagnostics.rasterWidthVariationPathIds??[]),a.id,b.id])];
    }
    const offset = intervalMode ? a.offset + signedDepth/2 : (a.offset + dot(b.a,a.n))/2;
    return {
      a: position(a, lo, offset),
      b: position(a, hi, offset),
      thicknessFt: distance,
      strokeWidth: a.width,
      style: a.style,
      pathIds: [a.id, b.id],
      u: a.u,
      length: hi - lo,
    };
  };
  const contact = (a: (typeof pairs)[number], b: (typeof pairs)[number]) => {
    const den = cross(a.u, b.u);
    if (a.style !== b.style || Math.abs(den) < 0.5) return false;
    const q = sub(b.a, a.a),
      ta = cross(q, b.u) / den,
      tb = cross(q, a.u) / den,
      ma = b.thicknessFt / 2 + 0.025,
      mb = a.thicknessFt / 2 + 0.025;
    return ta >= -ma && ta <= a.length + ma && tb >= -mb && tb <= b.length + mb;
  };
  const oppositeArms = (
    stem: (typeof pairs)[number],
    left: (typeof pairs)[number],
    right: (typeof pairs)[number],
  ) => {
    if (
      !contact(stem, left) ||
      !contact(stem, right) ||
      Math.abs(cross(left.u, right.u)) > 0.002 ||
      Math.abs(cross(left.u, sub(right.a, left.a))) > 0.03
    )
      return false;
    const den = cross(left.u, stem.u),
      q = sub(stem.a, left.a),
      joint = dot(left.a, left.u) + cross(q, stem.u) / den;
    const range = (p: typeof left) =>
        [dot(p.a, left.u), dot(p.b, left.u)].sort((a, b) => a - b),
      a = range(left),
      b = range(right),
      margin = stem.thicknessFt / 2 + 0.025;
    return (
      (a[1] <= joint + margin &&
        a[0] < joint - 1.25 &&
        b[0] >= joint - margin &&
        b[1] > joint + 1.25) ||
      (b[1] <= joint + margin &&
        b[0] < joint - 1.25 &&
        a[0] >= joint - margin &&
        a[1] > joint + 1.25)
    );
  };
  const unfilledPairs:VectorWallHypothesis[]=[];
  for (let i = 0; i < faces.length; i++) {
    const a = faces[i];
    for (const j of nearby(a, 1.5)) {
      if (j <= i) continue;
      const b = faces[j];
      if(unfilledBands.has([a.id,b.id].sort((a,b)=>a-b).join(':'))){
        const observed=makePair(a,b,true);if(result.limited)return result;
        if(observed)unfilledPairs.push({a:[observed.a[0]/sx,observed.a[1]/sy],b:[observed.b[0]/sx,observed.b[1]/sy],thicknessFt:observed.thicknessFt,strokeWidth:observed.strokeWidth,pathIds:observed.pathIds,component:-1,sourceBand:'unfilled'});
        if(unfilledPairs.length>12000){result.limited=true;return result;}
      }
      if (Math.max(a.length, b.length) < 1.25) continue;
      const pair = makePair(a, b);
      if (result.limited) return result;
      if (!pair) continue;
      pairs.push(pair);
      if (pairs.length > 12000) {
        result.diagnostics.pairs = pairs.length;
        result.limited = true;
        return result;
      }
    }
  }
  // Short paired returns are not independent wall classifiers. They can only
  // connect two measured long arms at the same T junction, in the same paint
  // style. All endpoints stay at their actual source overlap; no gap is filled.
  const longPairs = pairs.slice(),
    nearLong = segmentIndex(longPairs);
  for (let i = 0; i < faces.length; i++) {
    const a = faces[i];
    if (a.length >= 1.25) continue;
    for (const j of nearby(a, 1.5)) {
      if (j <= i || faces[j].length >= 1.25) continue;
      const pair = makePair(a, faces[j]);
      if (result.limited) return result;
      if (!pair) continue;
      const arms = nearLong(pair, 1.5)
        .map((k) => longPairs[k])
        .filter((b) => contact(pair, b));
      if (
        !arms.some((left, k) =>
          arms.slice(k + 1).some((right) => oppositeArms(pair, left, right)),
        )
      )
        continue;
      pairs.push(pair);
      if (pairs.length > 12000) {
        result.diagnostics.pairs = pairs.length;
        result.limited = true;
        return result;
      }
    }
  }
  // An exposed end cap closes the two source faces of a measured T return.
  // It is a transverse boundary, not a new parallel wall face to pair with
  // the through wall. Require the exact cap corners and opposite long arms at
  // the other end; a cap with a second through-wall junction is not exposed.
  const caps = new Map<number, VectorWallNetwork["caps"][number]>();
  let capWork = 0;
  const exhausted = () => {
    result.diagnostics.capOperations = ++capWork;
    return capWork > 2_000_000;
  };
  const capLimit = () => {
    result.limited = true;
    result.caps = [];
    return result;
  };
  result.diagnostics.pairs = pairs.length;
  // A cap must meet a measured end corner. Index source endpoints first so
  // ordinary long walls do not trigger a quadratic search for T arms. The
  // neighbouring cells cover the existing 1e-5 ft projection tolerances; the
  // exact geometry checks below still decide whether a face is a cap.
  const cornerCell = 2e-5;
  const cornerKey = (style: string, x: number, y: number) =>
    `${style}|${x},${y}`;
  const cornerFaces = new Map<string, number[]>();
  for (let j = 0; j < faces.length; j++) {
    const f = faces[j];
    if (f.length > 1.5 + 1e-5) continue;
    for (const p of [f.a, f.b]) {
      const key = cornerKey(
        f.style,
        Math.floor(p[0] / cornerCell),
        Math.floor(p[1] / cornerCell),
      );
      const bucket = cornerFaces.get(key);
      if (bucket) bucket.push(j);
      else cornerFaces.set(key, [j]);
    }
  }
  for (const stem of pairs) {
    const sn: AreaPoint = [-stem.u[1], stem.u[0]];
    const endFaces = new Set<number>();
    for (const end of [stem.a, stem.b])
      for (const side of [-1, 1]) {
        const x = Math.floor(
            (end[0] + (side * sn[0] * stem.thicknessFt) / 2) / cornerCell,
          ),
          y = Math.floor(
            (end[1] + (side * sn[1] * stem.thicknessFt) / 2) / cornerCell,
          );
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++) {
            if (exhausted()) return capLimit();
            for (const j of cornerFaces.get(
              cornerKey(stem.style, x + dx, y + dy),
            ) ?? []) {
              if (exhausted()) return capLimit();
              endFaces.add(j);
            }
          }
      }
    const measuredCaps: Array<{ face: Face; capEnd: number }> = [];
    for (const j of endFaces) {
      if (exhausted()) return capLimit();
      const f = faces[j];
      if (
        f.style !== stem.style ||
        Math.abs(cross(f.u, stem.u)) < 0.999 ||
        Math.abs(f.length - stem.thicknessFt) > 1e-5
      )
        continue;
      const t = dot(sub(f.a, stem.a), stem.u),
        otherT = dot(sub(f.b, stem.a), stem.u),
        transverse = [
          dot(sub(f.a, stem.a), sn),
          dot(sub(f.b, stem.a), sn),
        ].sort((a, b) => a - b);
      if (
        Math.abs(t - otherT) > 1e-5 ||
        Math.min(Math.abs(t), Math.abs(t - stem.length)) > 1e-5 ||
        Math.abs(transverse[0] + stem.thicknessFt / 2) > 1e-5 ||
        Math.abs(transverse[1] - stem.thicknessFt / 2) > 1e-5
      )
        continue;
      measuredCaps.push({
        face: f,
        capEnd: Math.abs(t) < Math.abs(t - stem.length) ? 0 : stem.length,
      });
    }
    if (!measuredCaps.length) continue;
    const arms: typeof pairs = [];
    for (const k of nearLong(stem, 1.5)) {
      if (exhausted()) return capLimit();
      if (contact(stem, longPairs[k])) arms.push(longPairs[k]);
    }
    let branching = false;
    for (let k = 0; k < arms.length && !branching; k++)
      for (let m = k + 1; m < arms.length; m++) {
        if (exhausted()) return capLimit();
        if (oppositeArms(stem, arms[k], arms[m])) {
          branching = true;
          break;
        }
      }
    if (!branching) continue;
    for (const { face: f, capEnd } of measuredCaps) {
      let atCap = false;
      for (const b of arms) {
        if (exhausted()) return capLimit();
        if (b.pathIds.includes(f.id) || b.length < 2) continue;
        const den = cross(stem.u, b.u),
          joint = cross(sub(b.a, stem.a), b.u) / den;
        if (Math.abs(joint - capEnd) <= b.thicknessFt / 2 + 0.025) {
          atCap = true;
          break;
        }
      }
      if (atCap) continue;
      caps.set(f.id, {
        a: [f.a[0] / sx, f.a[1] / sy],
        b: [f.b[0] / sx, f.b[1] / sy],
        pathId: f.id,
        ownerPathIds: stem.pathIds,
      });
    }
  }
  result.caps = [...caps.values()];
  const retained = pairs.filter((p) => !p.pathIds.some((id) => caps.has(id)));
  pairs.splice(0, pairs.length, ...retained);
  result.diagnostics.pairs = pairs.length;
  // Unclassified measured pairs may support a separately corroborated source
  // assembly. They are not structural IDs and must never be promoted merely
  // because their paint/spacing resembles a wall.
  result.candidates = pairs.map((b) => ({
    a: [b.a[0] / sx, b.a[1] / sy],
    b: [b.b[0] / sx, b.b[1] / sy],
    thicknessFt: b.thicknessFt,
    strokeWidth: b.strokeWidth,
    pathIds: b.pathIds,
    component: -1,
  }));
  const neighbours = pairs.map(() => [] as number[]),
    junctions = new Set<string>(),
    nearPairs = segmentIndex(pairs);
  for (let i = 0; i < pairs.length; i++)
    for (const j of nearPairs(pairs[i], 1.5)) {
      if (j <= i) continue;
      const a = pairs[i],
        b = pairs[j],
        den = cross(a.u, b.u);
      if (a.style !== b.style || Math.abs(den) < 0.5) continue;
      const q = sub(b.a, a.a),
        ta = cross(q, b.u) / den,
        tb = cross(q, a.u) / den,
        ma = b.thicknessFt / 2 + 0.025,
        mb = a.thicknessFt / 2 + 0.025;
      if (ta < -ma || ta > a.length + ma || tb < -mb || tb > b.length + mb)
        continue;
      neighbours[i].push(j);
      neighbours[j].push(i);
      if ((ta > ma && ta < a.length - ma) || (tb > mb && tb < b.length - mb))
        junctions.add(`${i}:${j}`);
    }
  // A T return interrupts both faces of the through wall. The measured left
  // and right bodies meet the returning body rather than each other. Count
  // opposite arms at the SAME source-backed junction; never bridge a gap.
  for (let i = 0; i < pairs.length; i++)
    for (let k = 0; k < neighbours[i].length; k++)
      for (let m = k + 1; m < neighbours[i].length; m++) {
        if (
          oppositeArms(
            pairs[i],
            pairs[neighbours[i][k]],
            pairs[neighbours[i][m]],
          )
        )
          junctions.add(`stem:${i}`);
      }
  const rayHit = (
    origin: AreaPoint,
    direction: AreaPoint,
    body: (typeof pairs)[number],
  ) => {
    const q = sub(origin, body.a),
      coordinates = [dot(q, body.u), cross(body.u, q)],
      velocity = [dot(direction, body.u), cross(body.u, direction)],
      bounds = [
        [0, body.length],
        [-body.thicknessFt / 2, body.thicknessFt / 2],
      ];
    let lo = 0,
      hi = Infinity;
    for (let axis = 0; axis < 2; axis++) {
      if (Math.abs(velocity[axis]) < 1e-9) {
        if (
          coordinates[axis] < bounds[axis][0] ||
          coordinates[axis] > bounds[axis][1]
        )
          return Infinity;
        continue;
      }
      const times = bounds[axis]
        .map((v) => (v - coordinates[axis]) / velocity[axis])
        .sort((a, b) => a - b);
      lo = Math.max(lo, times[0]);
      hi = Math.min(hi, times[1]);
    }
    return hi >= lo && lo > 1e-7 ? lo : Infinity;
  };
  const labels = textRuns
      .filter((r) => areaRoomLabel(r.text))
      .map((r) => feet([r.x + r.w / 2, r.y + r.h / 2])),
    visited = new Set<number>();
  const firstHits = labels.map((p) =>
    Array.from({ length: 8 }, (_, i) => {
      const direction: AreaPoint = [
        Math.cos((i * Math.PI) / 4),
        Math.sin((i * Math.PI) / 4),
      ];
      let winner = -1,
        distance = Infinity;
      pairs.forEach((b, j) => {
        const hit = rayHit(p, direction, b);
        if (hit < distance) {
          distance = hit;
          winner = j;
        }
      });
      return winner;
    }),
  );
  for (let i = 0; i < pairs.length; i++) {
    if (visited.has(i)) continue;
    const component = [i];
    visited.add(i);
    for (let k = 0; k < component.length; k++)
      for (const j of neighbours[component[k]])
        if (!visited.has(j)) {
          visited.add(j);
          component.push(j);
        }
    const spanFt = component.reduce((n, j) => n + pairs[j].length, 0),
      junctionCount = component.filter(
        (j) =>
          junctions.has(`stem:${j}`) ||
          neighbours[j].some((k) =>
            junctions.has(`${Math.min(j, k)}:${Math.max(j, k)}`),
          ),
      ).length;
    if (component.length < 4 || spanFt < 16 || !junctionCount) continue;
    const xs = component.flatMap((j) => [pairs[j].a[0], pairs[j].b[0]]),
      ys = component.flatMap((j) => [pairs[j].a[1], pairs[j].b[1]]),
      box = [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
      ];
    if ((box[2] - box[0]) * (box[3] - box[1]) < 12) continue;
    const members = new Set(component);
    const seed = labels.some(
      (p, labelIndex) =>
        new Set(firstHits[labelIndex].filter((j) => members.has(j))).size >=
          3 &&
        p[0] > box[0] &&
        p[0] < box[2] &&
        p[1] > box[1] &&
        p[1] < box[3] &&
        !component.some((j) => {
          const b = pairs[j],
            q = sub(p, b.a),
            t = dot(q, b.u);
          return (
            t >= 0 &&
            t <= b.length &&
            Math.abs(cross(q, b.u)) <= b.thicknessFt / 2 + 0.025
          );
        }),
    );
    result.diagnostics.components.push({
      size: component.length,
      spanFt,
      junctions: junctionCount,
      seed,
    });
    // A network alone cannot distinguish an outlined-text annotation table
    // from architecture. Preserve its diagnostic counts for semantic review;
    // never make missing room text an automatic architectural classification.
    if (!seed) continue;
    for (const j of component) {
      const b = pairs[j];
      b.pathIds.forEach((id) => result.pathIds.add(id));
      result.bodies.push({
        a: [b.a[0] / sx, b.a[1] / sy],
        b: [b.b[0] / sx, b.b[1] / sy],
        thicknessFt: b.thicknessFt,
        strokeWidth: b.strokeWidth,
        pathIds: b.pathIds,
        component: i,
      });
    }
  }
  // Empty source bands cannot seed labelled components. Inspection exposes
  // their original faces; only the separate both-face role check may admit them.
  result.candidates.push(...unfilledPairs);
  if(unfilledPairs.length)result.diagnostics.unfilledPairObservations=unfilledPairs.length;
  return result;
}
