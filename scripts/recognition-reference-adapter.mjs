/** Frozen development references -> protocol 1.0.0 diagnostic coordinates.
 * Never fits predictions to reference geometry or discards external adjacency. */
import fs from 'node:fs'
import {createHash} from 'node:crypto'
import {polygonIoU,oneToOneMatch,MATCHING_TOLERANCES,matchOpeningHosts,scoreOpenings} from './recognition-metrics.mjs'
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex')
const EPS=1e-10
const cross=(a,b)=>a[0]*b[1]-a[1]*b[0]
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1]]
const at=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]
const distance=(a,b)=>Math.hypot(...sub(a,b))
function point(p){if(!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite))throw Error('Invalid coordinate');return p}
function ring(r){if(!Array.isArray(r)||r.some(p=>point(p).some(v=>v<0||v>1)))throw Error('Scope must use normalized original-page coordinates');polygonIoU({polygon:r,holes:[]},{polygon:r,holes:[]});return r}
export function inside(p,polygon){
  point(p);let yes=false
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[j],b=polygon[i],v=sub(b,a),q=sub(p,a),n=v[0]*v[0]+v[1]*v[1]
    if(n>0&&Math.abs(cross(q,v))<EPS&&q[0]*v[0]+q[1]*v[1]>=-EPS&&q[0]*v[0]+q[1]*v[1]<=n+EPS)return true
    if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes
  }
  return yes
}
/** Parametric intervals preserve concave scope gaps; bounding boxes cannot. */
export function clipSegment(a,b,polygon){
  point(a);point(b);ring(polygon)
  const v=sub(b,a),n=v[0]*v[0]+v[1]*v[1],cuts=[0,1]
  if(n<EPS*EPS)throw Error('Zero-length segment')
  for(let i=0;i<polygon.length;i++){
    const c=polygon[i],d=polygon[(i+1)%polygon.length],w=sub(d,c),q=sub(c,a),den=cross(v,w)
    if(Math.abs(den)>EPS){const t=cross(q,w)/den,u=cross(q,v)/den;if(t>=-EPS&&t<=1+EPS&&u>=-EPS&&u<=1+EPS)cuts.push(Math.max(0,Math.min(1,t)))}
    else if(Math.abs(cross(q,v))<EPS)for(const p of [c,d]){const z=sub(p,a),t=(z[0]*v[0]+z[1]*v[1])/n;if(t>0&&t<1)cuts.push(t)}
  }
  const sorted=cuts.sort((a,b)=>a-b).filter((x,i,all)=>!i||x-all[i-1]>EPS),out=[]
  for(let i=1;i<sorted.length;i++){const lo=sorted[i-1],hi=sorted[i];if(hi-lo>EPS&&inside(at(a,b,(lo+hi)/2),polygon)){
    const previous=out.at(-1);if(previous&&Math.abs(previous[1]-lo)<EPS)previous[1]=hi;else out.push([lo,hi])
  }}
  return out
}
function unique(items,label){if(!Array.isArray(items)||new Set(items.map(o=>o.id)).size!==items.length||items.some(o=>typeof o.id!=='string'||!o.id))throw Error(`Invalid ${label} identities`)}
function select(items,ids,label){unique(items,label);if(!Array.isArray(ids)||new Set(ids).size!==ids.length)throw Error(`Missing ${label} scope identities`);return ids.map(id=>{const obj=items.find(o=>o.id===id);if(!obj)throw Error(`Unknown scoped ${label}: ${id}`);return obj})}
function kind(value){const canonical=value==='hinged_door'?'door':value;if(!['door','window','cased'].includes(canonical))throw Error('Unsupported opening kind');return canonical}
function nominalWall(w,convert){if(!Number.isFinite(w.thicknessInches)||w.thicknessInches<=0)throw Error('Missing reference thickness');return{id:w.id,a:convert(point(w.a)),b:convert(point(w.b)),thicknessFt:w.thicknessInches/12}}
export function adaptReference(reference,regionId){
  const scope=reference.scope?.scoringRegions?.find(s=>s.id===regionId)
  if(!scope||scope.complete!==true||(scope.unknownObjectsWithinRegion?.length??0)>0)throw Error('Scoring region must be explicitly complete with no unknown objects')
  const polygon=ring(scope.polygon),c=reference.calibration,b=reference.source?.pageBounds
  if(!(/^(verified_|two-axis-verified-)/.test(c?.status??''))||![c.pdfPointsPerFootX,c.pdfPointsPerFootY].every(n=>Number.isFinite(n)&&n>0)||!Array.isArray(b)||b.length!==4||!b.every(Number.isFinite)||b[2]<=b[0]||b[3]<=b[1])throw Error('Verified source calibration and page bounds are required')
  const checks=c.dimensionChecks??[]
  if(checks.length<2||!['x','y'].every(axis=>checks.some(d=>(d.axis??(Math.abs((d.b?.[0]??NaN)-(d.a?.[0]??NaN))>Math.abs((d.b?.[1]??NaN)-(d.a?.[1]??NaN))?'x':'y'))===axis)))throw Error('Both source calibration axes must have dimension evidence')
  const xScale=(b[2]-b[0])/c.pdfPointsPerFootX,yScale=(b[3]-b[1])/c.pdfPointsPerFootY
  const convert=p=>[p[0]*xScale,p[1]*yScale]
  const walls=select(reference.walls,scope.wallIds,'wall'),openings=select(reference.openings,scope.openingIds,'opening'),rooms=select(reference.rooms,scope.roomIds,'room')
  const runIds=scope.wallRunIds??reference.wallRuns?.filter(r=>r.scoringRegionId===regionId).map(r=>r.id)
  const runs=select(reference.wallRuns,runIds,'host run')
  const clipWall=w=>clipSegment(w.a,w.b,polygon).map(([lo,hi],index)=>nominalWall({...w,id:`${w.id}:scope-${index}`,a:at(w.a,w.b,lo),b:at(w.a,w.b,hi)},convert))
  for(const o of openings){const host=o.hostRunId??o.hostWallRunId;if(!runIds.includes(host)||!clipSegment(o.a,o.b,polygon).length)throw Error('Reference opening needs a scoped host and visible aperture')}
  for(const r of rooms){polygonIoU({polygon:r.polygon,holes:r.holes??[]},{polygon,holes:[]});if(r.polygon.some(p=>!inside(p,polygon)))throw Error('Reference room crosses incomplete scoring boundary')}
  return{scopeId:regionId,polygon,physicalScope:{polygon:polygon.map(convert),holes:[]},
    coordinateFrame:'page-origin feet; x right, y down; source dimensions frozen before scoring',calibration:{xScale,yScale,source:c},
    walls:walls.flatMap(clipWall),hostRuns:runs.flatMap(r=>clipSegment(r.a,r.b,polygon).map(([lo,hi],i)=>({...nominalWall({...r,a:at(r.a,r.b,lo),b:at(r.a,r.b,hi)},convert),id:`${r.id}:scope-${i}`,semanticId:r.id}))),
    openings:openings.map(o=>({id:o.id,a:convert(o.a),b:convert(o.b),kind:kind(o.kind),hostWallId:o.hostRunId??o.hostWallRunId})),
    rooms:rooms.map(r=>({id:r.id,polygon:r.polygon.map(convert),holes:(r.holes??[]).map(h=>h.map(convert)),adjacentRoomIds:r.adjacentRoomIds,boundaryAdjacencyIds:r.boundaryAdjacencyIds??[]})),
    externalContext:{contextRegions:reference.contextRegions??[],boundaryAdjacencies:reference.boundaryAdjacencies??[]},
    referenceUncertainty:{scope:reference.uncertainty??null,walls:walls.map(w=>({id:w.id,uncertainty:w.uncertainty??null,eligibility:w.scoreEligibility??null})),openings:openings.map(o=>({id:o.id,uncertainty:o.uncertainty??null,eligibility:o.scoreEligibility??null})),rooms:rooms.map(r=>({id:r.id,uncertainty:r.uncertainty??null,eligibility:r.scoreEligibility??null}))},
    strictPhysicalQualification:'unverified; nominal diagnostics do not propagate reference uncertainty',wholeProjectQualified:false}
}
/** Use original prediction scale. Normalized source coordinates ONLY choose
 * scope; they never replace the predicted physical geometry with truth scale. */
