import type { AreaEvidence, AreaPoint } from './area-evidence'
import type { TextRun } from './text-runs'
export type AreaRevisionComparison='unchanged'|'changed'|'unavailable'
export interface RevisionAreaSource {evidence:AreaEvidence; textRuns:TextRun[]; width:number; height:number; scale:number}
/** Advisory exact comparison, never a confidence score or automatic acceptance.
 * Includes paint styles, layers, clipping context and local text. Scans, missing
 * clips, missing geometry and alignment/scale changes cannot be called unchanged.
 */
export function compareAreaRevision(a:RevisionAreaSource|null,b:RevisionAreaSource|null,points:AreaPoint[]):AreaRevisionComparison {
  if(!a||!b||a.evidence.truncated||b.evidence.truncated||points.length<3)return 'unavailable'
  if(a.evidence.unrepresentedPaint!==false||b.evidence.unrepresentedPaint!==false)return 'unavailable'
  if(a.width!==b.width||a.height!==b.height||a.scale!==b.scale)return 'changed'
  const box=points.reduce((r,p)=>({x0:Math.min(r.x0,p[0]),y0:Math.min(r.y0,p[1]),x1:Math.max(r.x1,p[0]),y1:Math.max(r.y1,p[1])}),{x0:1,y0:1,x1:0,y1:0})
  // Adjacent walls/door jambs participate even when just outside the measurement.
  const mx=1/(a.width*a.scale),my=1/(a.height*a.scale)
  box.x0-=mx;box.x1+=mx;box.y0-=my;box.y1+=my
  const intersects=(r:typeof box)=>r.x0<=box.x1&&r.x1>=box.x0&&r.y0<=box.y1&&r.y1>=box.y0
  const signature=(source:RevisionAreaSource)=>{
    const paths=new Map(source.evidence.paths.map(p=>[p.id,p]))
    const local=source.evidence.paths.filter(p=>p.kind!=='clip'&&intersects(p.commands.reduce((r,c)=>{
      for(let i=1;i<c.length;i+=2){const x=c[i] as number,y=c[i+1] as number;r.x0=Math.min(r.x0,x);r.x1=Math.max(r.x1,x);r.y0=Math.min(r.y0,y);r.y1=Math.max(r.y1,y)}return r
    },{x0:Infinity,y0:Infinity,x1:-Infinity,y1:-Infinity})))
    if(!local.length||local.some(p=>p.groups.length>0||p.clips.some(id=>!paths.has(id))))return null
    const geometry=local.map(({id:_id,groups:_groups,clips,...p})=>JSON.stringify({...p,clips:clips.map(id=>{const clip=paths.get(id)!;return {commands:clip.commands,evenOdd:clip.evenOdd}})}))
    const text=source.textRuns.filter(t=>intersects({x0:t.x,y0:t.y,x1:t.x+t.w,y1:t.y+t.h})).map(t=>JSON.stringify(t)).sort()
    return JSON.stringify([geometry,text])
  }
  const sa=signature(a),sb=signature(b)
  return !sa||!sb?'unavailable':sa===sb?'unchanged':'changed'
}
