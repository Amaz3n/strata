import { flattenEvidencePath, type AreaEvidence, type AreaPoint } from './area-evidence'
import { areaPathRole } from './area-paths'

/** Conservative support for unlayered, filled rectangular wall networks.
 * These IDs preserve source geometry; they never add a gap closure or change
 * stored CAD layers. Isolated bars, white masks and thick furniture are excluded. */
export function geometricStructureIds(evidence: AreaEvidence | null | undefined, sx: number, sy: number): Set<number> {
  // Mixed exports can retain named doors while losing wall layers. Infer only
  // unknown fill networks even when other paths have explicit CAD roles.
  const clips = new Map<number, number[]>()
  for (const path of evidence?.paths ?? []) {
    if(path.kind !== 'clip' || path.commands.some(c=>c[0]==='C'))continue
    const rings=flattenEvidencePath(path)
    if(rings.length!==1)continue
    const ring=rings[0],xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1]),box=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]
    if(ring.length===5 && new Set(ring.slice(0,4).map(p=>p.join(','))).size===4 && ring.every(p=>(p[0]===box[0]||p[0]===box[2])&&(p[1]===box[1]||p[1]===box[3])) && ring.every((p,i)=>i===0||p[0]===ring[i-1][0]||p[1]===ring[i-1][1]))clips.set(path.id,box)
  }
  const candidates: { ids: number[]; ring: AreaPoint[]; angle: number; bounds: number[] }[] = []
  const parts: { ids: number[]; points: AreaPoint[]; style: string }[] = []
  for (const path of evidence?.paths ?? []) {
    if (areaPathRole(path) !== 'unknown' || path.kind !== 'fill' || path.opacity < .95 || path.dashes.length || path.commands.some(c => c[0] === 'C')) continue
    // Only supported gray/RGB solid paint, not CMYK, white erase masks or images.
    const dark = (path.colorSpace === 'DeviceGray' && path.color.length === 1 && path.color[0] <= .8) ||
      (path.colorSpace === 'DeviceRGB' && path.color.length === 3 && path.color.every(c => c <= .8))
    if (!dark) continue
    const lines = flattenEvidencePath(path)
    if (lines.length > 128 || path.clips.some(id=>{const b=clips.get(id);return !b||lines.some(line=>line.some(p=>p[0]<b[0]||p[0]>b[2]||p[1]<b[1]||p[1]>b[3]))}))continue
    for (const line of lines) {
      const points = line.map(([x,y]): AreaPoint => [x*sx,y*sy])
      if (points.length > 1 && Math.hypot(points[0][0]-points.at(-1)![0],points[0][1]-points.at(-1)![1]) < 1e-8) points.pop()
      if (points.length >= 3 && points.length <= 128) parts.push({ids:[path.id],points,style:JSON.stringify([path.colorSpace,path.color,path.clips])})
    }
  }
  // Some PDF exporters tessellate a wall rectangle into two opaque triangles.
  // Pair only identical-style triangles sharing an exact source edge; this
  // recognizes their existing footprint without synthesizing wall geometry.
  const edgeParts = new Map<string, typeof parts>()
  for(const part of parts.filter(p=>p.points.length===3))for(let i=0;i<3;i++){
    const key=part.style+'|'+[part.points[i],part.points[(i+1)%3]].map(p=>p.join(',')).sort().join('|')
    const list=edgeParts.get(key)??[];list.push(part);edgeParts.set(key,list)
  }
  const combined: typeof parts = []
  for(const pair of edgeParts.values()){
    if(pair.length!==2)continue
    const points=[...new Map(pair.flatMap(p=>p.points).map(p=>[p.join(','),p])).values()]
    if(points.length!==4)continue
    const cx=points.reduce((n,p)=>n+p[0],0)/4,cy=points.reduce((n,p)=>n+p[1],0)/4
    points.sort((a,b)=>Math.atan2(a[1]-cy,a[0]-cx)-Math.atan2(b[1]-cy,b[0]-cx))
    const area=(r:AreaPoint[])=>Math.abs(r.reduce((n,p,i)=>n+p[0]*r[(i+1)%r.length][1]-p[1]*r[(i+1)%r.length][0],0))/2
    if(Math.abs(area(points)-pair.reduce((n,p)=>n+area(p.points),0))>1e-6)continue
    combined.push({ids:pair.flatMap(p=>p.ids),points,style:pair[0].style})
  }
  // Narrow compound wall footprints can have returns and T/L junctions. Their
  // area/perimeter gives a thickness bound; long perpendicular source edges and
  // connection to the same wall network are still required below.
  for (const part of parts.filter(p => p.points.length > 4)) {
    const ring = part.points
    const edges = ring.map((p,i) => ({ x:ring[(i+1)%ring.length][0]-p[0], y:ring[(i+1)%ring.length][1]-p[1] }))
    const lengths = edges.map(e => Math.hypot(e.x,e.y)), perimeter = lengths.reduce((s,n)=>s+n,0)
    const area = Math.abs(ring.reduce((s,p,i)=>s+p[0]*ring[(i+1)%ring.length][1]-p[1]*ring[(i+1)%ring.length][0],0))/2
    const thickness = 2*area/perimeter, longest = Math.max(...lengths)
    if (!Number.isFinite(thickness) || thickness < .2 || thickness > 1.25 || longest < 3 || perimeter < 12) continue
    const vector = edges[lengths.indexOf(longest)]
    // Exported wall polygons can rotate, but ordinary returns remain parallel
    // or perpendicular. Curved/irregular furniture is not inferred as a wall.
    if (edges.some((e,i) => lengths[i]>.1 && Math.min(Math.abs(e.x*vector.y-e.y*vector.x),Math.abs(e.x*vector.x+e.y*vector.y))/(lengths[i]*longest)>.015)) continue
    candidates.push({ids:part.ids,ring,angle:Math.atan2(vector.y,vector.x),bounds:[Math.min(...ring.map(p=>p[0])),Math.min(...ring.map(p=>p[1])),Math.max(...ring.map(p=>p[0])),Math.max(...ring.map(p=>p[1]))]})
    if (candidates.length>1000) return new Set()
  }
  for(const part of [...parts.filter(p=>p.points.length===4),...combined]) {
    const {points}=part
    const vectors = points.map((p,i) => [points[(i+1)%4][0]-p[0],points[(i+1)%4][1]-p[1]])
    const lengths = vectors.map(v => Math.hypot(...v)), short = Math.min(...lengths), long = Math.max(...lengths)
    if (short < .2 || short > 1.25 || long < 3 || long/short < 4) continue
    if (vectors.some((v,i) => Math.abs(v[0]*vectors[(i+1)%4][0]+v[1]*vectors[(i+1)%4][1])/(lengths[i]*lengths[(i+1)%4]) > .005)) continue
    const vector = vectors[lengths.indexOf(long)]
    candidates.push({ids:part.ids,ring:points,angle:Math.atan2(vector[1],vector[0]),bounds:[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))]})
    if(candidates.length>1000)return new Set() // bounded inference; regular vector detection remains available
  }
  const near = (p: AreaPoint,a: AreaPoint,b: AreaPoint) => {
    const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy)))
    return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)<=.02
  }
  const adjacent=candidates.map(()=>[] as number[])
  for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++){
    const a=candidates[i],b=candidates[j],x=a.bounds,y=b.bounds
    if(x[2]+.02<y[0]||y[2]+.02<x[0]||x[3]+.02<y[1]||y[3]+.02<x[1])continue
    if(a.ring.some(p=>b.ring.some((q,k)=>near(p,q,b.ring[(k+1)%b.ring.length])))||b.ring.some(p=>a.ring.some((q,k)=>near(p,q,a.ring[(k+1)%a.ring.length])))){adjacent[i].push(j);adjacent[j].push(i)}
  }
  const visited=new Set<number>(),ids=new Set<number>()
  for(let i=0;i<candidates.length;i++){
    if(visited.has(i))continue
    const component=[i];visited.add(i)
    for(let k=0;k<component.length;k++)for(const next of adjacent[component[k]])if(!visited.has(next)){visited.add(next);component.push(next)}
    if(component.length<3||!component.some(j=>Math.abs(Math.sin(candidates[j].angle-candidates[i].angle))>.95))continue
    for(const j of component)for(const id of candidates[j].ids)ids.add(id)
  }
  return ids
}