export function adaptPrediction(level,reference){
  const s=level.source,sx=s?.imageWidth*s?.feetPerImagePx,sy=s?.imageHeight*s?.feetPerImagePx
  if(![sx,sy].every(n=>Number.isFinite(n)&&n>0)||s.originPxX!==0||s.originPxY!==0)throw Error('Prediction requires calibrated original-page origin')
  unique(level.walls,'prediction wall');unique(level.openings,'prediction opening');unique(level.rooms,'prediction room')
  const normalized=p=>[p[0]/sx,p[1]/sy],wallMap=new Map(),openingMap=new Map(),openings=[],hostRuns=[],walls=[]
  for(const w of level.walls){const a=point([w.x0,w.y0]),b=point([w.x1,w.y1]),size=distance(a,b);if(size<=EPS||!Number.isFinite(w.thicknessFt)||w.thicknessFt<=0)throw Error('Invalid predicted wall');wallMap.set(w.id,{id:w.id,a,b,size,thicknessFt:w.thicknessFt})}
  for(const o of level.openings){const w=wallMap.get(o.wallId);if(!w||!Number.isFinite(o.offsetFt)||!Number.isFinite(o.widthFt)||o.widthFt<=0||o.offsetFt<-1e-7||o.offsetFt+o.widthFt>w.size+1e-7)throw Error(`Invalid predicted opening host/extent: ${o.id}`)
    const lo=o.offsetFt/w.size,hi=(o.offsetFt+o.widthFt)/w.size,a=at(w.a,w.b,lo),b=at(w.a,w.b,hi)
    const list=openingMap.get(w.id)??[];list.push([lo,hi]);openingMap.set(w.id,list)
    if(clipSegment(normalized(a),normalized(b),reference.polygon).length)openings.push({id:o.id,a,b,kind:kind(o.kind),hostWallId:w.id})
  }
  for(const w of wallMap.values()){
    const scoped=clipSegment(normalized(w.a),normalized(w.b),reference.polygon)
    scoped.forEach(([lo,hi],i)=>hostRuns.push({id:`${w.id}:scope-${i}`,semanticId:w.id,a:at(w.a,w.b,lo),b:at(w.a,w.b,hi),thicknessFt:w.thicknessFt}))
    let solid=[[0,1]]
    for(const [lo,hi] of openingMap.get(w.id)??[])solid=solid.flatMap(([a,b])=>hi<=a||lo>=b?[[a,b]]:[[a,Math.max(a,lo)],[Math.min(b,hi),b]].filter(([a,b])=>b-a>EPS))
    let index=0
    for(const [a,b] of solid)for(const [lo,hi] of scoped){const start=Math.max(a,lo),end=Math.min(b,hi);if(end-start>EPS)walls.push({id:`${w.id}:body-${index++}`,a:at(w.a,w.b,start),b:at(w.a,w.b,end),thicknessFt:w.thicknessFt})}
  }
  const physicalPredictionScope={polygon:reference.polygon.map(p=>[p[0]*sx,p[1]*sy]),holes:[]}
  const rooms=level.rooms.filter(r=>polygonIoU(r,physicalPredictionScope).intersectionSqft>1e-6).map(r=>({id:r.id,polygon:r.polygon,holes:r.holes??[],adjacentRoomIds:r.adjacentRoomIds??null,label:r.label??null}))
  return{walls,hostRuns,openings,rooms,calibration:{xScale:sx,yScale:sy,xRelativeDifference:sx/reference.calibration.xScale-1,yRelativeDifference:sy/reference.calibration.yScale-1,alignment:'none'},
    scopePolicy:'Opaque wall spans clipped in original source frame; apertures and intersecting rooms retain complete geometry to expose width errors, merges and boundary errors',
    adjacencyStatus:rooms.every(r=>Array.isArray(r.adjacentRoomIds))?'requires mapped external-context verification':'unavailable in floorplan projection',excludedCounts:{walls:level.walls.length-new Set(hostRuns.map(w=>w.semanticId)).size,openings:level.openings.length-openings.length,rooms:level.rooms.length-rooms.length}}
}
export function scoreScopedOpeningGeometry(reference,prediction){
  const refRuns=new Map(reference.hostRuns.map(r=>[r.id,r.semanticId])),predRuns=new Map(prediction.hostRuns.map(r=>[r.id,r.semanticId]))
  const matches=matchOpeningHosts(reference.hostRuns,prediction.hostRuns).map(m=>({...m,referenceWallId:refRuns.get(m.referenceWallId),predictionWallId:predRuns.get(m.predictionWallId)}))
  return scoreOpenings(reference.openings,prediction.openings,matches)
}
/** Geometry-only result is named explicitly; it cannot pass the room gate. */
export function scoreScopedRoomGeometry(reference,prediction){
  const overlaps=[],candidates=[]
  for(let i=0;i<reference.length;i++)for(let j=0;j<prediction.length;j++){
    const comparison=polygonIoU(reference[i],prediction[j]);if(comparison.intersectionSqft>1e-6)overlaps.push({referenceId:reference[i].id,predictionId:prediction[j].id,...comparison})
    if(comparison.iou>=MATCHING_TOLERANCES.roomIoU)candidates.push({left:i,right:j,cost:1-comparison.iou,...comparison})
  }
  const matches=oneToOneMatch(reference.length,prediction.length,candidates).map(m=>({referenceId:reference[m.left].id,predictionId:prediction[m.right].id,iou:m.iou}))
  return{referenceRooms:reference.length,predictionRooms:prediction.length,nominalGeometryMatches:matches.length,nominalGeometryRecall:reference.length?matches.length/reference.length:null,matches,overlaps,
    expectedAdjacency:reference.map(r=>({id:r.id,adjacentRoomIds:r.adjacentRoomIds,boundaryAdjacencyIds:r.boundaryAdjacencyIds})),adjacencyStatus:'unverified; external context and prediction adjacency are not silently removed',correctlyReconstructedFraction:null}
}
function verifiedFile(file,expected){if(!/^[a-f0-9]{64}$/.test(expected))throw Error('Missing frozen SHA256');const bytes=fs.readFileSync(file);if(sha256(bytes)!==expected)throw Error(`Frozen artifact changed: ${file}`);return bytes}
export function loadFrozenReference(item){
  if(item.split!=='development')throw Error('Scoped diagnostic accepts development cases only')
  const reference=JSON.parse(verifiedFile(item.referenceFile,item.referenceSha256))
  const f=reference.freeze,p=reference.provenance
  if(!(f?.status==='frozen-before-any-engine-scoring'||(f?.phase==='source_annotation_frozen_before_scoring'&&f.scoringPerformed===false))||p?.engineCodeSeen!==false||p?.enginePredictionsSeen!==false||(p?.engineBenchmarksSeen??p?.benchmarkResultsSeen)!==false||(p?.engineOverlaysSeen!==undefined&&p.engineOverlaysSeen!==false))throw Error('Source-only pre-scoring freeze attestation required')
  const manifestPath=f.manifestPath??f.hashFile
  if(typeof manifestPath!=='string')throw Error('Missing reference freeze manifest')
  const entries=fs.readFileSync(manifestPath,'utf8').trim().split('\n').map(line=>{const m=/^([a-f0-9]{64})\s+(.+)$/.exec(line);if(!m)throw Error('Invalid freeze hash manifest');return{hash:m[1],file:m[2]}})
  if(!entries.some(e=>e.file===item.referenceFile&&e.hash===item.referenceSha256))throw Error('Reference absent from freeze manifest')
  entries.forEach(e=>verifiedFile(e.file,e.hash))
  const inputs=p.inputFiles??Object.values(p.inputAnnotations??{}).flatMap(o=>[{path:o.jsonPath,sha256:o.jsonSha256},{path:o.markdownPath,sha256:o.markdownSha256}])
  const paired=p.inputFiles?['author','blind'].every(role=>inputs.some(o=>o.role?.startsWith('source_only_'+role+'_'))):Boolean(p.inputAnnotations?.author&&p.inputAnnotations?.blind)
  if(!inputs.length||!paired)throw Error('Separate author and blind source reviewer provenance files are required')
  inputs.forEach(o=>verifiedFile(o.path,o.sha256))
  verifiedFile(reference.source.file,reference.source.sha256)
  return reference
}
