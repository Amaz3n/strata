require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {matchWindowSchedules,reconcileWindowScheduleTags}=require('../lib/drawings/window-schedule-matching')
const {extractWindowSchedules}=require('../lib/drawings/window-schedules')
function fixture(angle=0){
  const turn=([x,y])=>[15+x*Math.cos(angle)-y*Math.sin(angle),15+x*Math.sin(angle)+y*Math.cos(angle)]
  const norm=p=>[p[0]/60,p[1]/30],tag=turn([5,1]),r=.55
  const polygon=[[tag[0]-r,tag[1]-r],[tag[0]+r,tag[1]-r],[tag[0]+r,tag[1]+r],[tag[0]-r,tag[1]+r],[tag[0]-r,tag[1]-r]].map(norm)
  const path={id:1,commands:polygon.map((p,i)=>[i?'L':'M',...p]),kind:'stroke',opacity:1,dashes:[],clips:[],layer:[],groups:[],width:1,color:[0],colorSpace:'DeviceGray',evenOdd:false}
  const input={segments:[],textRuns:[{text:'A',x:(tag[0]-.15)/60,y:(tag[1]-.2)/30,w:.3/60,h:.4/30}],evidence:{version:1,paths:[path],truncated:false},imageWidth:1200,imageHeight:600,feetPerImagePx:.05,region:{x0:0,y0:0,x1:1,y1:1}}
  const building={version:1,walls:[{id:'wall',a:norm(turn([0,0])),b:norm(turn([10,0])),thicknessFt:.5,pathIds:[2,3],roomIds:[],basis:'paired-faces'}],openings:[{id:'window',wallId:'wall',kind:'window',offsetFt:3,widthFt:4,widthBasis:'connected-frame',pathIds:[4],spaceIds:[]}],issues:[],source:{wallPathCount:2,representedWallPathCount:2,excludedPathCount:0},status:'needs-review'}
  const run=(text,x,y,w=.04)=>({text,x,y,w,h:.01})
  const rows=extractWindowSchedules([{sourceId:'schedule-revision:page-8',pageNumber:8,textRuns:[run('WINDOW SCHEDULE',.1,.1,.2),run('MARK',.1,.13),run('WIDTH',.2,.13),run('HEIGHT',.3,.13),run('A',.115,.15,.01),run(`5'-0"`,.2,.15),run(`6'-0"`,.3,.15)]}]).rows
  return {input,building,context:{planSourceId:'plan-revision:page-4',rows},path,tag}
}
test('unique enclosed tags associate at every orientation without changing measured dimensions',()=>{
  for(const angle of [0,Math.PI/2,.63,Math.PI]){
    const f=fixture(angle),before=structuredClone(f),out=matchWindowSchedules(f.input,f.building,f.context)
    assert.equal(out.length,1);assert.equal(out[0].status,'proposed');assert.equal(out[0].candidates.length,1)
    assert.equal(out[0].candidates[0].tag.pathId,1);assert.equal(out[0].candidates[0].tag.runIndex,0)
    assert.equal(out[0].candidates[0].schedule.scheduledWidthFt,5);assert.equal(f.building.openings[0].widthFt,4)
    assert.equal(out[0].planSourceId,f.context.planSourceId);assert.deepEqual(f,before)
  }
})
test('plain letters, open symbols, white strokes and multi-label bubbles cannot assign a window',()=>{
  for(const change of ['no-symbol','open','white','faded','dashed','extra-label','huge','missing-clip']){
    const f=fixture()
    if(change==='no-symbol') f.input.evidence.paths=[]
    if(change==='open') f.path.commands.pop()
    if(change==='white') f.path.color=[1]
    if(change==='faded') f.path.opacity=.1
    if(change==='dashed') f.path.dashes=[1,2]
    if(change==='extra-label') f.input.textRuns.push({...f.input.textRuns[0],text:'1'})
    if(change==='huge') f.path.commands=[['M',0,0],['L',1,0],['L',1,1],['L',0,1],['L',0,0]]
    if(change==='missing-clip') f.path.clips=[999]
    assert.equal(matchWindowSchedules(f.input,f.building,f.context)[0].status,'unmatched',change)
  }
})
test('known rectangular clipping must preserve the complete symbol; clipped raster tags are rejected',()=>{
  const f=fixture();f.path.clips=[2]
  f.input.evidence.paths.push({...f.path,id:2,kind:'clip',clips:[],commands:[['M',0,0],['L',1,0],['L',1,1],['L',0,1],['L',0,0]]})
  assert.equal(matchWindowSchedules(f.input,f.building,f.context)[0].status,'proposed')
  f.input.evidence.paths[1].commands=[['M',0,0],['L',f.tag[0]/60,0],['L',f.tag[0]/60,1],['L',0,1],['L',0,0]]
  assert.equal(matchWindowSchedules(f.input,f.building,f.context)[0].status,'unmatched')
  f.path.clips=[];f.input.evidence.raster={region:{x0:0,y0:0,x1:f.tag[0]/60,y1:1}}
  assert.equal(matchWindowSchedules(f.input,f.building,f.context)[0].status,'unmatched')
})
test('one tag near two openings is ambiguous even if one opening has a closer size or position',()=>{
  const f=fixture();f.building.walls.push({...f.building.walls[0],id:'parallel',a:[.25,.51],b:[25/60,.51]})
  f.building.openings.push({...f.building.openings[0],id:'other',wallId:'parallel',widthFt:5})
  const out=matchWindowSchedules(f.input,f.building,f.context)
  assert.ok(out.every(o=>o.status==='ambiguous'));assert.equal(out.length,2)
})
test('two tags for one opening and reused schedule marks are retained as ambiguity',()=>{
  const f=fixture(),second={...f.path,id:5,commands:f.path.commands.map(c=>[c[0],c[1]+1/60,c[2]])}
  f.input.evidence.paths.push(second);f.input.textRuns.push({...f.input.textRuns[0],x:f.input.textRuns[0].x+1/60})
  assert.equal(matchWindowSchedules(f.input,f.building,f.context)[0].status,'ambiguous')
  const g=fixture();g.context.rows.push({...g.context.rows[0],sourceId:'other-revision'})
  const out=matchWindowSchedules(g.input,g.building,g.context)[0]
  assert.equal(out.status,'ambiguous');assert.equal(out.candidates.length,2)
})
test('a nearby bubble outside the opening span does not get assigned to the nearest window',()=>{
  const f=fixture();f.building.openings[0].offsetFt=0;f.building.openings[0].widthFt=2
  assert.equal(matchWindowSchedules(f.input,f.building,f.context)[0].status,'unmatched')
})
test('missing schedule scope and missing openings never invent matches or geometry',()=>{
  const f=fixture();assert.deepEqual(matchWindowSchedules(f.input,f.building,{...f.context,rows:[]}),[])
  assert.deepEqual(matchWindowSchedules(f.input,f.building,{...f.context,planSourceId:''}),[])
  f.building.openings=[];assert.deepEqual(matchWindowSchedules(f.input,f.building,f.context),[])
  const missing=reconcileWindowScheduleTags(f.input,f.building,f.context)
  assert.equal(missing.unmatchedTags.length,1);assert.equal(missing.unmatchedTags[0].tag.mark,'A')
  assert.equal(missing.unmatchedTags[0].schedules[0].sourceId,f.context.rows[0].sourceId)
})
test('shared reconstruction, saved floorplan projection and edit invalidation retain schedule evidence',()=>{
  const {reconstructBuilding}=require('../lib/drawings/building-reconstruction')
  const {buildingToFloorplan}=require('../lib/drawings/building-floorplan')
  const {floorplanModelSchema}=require('../lib/validation/floorplan')
  const {applyFloorplanEdit}=require('../lib/drawings/floorplan-model')
  const f=fixture();f.input.windowScheduleContext=f.context
  const points=[[[15,15],[18,15]],[[15,15.5],[18,15.5]],[[22,15],[25,15]],[[22,15.5],[25,15.5]],[[18,15],[18,15.5]],[[22,15],[22,15.5]],[[18,15.25],[22,15.25]]]
  f.input.evidence.paths.push(...points.map((pts,i)=>({...f.path,id:10+i,layer:[i===6?'A_WINDOW':'A_WALL'],commands:pts.map((p,j)=>[j?'L':'M',p[0]/60,p[1]/30])})))
  const architecture={version:1,elements:[],spaces:[],openings:[],finishZones:[],conflicts:[],spacePolicy:'include-fixtures',qualification:'unqualified'}
  const building=reconstructBuilding(f.input,architecture);architecture.building=building
  assert.equal(building.openings.length,1);assert.equal(building.scheduleAssociations[0].status,'proposed')
  assert.equal(building.openings[0].widthFt,4)
  const level=buildingToFloorplan({...f.input,name:'Floor',order:0,sheetVersionId:'plan-revision',sheetNumber:'A1',sheetTitle:'Plan',scaleConfirmed:true},architecture)
  const model={version:1,units:'feet',levels:[level],correctionCount:0}
  const parsed=floorplanModelSchema.parse(model)
  assert.deepEqual(parsed.levels[0].reconstruction.scheduleAssociations,building.scheduleAssociations)
  assert.equal(parsed.levels[0].openings[0].widthFt,4)
  const issue=level.reconstruction.issues.find(i=>i.code==='window-schedule')
  level.reconstruction.resolutions=[{issueId:issue.id,note:'Checked source association.'}]
  const renamed=applyFloorplanEdit(model,{type:'level.name',levelId:level.id,name:'Renamed'})
  assert.equal(renamed.levels[0].reconstruction.scheduleAssociations[0].status,'proposed')
  for(const edit of [
    {type:'opening.upsert',levelId:level.id,opening:{...level.openings[0],widthFt:3.9}},
    {type:'wall.update',levelId:level.id,wallId:level.openings[0].wallId,changes:{thicknessFt:.6}},
    {type:'level.height',levelId:level.id,ceilingHeightFt:10},
    {type:'opening.set',levelId:level.id,openingId:level.openings[0].id,kind:'door'},
  ]){
    const next=applyFloorplanEdit(model,edit),r=next.levels[0].reconstruction
    assert.equal(r.scheduleAssociations[0].status,'stale',edit.type)
    assert.equal(r.resolutions.length,0);assert.ok(r.issues.find(i=>i.id===issue.id).message.includes('changed'))
    assert.ok(floorplanModelSchema.safeParse(next).success)
  }
  const deleted=applyFloorplanEdit(model,{type:'opening.delete',levelId:level.id,openingId:level.openings[0].id})
  assert.equal(deleted.levels[0].reconstruction.scheduleAssociations.length,0)
  assert.ok(!deleted.levels[0].reconstruction.issues.some(i=>i.id===issue.id))
  assert.equal(deleted.levels[0].reconstruction.unmatchedScheduleTags[0].tag.mark,'A')
  assert.ok(deleted.levels[0].reconstruction.issues.some(i=>i.code==='window-schedule-unrepresented'))
  assert.equal(level.reconstruction.scheduleAssociations[0].status,'proposed')
})
test('a source window tag with no reconstructed opening survives projection as a localized review issue',()=>{
  const {reconstructBuilding}=require('../lib/drawings/building-reconstruction')
  const {buildingToFloorplan}=require('../lib/drawings/building-floorplan')
  const {floorplanModelSchema}=require('../lib/validation/floorplan')
  const f=fixture();f.input.windowScheduleContext=f.context
  const architecture={version:1,elements:[],spaces:[],openings:[],finishZones:[],conflicts:[],spacePolicy:'include-fixtures',qualification:'unqualified'}
  architecture.building=reconstructBuilding(f.input,architecture)
  assert.equal(architecture.building.openings.length,0)
  assert.equal(architecture.building.unmatchedScheduleTags.length,1)
  const issue=architecture.building.issues.find(i=>i.code==='window-schedule-unrepresented')
  assert.deepEqual(issue.pathIds,[1]);assert.ok(issue.point);assert.ok(issue.message.includes('tag A'))
  const level=buildingToFloorplan({...f.input,name:'Floor',order:0,sheetVersionId:'plan-revision',sheetNumber:null,sheetTitle:null},architecture)
  const saved=floorplanModelSchema.parse({version:1,units:'feet',levels:[level],correctionCount:0})
  assert.deepEqual(saved.levels[0].reconstruction.unmatchedScheduleTags,architecture.building.unmatchedScheduleTags)
})
