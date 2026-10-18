/** Protocol 1.0.0 geometric primitives. Inputs must already share verified feet
 * coordinates and a complete scoring scope. These functions cannot certify a
 * reference, calibration, holdout split or release readiness. */
import {ShapeUtils,Vector2} from 'three'
export const MATCHING_TOLERANCES=Object.freeze({wallDistanceFt:1/12,wallAngleDegrees:1,wallThicknessFt:1/12,openingEndpointFt:2/12,openingAngleDegrees:2,roomIoU:.95})
const length=s=>Math.hypot(s.b[0]-s.a[0],s.b[1]-s.a[1])
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1]]
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x))
function validateSegments(items,walls=false){
  const ids=new Set()
  for(const s of items){
    if(typeof s.id!=='string'||!s.id||ids.has(s.id)||![s.a,s.b].every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite))||length(s)<1e-8)throw Error('Invalid or duplicate physical segment')
    if(walls&&(!Number.isFinite(s.thicknessFt)||s.thicknessFt<=0))throw Error('Wall thickness must be measured in feet')
    ids.add(s.id)
  }
}
function frame(s){const size=length(s),v=sub(s.b,s.a);return{size,u:[v[0]/size,v[1]/size]}}
function angle(a,b){return Math.acos(clamp(Math.abs(dot(frame(a).u,frame(b).u)),-1,1))*180/Math.PI}
function wallOverlap(target,other){
  const t=MATCHING_TOLERANCES
  if(angle(target,other)>t.wallAngleDegrees+1e-8||Math.abs(target.thicknessFt-other.thicknessFt)>t.wallThicknessFt+1e-8)return null
  const {size,u}=frame(target),p=[dot(sub(other.a,target.a),u),dot(sub(other.b,target.a),u)].sort((a,b)=>a-b)
  const start=Math.max(0,p[0]),end=Math.min(size,p[1])
  if(end<=start+1e-8)return null
  // Check displacement over the entire corresponding interval, rather than
  // accepting a long diverging wall because its midpoint happens to coincide.
  const v=sub(other.b,other.a),along=dot(v,u)
  for(const x of [start,end]){
    const k=(x-dot(sub(other.a,target.a),u))/along,q=[other.a[0]+k*v[0],other.a[1]+k*v[1]],r=[target.a[0]+x*u[0],target.a[1]+x*u[1]]
    if(Math.hypot(q[0]-r[0],q[1]-r[1])>t.wallDistanceFt+1e-8)return null
  }
  return[start,end]
}
function unionLength(intervals){
  let sum=0,end=-Infinity
  for(const [a,b] of intervals.slice().sort((a,b)=>a[0]-b[0])){sum+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b)}
  return sum
}
export function scoreWalls(reference,prediction){
  validateSegments(reference,true);validateSegments(prediction,true)
  for(let i=0;i<reference.length;i++)for(let j=i+1;j<reference.length;j++){
    const overlap=wallOverlap(reference[i],reference[j])
    if(overlap&&overlap[1]-overlap[0]>1e-6)throw Error('Reference wall spans overlap; adjudicate before scoring')
  }
  const coverage=(items,others)=>items.map(s=>{
    const matches=others.flatMap(o=>{const interval=wallOverlap(s,o);return interval?[{id:o.id,interval}]:[]})
    return{id:s.id,lengthFt:length(s),coveredFt:unionLength(matches.map(m=>m.interval)),matches}
  })
  const truth=coverage(reference,prediction),predicted=coverage(prediction,reference)
  const total=rows=>rows.reduce((s,r)=>s+r.lengthFt,0),covered=rows=>rows.reduce((s,r)=>s+r.coveredFt,0)
  const referenceFt=total(truth),predictionFt=total(predicted)
  // Matched physical length cannot be credited twice to overlapping/duplicate
  // predictions. A split at a shared endpoint keeps the same total credit.
  const creditedFt=Math.min(covered(truth),covered(predicted))
  return{units:'feet',referenceFt,predictionFt,creditedFt,missedFt:Math.max(0,referenceFt-creditedFt),inventedOrDuplicateFt:Math.max(0,predictionFt-creditedFt),
    precision:predictionFt?creditedFt/predictionFt:null,recall:referenceFt?creditedFt/referenceFt:null,referenceCoverage:truth,predictionCoverage:predicted}
}

