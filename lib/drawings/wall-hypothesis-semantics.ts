import type { AreaEvidence, AreaPoint } from './area-evidence'
import type { AreaRegion } from './area-takeoff'
import type { AreaVisualObservation } from './area-semantics'
import type { VectorWallHypothesis, VectorWallNetwork } from './vector-wall-network'
import { rasterSourceFaces } from './raster-source-faces'
import { validRecognitionImageSource } from './recognition-image-source'

/** A decision about this exact measured span, never its complete parent paths. */
export interface WallHypothesisBinding {
  id: string
  pathIds: [number, number]
  a: AreaPoint
  b: AreaPoint
  thicknessFt: number
  region: AreaRegion
  /** Exact source/calibration witness retained locally, not shown as model instructions. */
  witness: string
}

export function bindWallHypothesis(evidence: AreaEvidence, body: VectorWallHypothesis, sx: number, sy: number): WallHypothesisBinding | null {
  if (!evidence.raster || evidence.truncated || ![sx,sy].every(n=>Number.isFinite(n)&&n>0)) return null
  const faces=rasterSourceFaces(evidence,{bodies:[body],limited:false},sx,sy)
  if (faces.length!==2) return null
  const points=faces.flatMap(f=>[f.a,f.b]),pathIds=[...body.pathIds].sort((a,b)=>a-b) as [number,number]
  const paths=pathIds.map(id=>evidence.paths.find(p=>p.id===id))
  if (paths.some(p=>!p)) return null
  const region={x0:Math.min(...points.map(p=>p[0])),y0:Math.min(...points.map(p=>p[1])),x1:Math.max(...points.map(p=>p[0])),y1:Math.max(...points.map(p=>p[1]))}
  // Include original measured source, not merely rounded endpoints. Changed
  // pixel evidence, page-window provenance or calibration invalidates the vote.
  const witness=JSON.stringify([evidence.extractionProfile,evidence.raster,sx,sy,
    paths,evidence.rasterPairPaint?.filter(p=>p&&Array.isArray(p.pathIds)&&p.pathIds.length===2&&p.pathIds.every(id=>pathIds.includes(id))),
    body.a,body.b,body.thicknessFt,body.sourceBand??null])
  return {id:`wall-pair:${pathIds.join(':')}`,pathIds,a:body.a,b:body.b,thicknessFt:body.thicknessFt,region,witness}
}

/** Recompute all ownership from source. A provider supplies meaning only;
 * fabricated IDs, stale witnesses, incomplete images and conflicting decisions
 * cannot establish a wall. Source parent roles/coverage remain untouched. */
export function withLocalizedWallDecisions(network: VectorWallNetwork, evidence: AreaEvidence | null | undefined, observations: readonly AreaVisualObservation[] | undefined, sx: number, sy: number): VectorWallNetwork {
  if (!evidence?.raster || network.limited || !observations?.length) return network
  const candidates=new Map<string,{body:VectorWallHypothesis;binding:WallHypothesisBinding}>(),ambiguous=new Set<string>()
  for(const body of network.candidates){const binding=bindWallHypothesis(evidence,body,sx,sy);if(!binding)continue;const previous=candidates.get(binding.id);if(previous&&previous.binding.witness!==binding.witness)ambiguous.add(binding.id);else candidates.set(binding.id,{body,binding})}
  const votes=new Map<string,Set<string>>()
  for(const observation of observations){
    if(!Array.isArray(observation.suppliedWallHypotheses)||!Array.isArray(observation.wallHypotheses)||observation.suppliedWallHypotheses.some(b=>!b||typeof b.id!=='string')||observation.wallHypotheses.some(d=>!d||typeof d.hypothesisId!=='string'||!['wall','not-wall','unknown'].includes(d.kind)))continue
    const image=observation.sourceImage
    if(!validRecognitionImageSource(image)||image.kind!=='original-pdf'||!image.nativeDensityPreserved||image.sourceHash!==evidence.raster.sourceHash)continue
    const r=observation.region
    if(![image.requestedRegion,image.sourceRegion].some(frame=>['x0','y0','x1','y1'].every(k=>Math.abs(frame[k as keyof AreaRegion]-r[k as keyof AreaRegion])<1e-10)))continue
    const supplied=new Map(observation.suppliedWallHypotheses.map(b=>[b.id,b])),duplicates=new Set<string>()
    if(supplied.size!==observation.suppliedWallHypotheses.length)continue
    for(const decision of observation.wallHypotheses??[]){
      const {hypothesisId:id,kind}=decision,candidate=candidates.get(id),binding=supplied.get(id)
      if(!candidate||ambiguous.has(id)||!binding||binding.witness!==candidate.binding.witness||JSON.stringify(binding)!==JSON.stringify(candidate.binding))continue
      const b=candidate.binding.region
      if(b.x0<r.x0-1e-10||b.y0<r.y0-1e-10||b.x1>r.x1+1e-10||b.y1>r.y1+1e-10)continue
      const set=votes.get(id)??new Set<string>();if(duplicates.has(id))set.add('duplicate');duplicates.add(id)
      if(kind!=='unknown')set.add(kind);votes.set(id,set)
    }
  }
  const represented=new Set(network.bodies.map(b=>bindWallHypothesis(evidence,b,sx,sy)?.witness)),added:VectorWallHypothesis[]=[]
  const conflicts:Array<{id:string;pathIds:number[];point:AreaPoint}>=[]
  for(const [id,{binding}] of candidates){const set=votes.get(id);if(set?.has('not-wall')&&(set.has('wall')||represented.has(binding.witness)))conflicts.push({id,pathIds:binding.pathIds,point:[(binding.a[0]+binding.b[0])/2,(binding.a[1]+binding.b[1])/2]})}
  for(const [id,{body,binding}] of candidates){const set=votes.get(id);if(set?.size===1&&set.has('wall')&&!represented.has(binding.witness)){added.push(body);represented.add(binding.witness)}}
  if(!added.length&&!conflicts.length)return network
  const ids=[...new Set(added.flatMap(b=>b.pathIds))]
  return {...network,bodies:[...network.bodies,...added],pathIds:new Set([...network.pathIds,...ids]),diagnostics:{...network.diagnostics,localizedPairs:added.length,localizedPairPathIds:ids,...(conflicts.length?{localizedPairConflicts:conflicts}:{})}}
}
