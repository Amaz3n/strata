import { evidencePathBounds } from './area-evidence'
import type { AreaInput, AreaRegion } from './area-takeoff'
import type { AreaRecognitionRequest } from './area-engine'
import { interpretArchitecturalElements, visualPathCatalogue } from './area-semantics'
import { sourceWallNetwork } from './vector-wall-network'
import { sourceLeafDoors } from './source-leaf-doors'
import { wallMaterialFootprints } from './vector-wall-material'
import { validRasterContextRegion } from './raster-context'
import { observedRasterSwings } from './raster-swing-observations'
import { bindWallHypothesis, type WallHypothesisBinding } from './wall-hypothesis-semantics'
import { planUnassignedWallSpans } from './wall-span-recognition-plan'

export interface RecognitionAssembly {
  id: string
  hypothesis: 'paired-wall-faces' | 'wall-material' | 'door-assembly' | 'quarter-arc-context' | 'unfilled-pair-context'
  pathIds: number[]
  /** Bounds of ALL referenced source paths, in the full sheet frame. */
  region: AreaRegion
  measuredDepthFt?: number
  /** Arc radius is not an opening width or host depth. */
  measuredRadiusFt?: number
  measuredSpanFt: number
  wallHypothesis?: WallHypothesisBinding
}
export interface RecognitionAssemblyHint {
  id: string
  hypothesis: RecognitionAssembly['hypothesis']
  pathIds: number[]
  /** Crop coordinates, re-registered with the original image. */
  bounds: number[]
  measuredDepthFt?: number
  /** Arc radius is not an opening width or host depth. */
  measuredRadiusFt?: number
  measuredSpanFt: number
}

/** Geometric assemblies determine where to inspect, never what to accept.
 * Competing depths and unsupported object meaning remain hypotheses. Only
 * complete immutable source paths may accompany an assembly request. */
export function recognitionAssemblies(input: AreaInput): {assemblies:RecognitionAssembly[];limited:boolean} {
  const evidence = input.evidence, sx=input.imageWidth*input.feetPerImagePx,sy=input.imageHeight*input.feetPerImagePx
  if(!evidence||evidence.truncated||![sx,sy].every(n=>Number.isFinite(n)&&n>0))return {assemblies:[],limited:!!evidence?.truncated}
  const elements=interpretArchitecturalElements(evidence,input.visualObservations,{sx,sy})
  const network=sourceWallNetwork({evidence,sx,sy,textRuns:input.textRuns,visualObservations:input.visualObservations,inspectUnfilledPairs:true,classifiedWallPathIds:new Set(elements.filter(e=>!e.conflict&&e.kind==='wall').map(e=>e.pathId)),excludedPathIds:new Set(elements.filter(e=>e.conflict||!['unknown','wall'].includes(e.kind)).map(e=>e.pathId))})
  const doors=sourceLeafDoors({evidence,sx,sy,visualObservations:input.visualObservations,wallBodies:network.bodies,candidateWallBodies:network.candidates,pathKinds:new Map(elements.map(e=>[e.pathId,e.conflict?'annotation':e.kind]))})
  const paths=new Map(evidence.paths.map(p=>[p.id,p])),assemblies:RecognitionAssembly[]=[],seen=new Set<string>()
  const add=(hypothesis:RecognitionAssembly['hypothesis'],ids:number[],depth:number|undefined,span:number,radius?:number)=>{
    const pathIds=[...new Set(ids)].sort((a,b)=>a-b),bounds=pathIds.map(id=>paths.get(id)).map(p=>p&&evidencePathBounds(p))
    if(!pathIds.length||bounds.some(b=>!b)||![span,...(depth===undefined?[]:[depth]),...(radius===undefined?[]:[radius])].every(n=>Number.isFinite(n)&&n>0))return
    const complete=bounds as NonNullable<typeof bounds[number]>[],region={x0:Math.min(...complete.map(b=>b.x0)),y0:Math.min(...complete.map(b=>b.y0)),x1:Math.max(...complete.map(b=>b.x1)),y1:Math.max(...complete.map(b=>b.y1))}
    const r=input.region
    if(region.x0<r.x0||region.y0<r.y0||region.x1>r.x1||region.y1>r.y1)return
    const id=hypothesis+':'+pathIds.join(':');if(seen.has(id))return;seen.add(id)
    assemblies.push({id,hypothesis,pathIds,region,...(depth===undefined?{}:{measuredDepthFt:depth}),...(radius===undefined?{}:{measuredRadiusFt:radius}),measuredSpanFt:span})
  }
  for(const d of doors.doors)add('door-assembly',[...d.doorPathIds,...d.framePathIds,...d.wallPathIds],d.thicknessFt,Math.hypot((d.a[0]-d.b[0])*sx,(d.a[1]-d.b[1])*sy))
  // A swing without a complete leaf/jamb/host assembly remains a cue for
  // inspecting the original context. It cannot enter accepted door geometry.
  for(const arc of observedRasterSwings({evidence,sx,sy,pathKinds:new Map(elements.map(e=>[e.pathId,e.conflict?'annotation':e.kind]))}).arcs)
    add('quarter-arc-context',[arc.id],undefined,Math.hypot(arc.points[0][0]-arc.points.at(-1)![0],arc.points[0][1]-arc.points.at(-1)![1]),arc.radius)
  for(const m of wallMaterialFootprints(evidence,sx,sy).values())add('wall-material',[m.pathId],m.thicknessFt,m.lengthFt)
  // Scan pairs also carry measured intervening material paint. Bare vector
  // parallel strokes lack that evidence; prioritize their corroborated network
  // bodies rather than enumerating every possible pair in dimension stacks.
  for(const w of evidence.raster?network.candidates:network.bodies){
    const start=assemblies.length;add(w.sourceBand==='unfilled'?'unfilled-pair-context':'paired-wall-faces',w.pathIds,w.thicknessFt,Math.hypot((w.a[0]-w.b[0])*sx,(w.a[1]-w.b[1])*sy));
    if(assemblies.length>start&&evidence.raster){const binding=bindWallHypothesis(evidence,w,sx,sy);if(binding)assemblies.at(-1)!.wallHypothesis=binding}
  }
  const arcs=assemblies.filter(a=>a.hypothesis==='quarter-arc-context');
  const proximity=(a:RecognitionAssembly)=>a.hypothesis==='unfilled-pair-context'?Math.min(...arcs.map(b=>Math.hypot(Math.max(0,a.region.x0-b.region.x1,b.region.x0-a.region.x1)*sx,Math.max(0,a.region.y0-b.region.y1,b.region.y0-a.region.y1)*sy))):0;
  assemblies.sort((a,b)=>assemblyRank(a.hypothesis)-assemblyRank(b.hypothesis)||(proximity(a)-proximity(b)||0)||b.measuredSpanFt-a.measuredSpanFt||a.id.localeCompare(b.id))
  return {assemblies,limited:network.limited||doors.limited}
}

