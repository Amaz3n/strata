require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module')
const {createFakeSupabase}=require('./support/fake-supabase')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const ORG=id(1),REVISION=id(2),NEW=id(3),OLD=id(4),SHEET=id(5),PARENT=id(6),HOLE=id(7),FLOOR=id(8)
const ring=[[.1,.1],[.9,.1],[.9,.9],[.1,.9]]
const path={id:1,commands:[['M',.1,.1],['L',.9,.1]],kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:1,dashes:[],layer:['A_WALL'],groups:[],clips:[],evenOdd:false}
const source={evidence:{version:1,truncated:false,unrepresentedPaint:false,paths:[path]},textRuns:[],width:1000,height:1000,scale:.02}
let target,inserted,original,loads
const reset=()=>{
 target=structuredClone(source);inserted=[];loads=[]
 original=[{id:PARENT,drawing_sheet_id:SHEET,sheet_version_id:OLD,data:{type:'area',points:ring,style:{}},condition_id:FLOOR},
 {id:HOLE,drawing_sheet_id:SHEET,sheet_version_id:OLD,data:{type:'area',points:[[.4,.4],[.5,.4],[.5,.5],[.4,.5]],style:{parent_area_id:PARENT,deduction:true}},condition_id:FLOOR}]
}
const supabase={from(table){
 const versions=[{id:NEW,org_id:ORG,drawing_sheet_id:SHEET,drawing_revision_id:REVISION,created_at:'2026-10-04T12:00:00Z'},{id:OLD,org_id:ORG,drawing_sheet_id:SHEET,drawing_revision_id:id(9),created_at:'2026-10-03T12:00:00Z'}]
 const db=createFakeSupabase({drawing_sheet_versions:versions,drawing_markups:[...original.map(row=>({org_id:ORG,label:null,is_private:false,share_with_clients:false,share_with_subs:false,created_by:null,...row})),...inserted]})
 const q=db.from(table),run=q.run.bind(q)
 q.run=()=>{const result=run();if(q.action==='insert'){inserted.push(...structuredClone(q.payload));assert.ok(result.data.every(r=>r.org_id===ORG))}return result};return q
}}
const load=Module._load
Module._load=function(request,parent,main){
 if(parent?.filename.endsWith('/lib/services/takeoff-reanchor.ts')){
  const stubs={
   './area-revision':{loadAreaRevisionSource:async(db,org,version)=>{assert.equal(db,supabase);assert.equal(org,ORG);loads.push(version);return version===OLD?source:target}},
   '@/lib/services/context':{},'@/lib/services/permissions':{},'@/lib/services/audit':{},'@/lib/services/events':{recordEvent:async()=>{}},
   '@/lib/supabase/server':{createServiceSupabaseClient:()=>{throw new Error('No real client allowed')}},
   '@/lib/services/drawing-measurements':{assertConditionAcceptsUom:async(db,org,condition,uom)=>{assert.equal(db,supabase);assert.equal(org,ORG);assert.equal(condition,FLOOR);assert.equal(uom,'sf')},loadMeasurementContext:async()=>({}),measureMarkup:()=>({quantity:10,uom:'sf'})},
   '@/lib/services/change-events':{},
  };if(request in stubs)return stubs[request]
 }
 return load.call(this,request,parent,main)
}
const {reanchorRevisionMeasurements}=require('../lib/services/takeoff-reanchor')
Module._load=load
test.beforeEach(reset)
test('revision carries area and deduction together, remaps the parent, and never auto-confirms',async()=>{
 const result=await reanchorRevisionMeasurements(REVISION,ORG,supabase)
 assert.equal(result.carried,2);assert.equal(inserted.length,2)
 assert.deepEqual(loads.sort(),[NEW,OLD])
 assert.ok(inserted.every(r=>r.data.style.reanchor.state==='needs_review'&&r.data.style.reanchor.evidence_comparison==='unavailable'),'unavailable deduction evidence also prevents parent-only confirmation')
 assert.equal(inserted[1].data.style.parent_area_id,inserted[0].id)
 assert.notEqual(inserted[0].id,PARENT);assert.equal(original[1].data.style.parent_area_id,PARENT)
 const retry=await reanchorRevisionMeasurements(REVISION,ORG,supabase)
 assert.equal(retry.carried,0);assert.equal(inserted.length,2)
 for(const row of inserted)delete row.data.style.reanchor
 assert.equal((await reanchorRevisionMeasurements(REVISION,ORG,supabase)).carried,0,'confirmation must not erase carry provenance')
})
test('changed or unavailable revision evidence stays pending review',async()=>{
 target.evidence.paths[0].commands[1][1]=.85
 await reanchorRevisionMeasurements(REVISION,ORG,supabase)
 assert.equal(inserted[0].data.style.reanchor.evidence_comparison,'changed')
 assert.equal(inserted[0].data.style.reanchor.reason,'region_changed')
 reset();target=null
 await reanchorRevisionMeasurements(REVISION,ORG,supabase)
 assert.ok(inserted.every(r=>r.data.style.reanchor.state==='needs_review'&&r.data.style.reanchor.evidence_comparison==='unavailable'))
})
test('a deduction without a carryable parent fails before inserting partial measurements',async()=>{
 original=original.slice(1)
 await assert.rejects(()=>reanchorRevisionMeasurements(REVISION,ORG,supabase),/without its parent/)
 assert.equal(inserted.length,0)
})

test('unchanged area evidence remains advisory and unconfirmed',async()=>{
 original=original.slice(0,1)
 await reanchorRevisionMeasurements(REVISION,ORG,supabase)
 assert.equal(inserted[0].data.style.reanchor.evidence_comparison,'unchanged')
 assert.equal(inserted[0].data.style.reanchor.state,'needs_review')
})