/** Host runs describe measured wall assemblies across their apertures. They
 * are relationships, not opaque body spans counted by scoreWalls. Keeping the
 * two separate avoids treating every correctly modeled opening as a false wall
 * or rejecting its host because the doorway is absent from the solid bodies. */
export function matchOpeningHosts(referenceRuns,predictionRuns){
  validateSegments(referenceRuns,true);validateSegments(predictionRuns,true)
  return referenceRuns.flatMap(r=>predictionRuns.flatMap(p=>{
    const interval=wallOverlap(r,p);if(!interval)return[]
    const u=frame(r).u,at=t=>[r.a[0]+u[0]*t,r.a[1]+u[1]*t]
    return[{referenceWallId:r.id,predictionWallId:p.id,referenceIntervalFt:interval,referenceSpan:{a:at(interval[0]),b:at(interval[1])}}]
  }))
}

/** Successive shortest augmenting paths: maximize match count first, then
 * minimize total geometric error. Greedy nearest-neighbour matching can hide
 * a missed opening when two predictions compete for the same reference. */
export function oneToOneMatch(leftCount,rightCount,candidates){
  if(!Number.isInteger(leftCount)||leftCount<0||!Number.isInteger(rightCount)||rightCount<0)throw Error('Invalid matching dimensions')
  const source=leftCount+rightCount,sink=source+1,n=sink+1,graph=Array.from({length:n},()=>[]),original=[]
  const add=(a,b,cost,tag)=>{const edge={to:b,cost,cap:1,reverse:graph[b].length,tag};graph[a].push(edge);graph[b].push({to:a,cost:-cost,cap:0,reverse:graph[a].length-1});return edge}
  for(let i=0;i<leftCount;i++)add(source,i,0)
  for(let j=0;j<rightCount;j++)add(leftCount+j,sink,0)
  const seen=new Set()
  for(const c of candidates.slice().sort((a,b)=>a.left-b.left||a.right-b.right)){
    if(!Number.isInteger(c.left)||c.left<0||c.left>=leftCount||!Number.isInteger(c.right)||c.right<0||c.right>=rightCount||!Number.isFinite(c.cost)||c.cost<0||seen.has(`${c.left}:${c.right}`))throw Error('Invalid matching candidate')
    seen.add(`${c.left}:${c.right}`);original.push({candidate:c,edge:add(c.left,leftCount+c.right,c.cost,c)})
  }
  for(;;){
    const distance=Array(n).fill(Infinity),previous=Array(n);distance[source]=0
    for(let iteration=0;iteration<n-1;iteration++){
      let changed=false
      for(let a=0;a<n;a++)if(Number.isFinite(distance[a]))for(let k=0;k<graph[a].length;k++){
        const e=graph[a][k]
        if(e.cap&&distance[a]+e.cost<distance[e.to]-1e-12){distance[e.to]=distance[a]+e.cost;previous[e.to]=[a,k];changed=true}
      }
      if(!changed)break
    }
    if(!previous[sink])break
    for(let at=sink;at!==source;){const[a,k]=previous[at],edge=graph[a][k];edge.cap=0;graph[at][edge.reverse].cap=1;at=a}
  }
  return original.filter(o=>o.edge.cap===0).map(o=>o.candidate)
}
export function scoreOpenings(reference,prediction,hostMatches){
  validateSegments(reference);validateSegments(prediction)
  for(const o of [...reference,...prediction])if(!['door','window','cased'].includes(o.kind)||typeof o.hostWallId!=='string')throw Error('Opening type and physical host are required')
  const candidates=[]
  for(const m of hostMatches)validateSegments([{id:'host-span',...m.referenceSpan}])
  for(let i=0;i<reference.length;i++)for(let j=0;j<prediction.length;j++){
    const a=reference[i],b=prediction[j]
    const hostSupported=hostMatches.some(m=>{
      if(m.referenceWallId!==a.hostWallId||m.predictionWallId!==b.hostWallId)return false
      const span=m.referenceSpan,{size,u}=frame(span),tolerance=MATCHING_TOLERANCES.openingEndpointFt
      // A match on a distant part of a long host must not establish this
      // opening's host relationship. Both opening endpoints need coverage.
      return[a.a,a.b].every(p=>{const d=sub(p,span.a),along=dot(d,u);return along>=-tolerance&&along<=size+tolerance&&Math.abs(d[0]*u[1]-d[1]*u[0])<=tolerance})
    })
    if(a.kind!==b.kind||!hostSupported||angle(a,b)>MATCHING_TOLERANCES.openingAngleDegrees+1e-8)continue
    const distance=(p,q)=>Math.hypot(p[0]-q[0],p[1]-q[1])
    const errors=[[distance(a.a,b.a),distance(a.b,b.b)],[distance(a.a,b.b),distance(a.b,b.a)]].sort((a,b)=>Math.max(...a)-Math.max(...b))[0]
    if(Math.max(...errors)<=MATCHING_TOLERANCES.openingEndpointFt+1e-8)candidates.push({left:i,right:j,cost:errors[0]+errors[1],endpointErrorsFt:errors,widthErrorFt:Math.abs(length(a)-length(b))})
  }
  const matches=oneToOneMatch(reference.length,prediction.length,candidates)
  const usedReference=new Set(matches.map(m=>m.left)),usedPrediction=new Set(matches.map(m=>m.right))
  return{truePositives:matches.length,falseNegatives:reference.length-matches.length,falsePositives:prediction.length-matches.length,
    precision:prediction.length?matches.length/prediction.length:null,recall:reference.length?matches.length/reference.length:null,
    matches:matches.map(m=>({referenceId:reference[m.left].id,predictionId:prediction[m.right].id,endpointErrorsFt:m.endpointErrorsFt,widthErrorFt:m.widthErrorFt})),
    missedIds:reference.filter((_,i)=>!usedReference.has(i)).map(o=>o.id),inventedOrDuplicateIds:prediction.filter((_,i)=>!usedPrediction.has(i)).map(o=>o.id)}
}

