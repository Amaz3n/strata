import { evidencePathBounds, flattenEvidencePath, type AreaPoint } from './area-evidence';
import type { AreaInput } from './area-takeoff';
import { interpretArchitecturalElements } from './area-semantics';
import { segmentIndex } from './segment-index';

type Segment = { a: AreaPoint; b: AreaPoint; id: number; kind: 'wall' | 'window' };
export interface JambWindowHost {
  a: AreaPoint;
  b: AreaPoint;
  widthFt: number;
  thicknessFt: number;
  pathIds: number[];
  panePathIds: number[];
  /** Only the common extent of the two actual outward faces, never a
   * continuation guessed from the opening or a detected room. */
  piers: Array<{ a: AreaPoint; b: AreaPoint; pathIds: number[] }>;
  ambiguous: boolean;
}
const sub=(a:AreaPoint,b:AreaPoint):AreaPoint=>[a[0]-b[0],a[1]-b[1]];
const length=(p:AreaPoint)=>Math.hypot(...p);
const dot=(a:AreaPoint,b:AreaPoint)=>a[0]*b[0]+a[1]*b[1];
const cross=(a:AreaPoint,b:AreaPoint)=>a[0]*b[1]-a[1]*b[0];

/** Recover a wall body between two actual jambs, independently of room
 * detection. Paired classified panes, both full-depth returns and all four
 * outward pier faces are mandatory. A schedule/tag never supplies geometry.
 * Coordinates returned are normalized; every length test is in feet.
 */
