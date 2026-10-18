import type { AreaBoundary } from './area-takeoff'
import type { AreaEvidence, AreaPoint } from './area-evidence'
import type { ArchitecturalKind } from './area-semantics'
const sub=(a:AreaPoint,b:AreaPoint):AreaPoint=>[a[0]-b[0],a[1]-b[1]]
const dot=(a:AreaPoint,b:AreaPoint)=>a[0]*b[0]+a[1]*b[1]
const cross=(a:AreaPoint,b:AreaPoint)=>a[0]*b[1]-a[1]*b[0]
const size=(v:AreaPoint)=>Math.hypot(v[0],v[1])
/** Explicit door-layer panels can support pocket/sliding thresholds. A gap alone
 * is insufficient: require collinear wall faces, jambs and overlapping panels. */
export function slidingDoorThresholds(edges:AreaBoundary[],evidence?:AreaEvidence|null, swings: Array<{center:AreaPoint;ends:[AreaPoint,AreaPoint];pathId?:number}> = [], kinds?:ReadonlyMap<number,ArchitecturalKind>, sourceToleranceFt = .02):AreaBoundary[]{
  if(!evidence)return []
  const snap = Math.min(.1, Math.max(.02, sourceToleranceFt))
  const rasterJambDrift = evidence.raster ? Math.min(.04, evidence.raster.feetPerPixel * 2) : 0
  const wallIds=new Set(evidence.paths.filter(p=>kinds?.has(p.id)?kinds.get(p.id)==='wall':p.layer.some(l=>/(?:^|[-_ ])wall(?:$|[-_ ])/i.test(l))).map(p=>p.id))
  const doorIds=new Set(evidence.paths.filter(p=>kinds?.has(p.id)?kinds.get(p.id)==='door':p.layer.some(l=>/(?:^|[-_ ])door(?:$|[-_ ])/i.test(l))&&!p.layer.some(l=>/iden/i.test(l))).map(p=>p.id))
  const walls=edges.filter(e=>e.pathId!==undefined&&wallIds.has(e.pathId)), panels=edges.filter(e=>e.pathId!==undefined&&doorIds.has(e.pathId)&&size(sub(e.b,e.a))>=.5)
  const cadSwings = swings.filter(arc => arc.pathId !== undefined && doorIds.has(arc.pathId))
  const openings = cadSwings.flatMap(arc => arc.ends.map(end => ({a:arc.center,b:end})))
  for (let i=0;i<cadSwings.length;i++) for (let j=i+1;j<cadSwings.length;j++) {
    const a=cadSwings[i], b=cadSwings[j]
    if (a.ends.some(p=>b.ends.some(q=>size(sub(p,q))<.02 && Math.abs(size(sub(a.center,p))+size(sub(b.center,q))-size(sub(a.center,b.center)))<.02))) openings.push({a:a.center,b:b.center})
  }
  const result:AreaBoundary[]=[],seen=new Set<string>()

  const wallRuns=walls.map(edge=>({edge,vector:sub(edge.b,edge.a),length:size(sub(edge.b,edge.a))}))
  const jambGrid=new Map<string,typeof wallRuns>()
  for(const run of wallRuns) if(run.length>.08) for(const point of [run.edge.a,run.edge.b]) {
    const key=Math.floor(point[0]/snap)+':'+Math.floor(point[1]/snap)
    const bucket=jambGrid.get(key)??[];bucket.push(run);jambGrid.set(key,bucket)
  }
  const tips=wallRuns.filter(run=>run.length>.4).flatMap(({edge,vector,length})=>[
    {p:edge.a,vector,length},{p:edge.b,vector:sub(edge.a,edge.b),length}
  ]).sort((a,b)=>a.p[0]-b.p[0])
  for(let i=0;i<tips.length;i++)for(let j=i+1;j<tips.length;j++){
    const a=tips[i],b=tips[j]
    if(b.p[0]-a.p[0]>8)break
    if(Math.abs(b.p[1]-a.p[1])>8)continue
    const v=sub(b.p,a.p),len=size(v)
    if(len<1.5||len>8)continue
    const u:AreaPoint=[v[0]/len,v[1]/len],va=a.vector,vb=b.vector
    if(Math.abs(cross(u,va))/a.length>.01||Math.abs(cross(u,vb))/b.length>.01||dot(va,u)>=0||dot(vb,u)<=0)continue
    const jamb=(p:AreaPoint)=>{
      const x=Math.floor(p[0]/snap),y=Math.floor(p[1]/snap)
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const run of jambGrid.get((x+dx)+':'+(y+dy))??[]){
        if(Math.abs(dot(run.vector,u))<run.length*.02+rasterJambDrift&&Math.min(size(sub(run.edge.a,p)),size(sub(run.edge.b,p)))<=snap)return true
      }
      return false
    }
    if(!jamb(a.p)||!jamb(b.p))continue
    const pocketSides = new Set<number>()
    const supported=panels.some(e=>{
      const d=sub(e.b,e.a), panelLength=size(d)
      if(Math.abs(cross(u,d))/panelLength>.02||Math.abs(cross(u,sub(e.a,a.p)))>.5)return false
      const ts=[dot(sub(e.a,a.p),u),dot(sub(e.b,a.p),u)].sort((x,y)=>x-y)
      const overlap=Math.min(len,ts[1])-Math.max(0,ts[0])
      if(overlap>=Math.min(len,panelLength)*.4)return true
      // A retracted pocket leaf mostly sits inside its wall pocket. Require a
      // second panel face, leaf width matching the opening and the parked part
      // bracketed by parallel wall faces. Mere line proximity is insufficient.
      if(overlap<.08||overlap>panelLength*.5||panelLength>len+.4)return false
      const pairedPanel=panels.some(other=>{
        if(other===e)return false
        const v=sub(other.b,other.a),offset=Math.abs(cross(u,sub(other.a,e.a)))
        if(offset<.04||offset>.2||Math.abs(cross(u,v))/size(v)>.01)return false
        const ends=[dot(sub(other.a,e.a),u),dot(sub(other.b,e.a),u)].sort((x,y)=>x-y)
        const own=[0,dot(d,u)].sort((x,y)=>x-y)
        return Math.min(own[1],ends[1])-Math.max(own[0],ends[0])>=panelLength*.9
      })
      if(!pairedPanel)return false
      const parkedT=ts[0]<0 ? ts[0]/2 : (len+ts[1])/2
      const normalOffset=cross(u,sub(e.a,a.p))
      const parked:AreaPoint=[a.p[0]+u[0]*parkedT-u[1]*normalOffset,a.p[1]+u[1]*parkedT+u[0]*normalOffset]
      const sides=walls.flatMap(w=>{
        const v=sub(w.b,w.a)
        if(Math.abs(cross(u,v))/size(v)>.01)return []
        const t=dot(sub(parked,w.a),v)/(size(v)**2),offset=cross(u,sub(w.a,parked))
        return t>=0&&t<=1&&Math.abs(offset)<=.5 ? [offset] : []
      })
      if (!sides.some(v=>v<-.01)||!sides.some(v=>v>.01)) return false
      pocketSides.add(ts[0]<0 ? -1 : 1)
      return Math.abs(panelLength-len)<=.4
    }) || pocketSides.size === 2
    // The finish-face opening can be offset from the swing's hinge center by
    // its jamb depth. Require both source ends near the two collinear wall
    // tips; a single nearby arc never closes an unrelated gap.
    const swingSupported = openings.some(o =>
      (size(sub(o.a,a.p)) <= .5 && size(sub(o.b,b.p)) <= .5) ||
      (size(sub(o.b,a.p)) <= .5 && size(sub(o.a,b.p)) <= .5))
    if(!supported && !swingSupported)continue
    // A panel near the midpoint is not a closed finish-face boundary. In
    // scans the panel can sit several pixels behind the wall face, and two
    // sliding leaves may cover separate parts of the opening. Suppress the
    // threshold only when source ink covers its entire collinear span.
    const intervals=edges.flatMap(e=>{
      if(Math.abs(cross(u,sub(e.a,a.p)))>.01||Math.abs(cross(u,sub(e.b,a.p)))>.01)return []
      const ts=[dot(sub(e.a,a.p),u),dot(sub(e.b,a.p),u)].sort((x,y)=>x-y)
      return ts[1]>=0&&ts[0]<=len?[ts]:[]
    }).sort((a,b)=>a[0]-b[0])
    let covered=0
    for(const [lo,hi] of intervals){if(lo>covered+.01)break;covered=Math.max(covered,hi)}
    if(covered>=len-.01)continue
    const key=[a.p,b.p].map(p=>p.map(n=>n.toFixed(3)).join(',')).sort().join('|')
    if(!seen.has(key)){seen.add(key);result.push({a:a.p,b:b.p,source:'doorway'})}
  }
  return result
}