const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
const signedArea=ring=>ring.reduce((s,p,i)=>{const q=ring[(i+1)%ring.length];return s+p[0]*q[1]-q[0]*p[1]},0)/2
function contains(p,ring){
  let inside=false
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i],b=ring[j]
    if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside
  }
  return inside
}
function touches(a,b,c,d){
  const on=(p,q,r)=>Math.abs(cross(p,q,r))<1e-9&&r[0]>=Math.min(p[0],q[0])-1e-9&&r[0]<=Math.max(p[0],q[0])+1e-9&&r[1]>=Math.min(p[1],q[1])-1e-9&&r[1]<=Math.max(p[1],q[1])+1e-9
  return(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b)
}
function ringsTouch(a,b){return a.some((p,i)=>b.some((q,j)=>touches(p,a[(i+1)%a.length],q,b[(j+1)%b.length])))}
function polygonTriangles(polygon){
  const rings=[polygon.polygon,...(polygon.holes??[])].map(r=>{
    if(!Array.isArray(r)||r.length<3||r.length>3000||r.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)))throw Error('Invalid polygon coordinates')
    const out=r.map(p=>[...p]);if(out.length>3&&out[0][0]===out.at(-1)[0]&&out[0][1]===out.at(-1)[1])out.pop()
    if(Math.abs(signedArea(out))<1e-8)throw Error('Degenerate polygon')
    for(let i=0;i<out.length;i++){
      if(Math.hypot(...sub(out[i],out[(i+1)%out.length]))<1e-9)throw Error('Duplicate polygon vertex')
      for(let j=i+2;j<out.length;j++)if(!(i===0&&j===out.length-1)&&touches(out[i],out[(i+1)%out.length],out[j],out[(j+1)%out.length]))throw Error('Self-intersecting polygon')
    }
    return out
  })
  for(let i=1;i<rings.length;i++){
    if(!contains(rings[i][0],rings[0])||ringsTouch(rings[i],rings[0]))throw Error('Hole is not strictly inside polygon')
    for(let j=1;j<i;j++)if(ringsTouch(rings[i],rings[j])||contains(rings[i][0],rings[j])||contains(rings[j][0],rings[i]))throw Error('Overlapping polygon holes')
  }
  const vectors=rings.map(r=>r.map(p=>new Vector2(...p))),vertices=vectors.flat()
  const triangles=ShapeUtils.triangulateShape(vectors[0],vectors.slice(1)).map(face=>face.map(i=>[vertices[i].x,vertices[i].y]))
  const area=Math.abs(signedArea(rings[0]))-rings.slice(1).reduce((s,r)=>s+Math.abs(signedArea(r)),0)
  if(Math.abs(triangles.reduce((s,t)=>s+Math.abs(signedArea(t)),0)-area)>Math.max(1e-7,area*1e-8))throw Error('Polygon triangulation disagrees with measured area')
  return{triangles,area}
}
function triangleIntersection(a,b){
  let output=a.map(p=>[...p]);const clip=signedArea(b)<0?b.slice().reverse():b
  for(let i=0;i<3&&output.length;i++){
    const c=clip[i],d=clip[(i+1)%3],input=output;output=[]
    for(let j=0;j<input.length;j++){
      const p=input[j],q=input[(j+1)%input.length],ps=cross(c,d,p),qs=cross(c,d,q),pin=ps>=-1e-10,qin=qs>=-1e-10
      if(pin)output.push(p)
      if(pin!==qin){const t=ps/(ps-qs);output.push([p[0]+t*(q[0]-p[0]),p[1]+t*(q[1]-p[1])])}
    }
  }
  return output.length>=3?Math.abs(signedArea(output)):0
}
function polygonComparison(a,b){
  let intersection=0
  for(const x of a.triangles)for(const y of b.triangles)intersection+=triangleIntersection(x,y)
  intersection=clamp(intersection,0,Math.min(a.area,b.area))
  return{intersectionSqft:intersection,unionSqft:a.area+b.area-intersection,iou:intersection/(a.area+b.area-intersection),referenceAreaSqft:a.area,predictionAreaSqft:b.area}
}
export function polygonIoU(reference,prediction){return polygonComparison(polygonTriangles(reference),polygonTriangles(prediction))}
export function scoreRooms(reference,prediction){
  for(const list of [reference,prediction]){
    const ids=new Set(list.map(r=>r.id))
    if(ids.size!==list.length||list.some(r=>typeof r.id!=='string'||!r.id||!Array.isArray(r.adjacentRoomIds)||new Set(r.adjacentRoomIds).size!==r.adjacentRoomIds.length||r.adjacentRoomIds.some(id=>id===r.id||!ids.has(id))))throw Error('Invalid room identity or adjacency')
    if(list.some(r=>r.adjacentRoomIds.some(id=>!list.find(o=>o.id===id).adjacentRoomIds.includes(r.id))))throw Error('Room adjacency must be reciprocal')
  }
  const truth=reference.map(polygonTriangles),predicted=prediction.map(polygonTriangles),candidates=[],overlaps=[]
  for(let i=0;i<truth.length;i++)for(let j=i+1;j<truth.length;j++)if(polygonComparison(truth[i],truth[j]).intersectionSqft>1e-6)throw Error('Reference rooms overlap; adjudicate boundaries before scoring')
  for(let i=0;i<truth.length;i++)for(let j=0;j<predicted.length;j++){
    const comparison=polygonComparison(truth[i],predicted[j])
    if(comparison.intersectionSqft>1e-6)overlaps.push({referenceId:reference[i].id,predictionId:prediction[j].id,...comparison})
    if(comparison.iou>=MATCHING_TOLERANCES.roomIoU-1e-10)candidates.push({left:i,right:j,cost:1-comparison.iou,...comparison})
  }
  const assigned=oneToOneMatch(reference.length,prediction.length,candidates),mapping=new Map(assigned.map(m=>[prediction[m.right].id,reference[m.left].id]))
  const matches=assigned.map(m=>{
    const r=reference[m.left],p=prediction[m.right],adjacencyCorrect=r.adjacentRoomIds.length===p.adjacentRoomIds.length&&p.adjacentRoomIds.every(id=>r.adjacentRoomIds.includes(mapping.get(id)))
    return{referenceId:r.id,predictionId:p.id,iou:m.iou,adjacencyCorrect,areaErrorSqft:m.predictionAreaSqft-m.referenceAreaSqft,correct:adjacencyCorrect}
  })
  return{referenceRooms:reference.length,predictionRooms:prediction.length,correctRooms:matches.filter(m=>m.correct).length,
    correctlyReconstructedFraction:reference.length?matches.filter(m=>m.correct).length/reference.length:null,
    correctPredictionFraction:prediction.length?matches.filter(m=>m.correct).length/prediction.length:null,matches,
    missedOrIncorrectIds:reference.filter(r=>!matches.some(m=>m.referenceId===r.id&&m.correct)).map(r=>r.id),
    unmatchedPredictionIds:prediction.filter(p=>!mapping.has(p.id)).map(p=>p.id),overlaps}
}

