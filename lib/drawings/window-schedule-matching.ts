import { evidencePathBounds, flattenEvidencePath, type AreaPoint } from "./area-evidence";
import { containsPoint, type AreaInput } from "./area-takeoff";
import type { BuildingReconstruction } from "./building-reconstruction";
import { resolveWindowScheduleMark, type WindowScheduleRow } from "./window-schedules";

export interface WindowScheduleTag {
  mark: string;
  runIndex: number;
  pathId: number;
  bounds: { x0: number; y0: number; x1: number; y1: number };
}
export interface WindowScheduleAssociation {
  openingId: string;
  planSourceId: string;
  status: "proposed" | "ambiguous" | "unmatched" | "stale";
  reason: string;
  candidates: Array<{ tag: WindowScheduleTag; schedule: WindowScheduleRow }>;
}
export interface UnmatchedWindowScheduleTag {
  planSourceId: string;
  tag: WindowScheduleTag;
  schedules: WindowScheduleRow[];
}
const normalized = (text: string) => text.trim().toUpperCase();
const distance = (a: AreaPoint, b: AreaPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** An enclosed source tag is evidence for a proposed association, not proof of
 * window geometry. Reject open outlines, clipped symbols and multi-label
 * bubbles. Source text must be centered inside a compact convex ring.
 */
function enclosedTags(input: AreaInput, marks: Set<string>): WindowScheduleTag[] {
  const sx = input.imageWidth * input.feetPerImagePx, sy = input.imageHeight * input.feetPerImagePx;
  const result: WindowScheduleTag[] = [];
  if (!Number.isFinite(sx + sy) || sx <= 0 || sy <= 0) return result;
  const eligible = input.textRuns.map((run, index) => ({run, index})).filter(({run}) =>
    marks.has(normalized(run.text)) && [run.x,run.y,run.w,run.h].every(Number.isFinite) &&
    run.x>=0 && run.y>=0 && run.x+run.w<=1 && run.y+run.h<=1 &&
    run.w*sx >= .05 && run.w*sx <= 2 && run.h*sy >= .05 && run.h*sy <= 1.5);
  const clips = new Map<number,{x0:number;y0:number;x1:number;y1:number}>();
  for (const path of input.evidence?.paths ?? []) {
    if (path.kind!=='clip' || path.commands.some(c=>c[0]==='C')) continue;
    const rings=flattenEvidencePath(path),b=evidencePathBounds(path);
    if (!b || rings.length!==1) continue;
    const r=rings[0];
    if (r.length===5 && distance(r[0],r[4])<1e-12 && new Set(r.slice(0,4).map(p=>p.join(','))).size===4 &&
      r.every((p,i)=>(p[0]===b.x0||p[0]===b.x1)&&(p[1]===b.y0||p[1]===b.y1)&&(!i||p[0]===r[i-1][0]||p[1]===r[i-1][1]))) clips.set(path.id,b);
  }
  for (const path of input.evidence?.paths ?? []) {
    if (path.kind !== 'stroke' || path.opacity < .5 || path.dashes.length) continue;
    if ((path.colorSpace==='DeviceGray' && path.color[0]>=.98) || (path.colorSpace==='DeviceRGB' && path.color.length===3 && path.color.every(c=>c>=.98))) continue;
    const box = evidencePathBounds(path);
    if (!box) continue;
    const possible = eligible.filter(({run:r}) => r.x >= box.x0 && r.x+r.w <= box.x1 && r.y >= box.y0 && r.y+r.h <= box.y1);
    if (!possible.length) continue;
    for (const ring of flattenEvidencePath(path)) {
      if (ring.length < 4 || ring.length > 130 || distance(ring[0],ring[ring.length-1]) > 1e-9) continue;
      const feet = ring.map(([x,y]):AreaPoint=>[x*sx,y*sy]);
      let sign = 0, convex = true;
      for (let i=1; i<feet.length; i++) {
        const a=feet[i-1],b=feet[i],c=feet[(i+1)%(feet.length-1)];
        const cross=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);
        if (Math.abs(cross)<1e-8) continue;
        if (sign && Math.sign(cross)!==sign) {convex=false;break;}
        sign=Math.sign(cross);
      }
      if (!convex || !sign) continue;
      const bounds={x0:Math.min(...ring.map(p=>p[0])),y0:Math.min(...ring.map(p=>p[1])),x1:Math.max(...ring.map(p=>p[0])),y1:Math.max(...ring.map(p=>p[1]))};
      if (bounds.x0<0||bounds.y0<0||bounds.x1>1||bounds.y1>1) continue;
      if (path.clips.some(id=>{const b=clips.get(id);return !b||bounds.x0<b.x0||bounds.y0<b.y0||bounds.x1>b.x1||bounds.y1>b.y1;})) continue;
      const w=(bounds.x1-bounds.x0)*sx,h=(bounds.y1-bounds.y0)*sy;
      if (w<.15||h<.15||w>3||h>3||w/h<.4||w/h>2.5) continue;
      const rasterRegion=input.evidence?.raster?.region;
      if (rasterRegion && (bounds.x0<rasterRegion.x0||bounds.y0<rasterRegion.y0||bounds.x1>rasterRegion.x1||bounds.y1>rasterRegion.y1)) continue;
      for (const {run:r,index} of possible) {
        const corners:AreaPoint[]=[[r.x,r.y],[r.x+r.w,r.y],[r.x+r.w,r.y+r.h],[r.x,r.y+r.h]];
        if (!corners.every(p=>containsPoint(p,ring)) || w<r.w*sx*1.05 || h<r.h*sy*1.05 || w>r.w*sx*8 || h>r.h*sy*4) continue;
        if (Math.abs(r.x+r.w/2-(bounds.x0+bounds.x1)/2)*sx>w*.22 || Math.abs(r.y+r.h/2-(bounds.y0+bounds.y1)/2)*sy>h*.22) continue;
        if (input.textRuns.some((other,i)=>i!==index && containsPoint([other.x+other.w/2,other.y+other.h/2],ring))) continue;
        result.push({mark:normalized(r.text),runIndex:index,pathId:path.id,bounds});
      }
    }
  }
  return result;
}

