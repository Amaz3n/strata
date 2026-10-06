import { flattenEvidencePath, type AreaEvidence, type AreaPoint } from './area-evidence'
import { areaPathRole } from './area-paths'
import { areaRoomLabel } from './area-labels'
import type { TextRun } from './text-runs'

/** Exclude only complete source leaders: a solid narrow arrowhead, aligned
 * thin shaft, at most two elbows, and a nearby non-room text annotation.
 * Never infer a leader from line weight alone or remove classified structure. */
export function annotationLeaderIds(evidence: AreaEvidence | null | undefined, runs: TextRun[], sx: number, sy: number): Set<number> {
  const ids = new Set<number>()
  const feet = ([x,y]:AreaPoint):AreaPoint => [x*sx,y*sy]
  const distance = (a:AreaPoint,b:AreaPoint) => Math.hypot(a[0]-b[0],a[1]-b[1])
  const clips=new Map<number,number[]>()
  for(const p of evidence?.paths??[]){
    if(p.kind!=='clip'||p.commands.some(c=>c[0]==='C'))continue
    const rings=flattenEvidencePath(p);if(rings.length!==1)continue
    const ring=rings[0],xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1]),box=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]
    if(ring.length===5&&new Set(ring.slice(0,4).map(p=>p.join(','))).size===4&&ring.every((p,i)=>(p[0]===box[0]||p[0]===box[2])&&(p[1]===box[1]||p[1]===box[3])&&(i===0||p[0]===ring[i-1][0]||p[1]===ring[i-1][1])))clips.set(p.id,box)
  }
  const eligible = (p:NonNullable<AreaEvidence>['paths'][number]) => areaPathRole(p)==='unknown' && p.opacity>=.9 && !p.dashes.length && p.clips.every(id=>{const b=clips.get(id);return b&&flattenEvidencePath(p).every(r=>r.every(q=>q[0]>=b[0]&&q[0]<=b[2]&&q[1]>=b[1]&&q[1]<=b[3]))})
  // Only fully visible paths inside supported rectangular clips qualify.
  const segments:{id:number;a:AreaPoint;b:AreaPoint}[]=[]
  const arrows:{id:number;tip:AreaPoint;base:AreaPoint}[]=[]
  for(const p of evidence?.paths??[]){
    if(p.kind==='clip'||p.commands.length>6||!eligible(p)||p.commands.some(c=>c[0]==='C'))continue
    if(p.kind==='stroke'&&p.width>0&&p.width<=.6&&p.commands.length===2&&p.commands[0][0]==='M'&&p.commands[1][0]==='L'){
      const a=feet([p.commands[0][1],p.commands[0][2]]),b=feet([p.commands[1][1],p.commands[1][2]])
      if(distance(a,b)>=.1&&distance(a,b)<=25)segments.push({id:p.id,a,b})
    }else if(p.kind==='fill'&&((p.colorSpace==='DeviceGray'&&p.color.length===1)||(p.colorSpace==='DeviceRGB'&&p.color.length===3))&&p.color.every(v=>v<=.2)){
      const rings=flattenEvidencePath(p);if(rings.length!==1)continue
      const r=rings[0].map(feet);while(r.length>1&&distance(r[0],r.at(-1)!)<1e-7)r.pop()
      if(r.length!==3)continue
      const lengths=r.map((a,i)=>distance(a,r[(i+1)%3])),baseIndex=lengths.indexOf(Math.min(...lengths))
      const a=r[baseIndex],b=r[(baseIndex+1)%3],tip=r[(baseIndex+2)%3],base:AreaPoint=[(a[0]+b[0])/2,(a[1]+b[1])/2],length=distance(tip,base),width=distance(a,b)
      if(length>=.08&&length<=1&&width>=.01&&width<length*.6)arrows.push({id:p.id,tip,base})
    }
  }
  const text=runs.filter(r=>!areaRoomLabel(r.text)&&(r.text.match(/[a-z]/ig)?.length??0)>=4)
  const nearText=(p:AreaPoint)=>text.some(r=>{
    const margin=Math.max(.1,r.h*sy)
    return p[0]>=r.x*sx-margin&&p[0]<=(r.x+r.w)*sx+margin&&p[1]>=r.y*sy-margin&&p[1]<=(r.y+r.h)*sy+margin
  })
  const grid=new Map<string,number[]>(),cell=.02
  const key=(x:number,y:number)=>`${x}:${y}`
  segments.forEach((s,i)=>{for(const p of [s.a,s.b]){const k=key(Math.floor(p[0]/cell),Math.floor(p[1]/cell));const a=grid.get(k)??[];a.push(i);grid.set(k,a)}})
  const attached=(p:AreaPoint)=>{
    const found=new Set<number>(),x=Math.floor(p[0]/cell),y=Math.floor(p[1]/cell)
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const i of grid.get(key(x+dx,y+dy))??[])if(Math.min(distance(p,segments[i].a),distance(p,segments[i].b))<=.01)found.add(i)
    return [...found]
  }
  for(const arrow of arrows){
    for(const start of attached(arrow.tip)){
      const s=segments[start],end=distance(s.a,arrow.tip)<distance(s.b,arrow.tip)?s.b:s.a
      const ax=arrow.base[0]-arrow.tip[0],ay=arrow.base[1]-arrow.tip[1],bx=end[0]-arrow.tip[0],by=end[1]-arrow.tip[1]
      if((ax*bx+ay*by)/(Math.hypot(ax,ay)*Math.hypot(bx,by))<.98)continue
      const walk=(point:AreaPoint,chain:number[]):number[]|null=>{
        if(nearText(point))return chain
        if(chain.length>=3)return null
        const next=attached(point).filter(i=>!chain.includes(i));if(next.length>4)return null
        for(const i of next){const t=segments[i],result=walk(distance(point,t.a)<distance(point,t.b)?t.b:t.a,[...chain,i]);if(result)return result}
        return null
      }
      const chain=walk(end,[start]);if(chain){ids.add(arrow.id);for(const i of chain)ids.add(segments[i].id)}
    }
  }
  return ids
}