const percentile95=values=>values.length?values.slice().sort((a,b)=>a-b)[Math.ceil(.95*values.length)-1]:null
export function scoreDimensions(measurements){
  const ids=new Set(),rows=measurements.map(m=>{
    if(typeof m.id!=='string'||!m.id||ids.has(m.id)||!Number.isFinite(m.referenceFt)||m.referenceFt<=0||!Number.isFinite(m.uncertaintyFt)||m.uncertaintyFt<0||m.uncertaintyFt>=m.referenceFt)throw Error('Explicit dimension and source uncertainty required')
    ids.add(m.id)
    if(m.predictionFt!==null&&(!Number.isFinite(m.predictionFt)||m.predictionFt<=0))throw Error('Dimension prediction must be feet or explicit null')
    const missing=m.predictionFt===null,error=missing?null:Math.abs(m.predictionFt-m.referenceFt),long=m.referenceFt>20
    return{id:m.id,bucket:long?'over-20ft':'through-20ft',referenceFt:m.referenceFt,predictionFt:m.predictionFt,uncertaintyFt:m.uncertaintyFt,
      errorFt:error,lower:missing?null:long?Math.max(0,error-m.uncertaintyFt)/(m.referenceFt+m.uncertaintyFt):Math.max(0,error-m.uncertaintyFt),
      upper:missing?null:long?(error+m.uncertaintyFt)/(m.referenceFt-m.uncertaintyFt):error+m.uncertaintyFt}
  })
  const buckets=['through-20ft','over-20ft'].map(name=>{
    const group=rows.filter(r=>r.bucket===name),known=group.filter(r=>r.errorFt!==null),missingIds=group.filter(r=>r.errorFt===null).map(r=>r.id)
    const limit=name==='through-20ft'?2/12:.01,lower=percentile95(known.map(r=>r.lower)),upper=percentile95(known.map(r=>r.upper))
    return{name,units:name==='through-20ft'?'feet':'relative-error',sampleCount:group.length,measuredCount:known.length,missingIds,limit,p95Lower:lower,p95Upper:upper,
      status:missingIds.length?'fail':!known.length?'unverified':upper<=limit+1e-12?'pass':lower>limit+1e-12?'fail':'unverified'}
  })
  return{percentileMethod:'nearest-rank',uncertaintyPolicy:'conservative source-uncertainty bounds; threshold-straddling results remain unverified',rows,buckets}
}
export function wilsonInterval(successes,total){
  if(!Number.isInteger(total)||total<0||!Number.isInteger(successes)||successes<0||successes>total)throw Error('Invalid independent trial count')
  if(!total)return null
  const z=1.959963984540054,p=successes/total,d=1+z*z/total,center=(p+z*z/(2*total))/d,margin=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/d
  return{confidence:.95,lower:Math.max(0,center-margin),upper:Math.min(1,center+margin),successes,total}
}
export function projectBootstrap(projects,{iterations=2000,seed=1729}={}){
  if(!Number.isInteger(iterations)||iterations<100||iterations>100000||!Number.isInteger(seed))throw Error('Invalid bootstrap settings')
  const ids=new Set()
  for(const p of projects){
    if(typeof p.id!=='string'||!p.id||ids.has(p.id)||!Number.isFinite(p.numerator)||!Number.isFinite(p.denominator)||p.denominator<=0||p.numerator<0||p.numerator>p.denominator)throw Error('Bootstrap requires one complete, unique row per independent project')
    ids.add(p.id)
  }
  if(!projects.length)return null
  let state=seed|0;if(!state)state=1729
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296}
  const samples=[]
  for(let i=0;i<iterations;i++){
    let numerator=0,denominator=0
    for(let j=0;j<projects.length;j++){const p=projects[Math.floor(random()*projects.length)];numerator+=p.numerator;denominator+=p.denominator}
    samples.push(numerator/denominator)
  }
  samples.sort((a,b)=>a-b)
  return{confidence:.95,method:'project-cluster percentile bootstrap',seed,iterations,projectCount:projects.length,
    pooled:projects.reduce((s,p)=>s+p.numerator,0)/projects.reduce((s,p)=>s+p.denominator,0),macroMean:projects.reduce((s,p)=>s+p.numerator/p.denominator,0)/projects.length,
    lower:samples[Math.max(0,Math.ceil(.025*iterations)-1)],upper:samples[Math.ceil(.975*iterations)-1],smallSampleWarning:projects.length<30}
}