/** Match only within a caller-selected revision/schedule scope. Size agreement
 * never selects a tag: pane, unit and rough-opening widths are different facts.
 * A tag must project into the measured opening and be within 1.5 ft of its wall
 * face. Every competing source tag/opening is retained; nearest wins is unsafe.
 * This function never changes wall cuts, dimensions, heights or operating style.
 */
export function reconcileWindowScheduleTags(input: AreaInput, building: BuildingReconstruction, context: {
  planSourceId: string;
  rows: WindowScheduleRow[];
}): { associations: WindowScheduleAssociation[]; unmatchedTags: UnmatchedWindowScheduleTag[] } {
  const windows=building.openings.filter(o=>o.kind==='window');
  if (!context.planSourceId.trim() || !context.rows.length) return {associations:[],unmatchedTags:[]};
  const tags=enclosedTags(input,new Set(context.rows.map(r=>r.mark)));
  const sx=input.imageWidth*input.feetPerImagePx,sy=input.imageHeight*input.feetPerImagePx;
  const walls=new Map(building.walls.map(w=>[w.id,w]));
  const candidates=new Map<string,WindowScheduleTag[]>();
  for (const opening of windows) {
    const wall=walls.get(opening.wallId);
    if (!wall) continue;
    const a:AreaPoint=[wall.a[0]*sx,wall.a[1]*sy],b:AreaPoint=[wall.b[0]*sx,wall.b[1]*sy],length=distance(a,b);
    if (!Number.isFinite(length+opening.widthFt+opening.offsetFt+wall.thicknessFt) || length<=0 || wall.thicknessFt<=0 || opening.widthFt<=0 || opening.offsetFt<0 || opening.offsetFt+opening.widthFt>length+.02) continue;
    const ux=(b[0]-a[0])/length,uy=(b[1]-a[1])/length;
    candidates.set(opening.id,tags.filter(tag=>{
      const r=input.textRuns[tag.runIndex],x=(r.x+r.w/2)*sx-a[0],y=(r.y+r.h/2)*sy-a[1];
      const along=x*ux+y*uy,across=Math.abs(x*uy-y*ux);
      return along>=opening.offsetFt && along<=opening.offsetFt+opening.widthFt && across<=wall.thicknessFt/2+1.5;
    }));
  }
  const usedBy=new Map<number,Set<string>>();
  for (const [id,matched] of candidates) for (const tag of matched) usedBy.set(tag.runIndex,new Set([...(usedBy.get(tag.runIndex)??[]),id]));
  const associations: WindowScheduleAssociation[] = windows.map(opening=>{
    const matched=candidates.get(opening.id)??[];
    const base={openingId:opening.id,planSourceId:context.planSourceId,candidates:matched.flatMap(tag=>context.rows.filter(row=>row.mark===tag.mark).map(schedule=>({tag,schedule})))};
    if (!matched.length) return {...base,status:'unmatched',reason:'No complete enclosed schedule tag is uniquely associated with this opening.'};
    if (matched.length!==1 || (usedBy.get(matched[0].runIndex)?.size??0)!==1) return {...base,status:'ambiguous',reason:'The source tag or opening has more than one possible association.'};
    if (resolveWindowScheduleMark(context.rows,matched[0].mark).status!=='matched') return {...base,status:'ambiguous',reason:'The tag occurs in more than one applicable schedule row or has conflicting source text.'};
    return {...base,status:'proposed',reason:'An enclosed drawing tag and a scoped schedule row agree. Confirm their association and opening dimensions; vertical placement is unresolved.'};
  });
  return {associations,unmatchedTags:tags.filter(tag=>!usedBy.has(tag.runIndex)).map(tag=>({planSourceId:context.planSourceId,tag,schedules:context.rows.filter(row=>row.mark===tag.mark)}))};
}

export function matchWindowSchedules(input: AreaInput, building: BuildingReconstruction, context: {
  planSourceId: string;
  rows: WindowScheduleRow[];
}): WindowScheduleAssociation[] {
  return reconcileWindowScheduleTags(input, building, context).associations;
}