const assemblyRank=(hypothesis:RecognitionAssembly['hypothesis'])=>hypothesis==='door-assembly'?0:hypothesis==='quarter-arc-context'?1:hypothesis==='wall-material'?2:hypothesis==='paired-wall-faces'?3:4;

export interface AssemblyRecognitionPlan {
  requests: AreaRecognitionRequest[]
  suppliedPathIds: Set<number>
  candidateAssemblies: number
  unframedAssemblyIds: string[]
  limited: boolean
}

// Native marks include thousands of unrelated glyph/fixture fragments. Keep
// source inspection local; an image ceiling is capacity, not a useful crop size.
// These are request workload limits, never geometric or qualification thresholds.
export const NATIVE_ASSEMBLY_PATH_LIMIT = 16
const NATIVE_ASSEMBLY_CONTEXT_FT = 4
const NATIVE_ASSEMBLY_MINIMUM_SPAN_FT = 12

/** Atomic assembly batches precede primitive review. A referenced path is
 * offered once; competing hypotheses sharing a path do not create extra votes.
 * A partial/oversized assembly falls back to primitive review, never clipping.
 * Pixel capacity does not authorize reducing the original sampling density. */
export function planAssemblyRecognition(input:AreaInput,maximumSpan:{x:number;y:number}|undefined,batchSize=64):AssemblyRecognitionPlan {
  const sx=input.imageWidth*input.feetPerImagePx,sy=input.imageHeight*input.feetPerImagePx
  const capacity=maximumSpan??{x:36/sx,y:36/sy},r=input.region
  if(!validRasterContextRegion(r)||![sx,sy,capacity.x,capacity.y].every(n=>Number.isFinite(n)&&n>0)||!Number.isInteger(batchSize)||batchSize<1||batchSize>160)throw Error('Invalid assembly recognition frame or batch capacity')
  const native = !!input.evidence?.raster
  const pathLimit = native ? Math.min(batchSize, NATIVE_ASSEMBLY_PATH_LIMIT) : batchSize
  const source=recognitionAssemblies(input),assemblies=source.assemblies,requests:AreaRecognitionRequest[]=[],suppliedPathIds=new Set<number>(),unframedAssemblyIds:string[]=[]
  let limited=source.limited,work=0
  if(!input.evidence)return{requests,suppliedPathIds,candidateAssemblies:0,unframedAssemblyIds,limited}
  const eligible=new Map(visualPathCatalogue(input.evidence,r,Infinity,{sx,sy}).map(p=>[p.id,p]))
  const axis=(lo:number,hi:number,outerLo:number,outerHi:number,maximum:number,scale:number)=>{
    if(hi-lo>maximum+1e-12)return null
    // Keep complete original parent paths, even when longer than the preferred
    // context. Never clip a face into a new globally classified source path.
    const preferred = native ? Math.max(NATIVE_ASSEMBLY_MINIMUM_SPAN_FT / scale, hi-lo+2*NATIVE_ASSEMBLY_CONTEXT_FT / scale) : maximum
    const width=Math.min(maximum,outerHi-outerLo,preferred),start=Math.max(outerLo,Math.min((lo+hi-width)/2,outerHi-width,lo)),end=Math.min(outerHi,Math.max(start+width,hi))
    return start<=lo&&end>=hi&&end-start<=maximum+1e-12?[start,end]:null
  }
  const visited=new Set<string>()
  for(const seed of assemblies){
    if(seed.pathIds.every(id=>suppliedPathIds.has(id)))continue
    if(seed.pathIds.length>pathLimit||seed.pathIds.some(id=>!eligible.has(id))){unframedAssemblyIds.push(seed.id);continue}
    const x=axis(seed.region.x0,seed.region.x1,r.x0,r.x1,capacity.x,sx),y=axis(seed.region.y0,seed.region.y1,r.y0,r.y1,capacity.y,sy)
    if(!x||!y){unframedAssemblyIds.push(seed.id);continue}
    const region={x0:x[0],y0:y[0],x1:x[1],y1:y[1]},key=JSON.stringify(region)
    if(visited.has(key))continue;visited.add(key)
    const available:RecognitionAssembly[]=[]
    for(const a of assemblies){
      if(++work>2_000_000){limited=true;break}
      if(a.pathIds.length<=pathLimit&&a.pathIds.every(id=>eligible.has(id)&&!suppliedPathIds.has(id))&&a.region.x0>=region.x0&&a.region.y0>=region.y0&&a.region.x1<=region.x1&&a.region.y1<=region.y1)available.push(a)
    }
    let batch:RecognitionAssembly[]=[],ids=new Set<number>()
    const flush=()=>{
      if(!ids.size)return
      const catalogue=visualPathCatalogue(input.evidence!,region,Infinity,{sx,sy}).filter(p=>ids.has(p.id))
      if(catalogue.length!==ids.size)throw Error('Incomplete assembly source catalogue')
      const bounds=(b:AreaRegion)=>[(b.x0-region.x0)/(region.x1-region.x0),(b.y0-region.y0)/(region.y1-region.y0),(b.x1-region.x0)/(region.x1-region.x0),(b.y1-region.y0)/(region.y1-region.y0)]
      const wallHypotheses=batch.flatMap(a=>a.wallHypothesis?[{binding:a.wallHypothesis,bounds:bounds(a.wallHypothesis.region)}]:[]);
      requests.push({region,catalogue,...(wallHypotheses.length?{wallHypotheses}:{}),assemblies:batch.map(a=>({id:a.id,hypothesis:a.hypothesis,pathIds:a.pathIds,bounds:bounds(a.region),...(a.measuredDepthFt===undefined?{}:{measuredDepthFt:a.measuredDepthFt}),...(a.measuredRadiusFt===undefined?{}:{measuredRadiusFt:a.measuredRadiusFt}),measuredSpanFt:a.measuredSpanFt}))})
      ids.forEach(id=>suppliedPathIds.add(id));batch=[];ids=new Set()
    }
    for(const a of available){
      if(a.pathIds.some(id=>suppliedPathIds.has(id)))continue
      const union=new Set([...ids,...a.pathIds]);if(union.size>pathLimit)flush()
      // Flushing may have supplied a path shared with this competing proposal.
      if(a.pathIds.some(id=>suppliedPathIds.has(id)))continue
      a.pathIds.forEach(id=>ids.add(id));batch.push(a)
    }
    flush()
    if(work>2_000_000)break
  }
  // New outline inspection must not exhaust every batch in one image before
  // observed swings in other source contexts receive their first inspection.
  requests.sort((a,b)=>Math.min(...(a.assemblies??[]).map(h=>assemblyRank(h.hypothesis)))-Math.min(...(b.assemblies??[]).map(h=>assemblyRank(h.hypothesis))));
  if (native) {
    const spans = planUnassignedWallSpans({assemblies,requests,region:r,sx,sy,capacity,remainingWork:Math.max(0,2_000_000-work)})
    requests.push(...spans.requests)
    unframedAssemblyIds.push(...spans.unframedIds)
    limited ||= spans.limited
  }
  return {requests,suppliedPathIds,candidateAssemblies:assemblies.length,unframedAssemblyIds:[...new Set(unframedAssemblyIds)],limited}
}
