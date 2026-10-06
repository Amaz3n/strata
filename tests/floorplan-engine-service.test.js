require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module')
const {randomUUID}=require('node:crypto')
const {runAreaEngine}=require('../lib/drawings/area-engine')
const {encodeTextRuns}=require('../lib/drawings/text-runs')
const orgId=randomUUID(),projectId=randomUUID(),generationId=randomUUID(),sheetId=randomUUID(),revisionId=randomUUID()
const evidence={version:1,extractionProfile:'floor-area-2',truncated:false,paths:[[[.1,.1],[.9,.1],[.9,.9],[.1,.9],[.1,.1]],[[.125,.125],[.875,.125],[.875,.875],[.125,.875],[.125,.125]]].map((points,id)=>({id,commands:points.map((p,i)=>[i?'L':'M',...p]),kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:1,dashes:[],layer:['A_WALL'],groups:[],clips:[],evenOdd:false}))}
const textRuns=[{text:'LIVING',x:.4,y:.4,w:.1,h:.03}]
let generation,updates,events,sourceFailure
const reset=()=>{generation={id:randomUUID(),generation_id:generationId,status:'processing',source_selection:[{sheetVersionId:sheetId,name:'Ground',order:0,feetPerImagePx:.02,region:{x0:0,y0:0,x1:1,y1:1}}],model:{previous:true}};updates=[];events=[];sourceFailure=false}
reset()
const supabase={from(table){
 let values,filters=[]
 const resolve=()=>{
  assert.ok(filters.some(([k,v])=>k==='org_id'&&v===orgId),'every worker query is organization scoped')
  if(table==='floorplan_models'){
   if(values){assert.ok(filters.some(([k,v])=>k==='generation_id'&&v===generationId));if(generation.generation_id!==generationId)return {data:null,error:null};updates.push(values);Object.assign(generation,values)}
   return {data:generation,error:null}
  }
  if(table==='sheet_building_records')return {data:null,error:{code:'42P01',message:'missing table'}}
  if(table==='drawing_revisions')return {data:{id:revisionId},error:null}
  if(table==='drawing_sheet_versions')return {data:[{id:sheetId,file_id:null,page_index:0,image_width:1000,image_height:1000,tiles_base_path:orgId+'/sheet',drawing_revision_id:revisionId,extracted_metadata:{},drawing_sheets:{sheet_number:'A1',sheet_title:'Floor plan',discipline:'Architectural',current_revision_id:revisionId,project_id:projectId}}],error:null}
  throw new Error('Unexpected table '+table)
 }
 const q={select(){return q},eq(k,v){filters.push([k,v]);return q},not(){return q},order(){return q},limit(){return q},update(v){values=v;return q},single:async()=>resolve(),maybeSingle:async()=>resolve(),then(a,b){return Promise.resolve().then(resolve).then(a,b)}}
 return q
}}
const originalLoad=Module._load
Module._load=function(request,parent,main){
 if(['/lib/services/floorplan-models.ts','/lib/services/architectural-evidence.ts'].some(s=>parent?.filename.endsWith(s))){
  const stubs={
   '@/lib/supabase/server':{createServiceSupabaseClient:()=>supabase},
   '@/lib/services/context':{},'@/lib/services/permissions':{},'@/lib/services/audit':{},'@/lib/services/outbox':{},
   '@/lib/services/events':{recordEvent:async e=>events.push(e)},
   '@/lib/services/ai/drawings-vision':{drawingsVisionConfigured:async()=>false},
   '@/lib/storage/drawings-tiles-storage':{downloadTilesObject:async({path})=>{assert.ok(path.startsWith(orgId+'/sheet/'));if(sourceFailure&&path.endsWith('area-evidence.json'))throw new Error('Original source unavailable');if(path.endsWith('area-evidence.json'))return Buffer.from(JSON.stringify(evidence));if(path.endsWith('text-runs.json'))return Buffer.from(encodeTextRuns(textRuns));throw new Error('No legacy vectors')},uploadTilesObject:async()=>{throw new Error('Unexpected source mutation')}},
   './architectural-recognition':{createArchitecturalRecognizer:()=>{throw new Error('Provider not enabled in this test')}},
  }
  if(request in stubs)return stubs[request]
 }
 return originalLoad.call(this,request,parent,main)
}
const {runFloorplanInterpretation}=require('../lib/services/floorplan-models')
Module._load=originalLoad

test.beforeEach(reset)
test('the generation worker saves the same physical geometry used by takeoff even without legacy vectors',async()=>{
 await runFloorplanInterpretation({orgId,target:{kind:'project',projectId},generationId})
 assert.equal(generation.status,'draft')
 const model=generation.model,level=model.levels[0]
 const shared=await runAreaEngine({evidence,textRuns,segments:[],imageWidth:1000,imageHeight:1000,feetPerImagePx:.02,region:{x0:0,y0:0,x1:1,y1:1},finishPolicy:'include-fixtures'},{wholeSheet:true})
 assert.equal(level.walls.length,4)
 assert.equal(level.rooms.length,1)
 assert.equal(level.rooms[0].areaSqft,225)
 assert.deepEqual(level.walls.map(w=>w.id),shared.detection.architecture.building.walls.map(w=>w.id))
 assert.equal(level.rooms[0].areaSqft,shared.detection.architecture.spaces[0].areaSqft)
 assert.ok(level.reconstruction)
 assert.equal(generation.drawing_revision_id,revisionId)
 assert.equal(events.length,1)
 assert.ok(updates.some(u=>u.generation_stage==='recognizing'))
})
test('a superseded generation cannot replace the current draft',async()=>{
 generation.generation_id=randomUUID()
 await runFloorplanInterpretation({orgId,target:{kind:'project',projectId},generationId})
 assert.deepEqual(generation.model,{previous:true});assert.equal(updates.length,0);assert.equal(events.length,0)
})