export function measuredJambWindowHosts(input: AreaInput): JambWindowHost[] {
  const sx=input.imageWidth*input.feetPerImagePx,sy=input.imageHeight*input.feetPerImagePx;
  if (!input.evidence || input.evidence.truncated || !(sx>0&&sy>0&&Number.isFinite(sx+sy))) return [];
  const feet=(p:AreaPoint):AreaPoint=>[p[0]*sx,p[1]*sy],norm=(p:AreaPoint):AreaPoint=>[p[0]/sx,p[1]/sy];
  const kinds=new Map(interpretArchitecturalElements(input.evidence, input.visualObservations, {sx:input.imageWidth*input.feetPerImagePx,sy:input.imageHeight*input.feetPerImagePx}).map(e=>[e.pathId,e]));
  const clips=new Map<number,{x0:number;y0:number;x1:number;y1:number}>();
  for (const p of input.evidence.paths) {
    if (p.kind!=='clip'||p.commands.some(c=>c[0]==='C')) continue;
    const rings=flattenEvidencePath(p),box=evidencePathBounds(p);
    if (!box||rings.length!==1) continue;
    const r=rings[0];
    if (r.length===5&&length(sub(r[0],r[4]))<1e-12&&new Set(r.slice(0,4).map(p=>p.join(','))).size===4&&
      r.every((q,i)=>(q[0]===box.x0||q[0]===box.x1)&&(q[1]===box.y0||q[1]===box.y1)&&(!i||q[0]===r[i-1][0]||q[1]===r[i-1][1]))) clips.set(p.id,box);
  }
  const edges:Segment[]=[];
  const region=input.region;
  for (const p of input.evidence.paths) {
    const e=kinds.get(p.id);
    if (!e||e.conflict||!['wall','window'].includes(e.kind)||p.kind==='clip'||p.opacity<.5||p.dashes.length||p.commands.some(c=>c[0]==='C')) continue;
    if ((p.colorSpace==='DeviceGray'&&p.color[0]>=.98)||(p.colorSpace==='DeviceRGB'&&p.color.length===3&&p.color.every(c=>c>=.98))) continue;
    const visible=(q:AreaPoint)=>q[0]>=region.x0&&q[0]<=region.x1&&q[1]>=region.y0&&q[1]<=region.y1&&
      p.clips.every(id=>{const b=clips.get(id);return b&&q[0]>=b.x0&&q[0]<=b.x1&&q[1]>=b.y0&&q[1]<=b.y1;});
    for (const r of flattenEvidencePath(p)) for(let i=1;i<r.length;i++) {
      if (!visible(r[i-1])||!visible(r[i])) continue;
      const a=feet(r[i-1]),b=feet(r[i]);
      if (length(sub(b,a))>=.15) edges.push({a,b,id:p.id,kind:e.kind as Segment['kind']});
    }
  }
  const panes=edges.filter(e=>e.kind==='window'&&length(sub(e.b,e.a))>=1.5&&length(sub(e.b,e.a))<=20);
  const walls=edges.filter(e=>e.kind==='wall');
  const nearPane=segmentIndex(panes),nearWall=segmentIndex(walls);
  const tolerance=Math.min(.05,Math.max(.02,(input.evidence.raster?.feetPerPixel??0)*2));
  const byGeometry=new Map<string,JambWindowHost>();
  for (let i=0;i<panes.length;i++) {
    const p=panes[i],v=sub(p.b,p.a),span=length(v),u:AreaPoint=[v[0]/span,v[1]/span];
    const project=(q:AreaPoint)=>dot(sub(q,p.a),u),normal=(q:AreaPoint)=>cross(u,sub(q,p.a));
    const point=(t:number,d:number):AreaPoint=>[p.a[0]+u[0]*t-u[1]*d,p.a[1]+u[1]*t+u[0]*d];
    const localWalls=nearWall(p,2).map(j=>walls[j]);
    for (const j of nearPane(p,.3)) {
      if (j<=i) continue;
      const q=panes[j],qSpan=length(sub(q.b,q.a)),offset=normal(q.a);
      const ts=[project(q.a),project(q.b)].sort((a,b)=>a-b);
      if (Math.abs(cross(u,sub(q.b,q.a)))/qSpan>.015||Math.abs(offset)<.03||Math.abs(offset)>.3||
        Math.min(span,ts[1])-Math.max(0,ts[0])<Math.min(span,qSpan)*.9) continue;
      const paneStart=Math.min(0,ts[0]),paneEnd=Math.max(span,ts[1]),paneLo=Math.min(0,offset),paneHi=Math.max(0,offset);
      const jambs=localWalls.flatMap(w=>{
        const d=sub(w.b,w.a),size=length(d),along=(project(w.a)+project(w.b))/2,ns=[normal(w.a),normal(w.b)].sort((a,b)=>a-b);
        if (size<.2||size>1.5||Math.abs(dot(d,u))/size>.015||ns[0]>paneLo-tolerance||ns[1]<paneHi+tolerance) return [];
        return [{edge:w,along,lo:ns[0],hi:ns[1]}];
      });
      const before=jambs.filter(j=>j.along<=paneStart+tolerance&&j.along>=paneStart-1);
      const after=jambs.filter(j=>j.along>=paneEnd-tolerance&&j.along<=paneEnd+1);
      for (const start of before) for (const end of after) {
        const width=end.along-start.along;
        if (width<1.5||width>20||Math.abs(start.lo-end.lo)>tolerance||Math.abs(start.hi-end.hi)>tolerance) continue;
        const lo=(start.lo+end.lo)/2,hi=(start.hi+end.hi)/2;
        const faceIds:number[]=[];
        const piers:JambWindowHost['piers']=[];
        let supported=true;
        for (const [jamb,side] of [[start,-1],[end,1]] as const) {
          const extents:number[]=[],pierIds:number[]=[jamb.edge.id];
          for (const depth of [jamb.lo,jamb.hi]) {
          const corner=point(jamb.along,depth);
          const supports=localWalls.filter(w=>{
            const d=sub(w.b,w.a),size=length(d);
            if (size<.3||Math.abs(cross(u,d))/size>.015||Math.min(length(sub(w.a,corner)),length(sub(w.b,corner)))>tolerance) return false;
            const a=project(w.a),b=project(w.b);
            return side<0 ? Math.min(a,b)<=jamb.along-.25&&Math.max(a,b)<=jamb.along+tolerance : Math.max(a,b)>=jamb.along+.25&&Math.min(a,b)>=jamb.along-tolerance;
          });
          if (!supports.length) supported=false;
          faceIds.push(...supports.map(w=>w.id));
          pierIds.push(...supports.map(w=>w.id));
          // Multiple coincident source strokes cannot justify extending past
          // their shortest common support. Longer continuations need their
          // own independent wall evidence.
          extents.push(...supports.map(w=>side<0?jamb.along-Math.min(project(w.a),project(w.b)):Math.max(project(w.a),project(w.b))-jamb.along));
          }
          if (extents.length) piers.push({a:norm(point(jamb.along,(lo+hi)/2)),b:norm(point(jamb.along+side*Math.min(...extents),(lo+hi)/2)),pathIds:[...new Set(pierIds)]});
        }
        if (!supported) continue;
        // A structural post/face through the proposed opening is a conflict,
        // not something pane evidence may erase.
        if (localWalls.some(w=>{
          const a=project(w.a),b=project(w.b),na=normal(w.a),nb=normal(w.b);
          return Math.max(a,b)>start.along+tolerance&&Math.min(a,b)<end.along-tolerance&&
            Math.max(na,nb)>lo+tolerance&&Math.min(na,nb)<hi-tolerance;
        })) continue;
        const a=point(start.along,(lo+hi)/2),b=point(end.along,(lo+hi)/2);
        const key=[a,b].map(p=>p.map(n=>n.toFixed(4)).join(',')).sort().join(':')+':'+(hi-lo).toFixed(4);
        const ids=[p.id,q.id,start.edge.id,end.edge.id,...faceIds];
        const previous=byGeometry.get(key);
        if (previous) {
          previous.pathIds=[...new Set([...previous.pathIds,...ids])];
          previous.panePathIds=[...new Set([...previous.panePathIds,p.id,q.id])];
        } else byGeometry.set(key,{a:norm(a),b:norm(b),widthFt:width,thicknessFt:hi-lo,pathIds:[...new Set(ids)],panePathIds:[...new Set([p.id,q.id])],piers,ambiguous:false});
      }
    }
  }
  const result=[...byGeometry.values()];
  for (let i=0;i<result.length;i++) for (let j=i+1;j<result.length;j++) {
    const first=result[i],second=result[j];
    if (!first.panePathIds.some(id=>second.panePathIds.includes(id))) continue;
    const a=feet(first.a),b=feet(first.b),c=feet(second.a),d=feet(second.b),v=sub(b,a),span=length(v),u:AreaPoint=[v[0]/span,v[1]/span];
    const ts=[dot(sub(c,a),u),dot(sub(d,a),u)].sort((a,b)=>a-b);
    if (Math.abs(cross(u,sub(d,c)))/second.widthFt<.015 && Math.abs(cross(u,sub(c,a)))<(first.thicknessFt+second.thicknessFt)/2+.05 &&
      Math.min(span,ts[1])-Math.max(0,ts[0])>Math.min(span,second.widthFt)*.6) first.ambiguous=second.ambiguous=true;
  }
  return result;
}
