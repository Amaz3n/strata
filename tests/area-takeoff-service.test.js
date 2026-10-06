require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module')
const {randomUUID}=require('node:crypto')
const orgId=randomUUID(),userId=randomUUID(),projectId=randomUUID(),sheetId=randomUUID(),versionId=randomUUID(),revisionId=randomUUID(),conditionId=randomUUID()
let denied,scale,revision,conditionProject,unit,writeError,auditError,rows,permissions,artifacts,imageSize,snapshotChanged,visionCalls,visionAnswer
const reset=()=>{visionCalls=0;visionAnswer=null;snapshotChanged=false;denied=null;scale=.02;revision=revisionId;conditionProject=projectId;unit='sf';writeError=null;auditError=false;rows=new Map();permissions=[];artifacts=new Map();imageSize={width:1000,height:1000}}
reset()
const queries=[]
const supabase={async rpc(name,args){
 assert.equal(name,'accept_takeoff_area_snapshot');assert.equal(args.p_org_id,orgId);assert.equal(args.p_version_id,versionId);assert.equal(args.p_condition_id,conditionId)
 if(writeError)return {error:writeError}
 const current=[...rows.values()].map(({id,data})=>({id,data})).sort((a,b)=>a.id.localeCompare(b.id))
 assert.deepEqual(args.p_snapshot,current)
 if(snapshotChanged)return {error:{message:'Measurements changed during review'}}
 for(const row of args.p_rows)if(!rows.has(row.id))rows.set(row.id,row)
 return {error:null}
},from(table){
 const filters=[];let values
 const q={select(){return q},order(){return q},limit(){return q},gt(k,v){filters.push([k,v]);return q},eq(k,v){filters.push([k,v]);return q},upsert(v,opts){assert.equal(opts.ignoreDuplicates,true);values=v;return q},
 maybeSingle(){
  assert.ok(filters.some(([k,v])=>k==='org_id'&&v===orgId))
  // Pre-migration production: the building record table is absent and detection keeps its storage cache.
  if(table==='sheet_building_records')return Promise.resolve({data:null,error:{code:'PGRST205',message:'missing table'}})
  const data=table==='drawing_sheet_versions'?{id:versionId,drawing_sheet_id:sheetId,drawing_revision_id:revisionId,tiles_base_path:`${orgId}/test`}:table==='drawing_sheets'?{id:sheetId,project_id:projectId,current_revision_id:revision}:table==='takeoff_conditions'?{id:conditionId,name:'Floor',color:'#123456',uom:unit,height_ft:null,pitch_rise:null,project_id:conditionProject,house_plan_version_id:null}:null
  return Promise.resolve({data,error:null})
 },then(resolve,reject){if(values&&!writeError)for(const row of values){assert.equal(row.org_id,orgId);if(!rows.has(row.id))rows.set(row.id,row)}return Promise.resolve({data: values ? null : [...rows.values()].filter(r=>filters.every(([k,v])=>k==='id'?r.id>v:r[k]===v)), error:values ? writeError : null}).then(resolve,reject)}}
 queries.push({table,filters});return q
}}
const originalLoad=Module._load
Module._load=function(request,parent,main){
 if(['/lib/services/area-takeoff.ts','/lib/services/architectural-recognition.ts','/lib/services/architectural-evidence.ts'].some(suffix=>parent?.filename.endsWith(suffix))){
  const stubs={
   './context':{requireOrgContext:async()=>({supabase,orgId,userId})},
   './permissions':{requirePermission:async(p)=>{permissions.push(p);if(denied===p)throw new Error('Denied')}},
   './drawing-measurements':{loadMeasurementContext:async()=>({imageSize,feetPerImagePx:scale}),assertConditionAcceptsUom:async()=>{if(unit!=='sf')throw new Error('Wrong unit')}},
   './takeoff':{assertMarkupsInScope:async(_db,org,condition,sheets)=>{assert.equal(org,orgId);if(condition.project_id!==sheets[0].drawing_sheets.project_id)throw new Error('Wrong project')}},
   './audit':{recordAudit:async()=>{if(auditError)throw new Error('Audit unavailable')}},
   './events':{recordEvent:async()=>{}},
   '@/lib/storage/drawings-tiles-storage':{downloadTilesObject:async({path})=>{assert.ok(path.startsWith(`${orgId}/test/`));const bytes=artifacts.get(path.split('/').pop());if(!bytes)throw new Error('Missing');return bytes},uploadTilesObject:async({path,bytes})=>{assert.ok(path.startsWith(`${orgId}/test/`));artifacts.set(path.split('/').pop(),bytes)}},'./drawings-sheet-images':{renderSheetWindowImage:async()=>({data:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAeklEQVRogdXOQREAAAyDMPybZiL62BEFwTiMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwziMwzi+A6sDylPSwurF5TQAAAAASUVORK5CYII=','base64'),mediaType:'image/png'})},'./ai/drawings-vision':{runDrawingsVisionObject:async()=>{visionCalls++;return visionAnswer}},
  };if(request in stubs)return stubs[request]
  if(request==='@/lib/services/drawings-sheet-images')return stubs['./drawings-sheet-images']
  if(request==='@/lib/services/ai/drawings-vision')return stubs['./ai/drawings-vision']
 }
 return originalLoad.call(this,request,parent,main)
}
const {acceptTakeoffAreas,proposeTakeoffAreas,exportAreaDetectionReplay}=require('../lib/services/area-takeoff')
Module._load=originalLoad
const ring=[[.1,.1],[.9,.1],[.9,.9],[.1,.9]],hole=[[.4,.4],[.45,.4],[.45,.45],[.4,.45]]
const payload=()=>({sheet_version_id:versionId,condition_id:conditionId,expected_scale:.02,reviewed:true,elapsed_ms:1000,areas:[{
 id:'room',label:'Kitchen',points:ring,originalPoints:ring,holes:[hole],boundary:[],source:'vector',edited:false,
 // A client-supplied quantity is deliberately ignored by validation.
 areaSqft:999999,
}]})
test.beforeEach(reset)
test('server derives outer area and deduction quantities and stamps evidence',async()=>{
 await acceptTakeoffAreas(payload());assert.equal(rows.size,2)
 assert.deepEqual([...rows.values()].map((r)=>r.quantity),[256,-1])
 assert.ok([...rows.values()].every((r)=>r.data.style.reviewed&&r.data.style.original_points&&r.sheet_version_id===versionId))
 assert.deepEqual(permissions,['takeoff.write','drawing.markup'])
})
test('repeated acceptance and winding changes cannot double count',async()=>{
 await acceptTakeoffAreas(payload());const retry=payload();retry.areas[0].points=[...ring].reverse()
 await acceptTakeoffAreas(retry);assert.equal(rows.size,2)
})
test('retry after audit failure does not repeat quantities',async()=>{
 auditError=true;await assert.rejects(()=>acceptTakeoffAreas(payload()),/Audit/);assert.equal(rows.size,2)
 auditError=false;await acceptTakeoffAreas(payload());assert.equal(rows.size,2)
})
test('scale or revision changed after detection prevents writes',async()=>{
 scale=.03;await assert.rejects(()=>acceptTakeoffAreas(payload()),/scale changed/);assert.equal(rows.size,0)
 scale=.02;revision=randomUUID();await assert.rejects(()=>acceptTakeoffAreas(payload()),/current revision/);assert.equal(rows.size,0)
})
test('cross-project, wrong-unit and denied writes are rejected',async()=>{
 conditionProject=randomUUID();await assert.rejects(()=>acceptTakeoffAreas(payload()),/project/);assert.equal(rows.size,0)
 conditionProject=projectId;unit='lf';await assert.rejects(()=>acceptTakeoffAreas(payload()),/SF or SY/);assert.equal(rows.size,0)
 unit='sf';denied='takeoff.write';await assert.rejects(()=>acceptTakeoffAreas(payload()),/Denied/);assert.equal(rows.size,0)
})
test('batch database failure leaves no partial outer-area/deduction pair',async()=>{
 writeError={message:'Unavailable'};await assert.rejects(()=>acceptTakeoffAreas(payload()),/Unavailable/);assert.equal(rows.size,0)
})
test('reruns reject overlapping existing measurements and changed deductions',async()=>{
 await acceptTakeoffAreas(payload())
 const shifted=payload();shifted.areas[0].points=[[.11,.1],[.91,.1],[.91,.9],[.11,.9]]
 await assert.rejects(()=>acceptTakeoffAreas(shifted),/overlaps an existing/)
 const changed=payload();changed.areas[0].holes=[]
 await assert.rejects(()=>acceptTakeoffAreas(changed),/different deductions/)
 assert.equal(rows.size,2)
})
test('manual measurements in the same condition cannot be counted again',async()=>{
 rows.set('manual',{id:'manual',org_id:orgId,sheet_version_id:versionId,condition_id:conditionId,data:{type:'area',points:ring}})
 await assert.rejects(()=>acceptTakeoffAreas(payload()),/overlaps an existing/)
 assert.equal(rows.size,1)
})

test('whole-sheet proposal action uses stored evidence without a region and checks permissions',async()=>{
 const {encodeTextRuns}=require('../lib/drawings/text-runs')
 const path={id:1,commands:[['M',.1,.1],['L',.9,.1],['L',.9,.9],['L',.1,.9],['Z']],kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:1,dashes:[],layer:['A_WALL'],groups:[],clips:[],evenOdd:false}
 artifacts.set('area-evidence.json',Buffer.from(JSON.stringify({version:1,extractionProfile:"floor-area-2",truncated:false,paths:[path]})))
 artifacts.set('text-runs.json',Buffer.from(encodeTextRuns([{text:'BEDROOM',x:.3,y:.3,w:.2,h:.02}])))
 const result=await proposeTakeoffAreas({sheet_version_id:versionId})
 assert.equal(result.proposals.length,1);assert.equal(result.proposals[0].areaSqft,256)
 assert.equal(result.scale,.02);assert.deepEqual(permissions,['takeoff.read'])
 denied='takeoff.read';await assert.rejects(()=>proposeTakeoffAreas({sheet_version_id:versionId}),/Denied/)
 denied=null;await assert.rejects(()=>proposeTakeoffAreas({sheet_version_id:versionId,vision:true}),/Choose a region/)
})
test('Burke whole-sheet action returns precise printed bedroom areas through stored artifact parsing',{skip:!process.env.ARC_BURKE_PDF},async()=>{
 const {execFileSync}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
 const {encodeTextRuns}=require('../lib/drawings/text-runs')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arc-area-service-'))
 try {
  const target=path.join(dir,'fixture.json')
  execFileSync(process.execPath,['scripts/import-area-pdf.js',process.env.ARC_BURKE_PDF,'4',String(4/72),target])
  const {input}=JSON.parse(fs.readFileSync(target,'utf8'))
  artifacts.set('area-evidence.json',Buffer.from(JSON.stringify(input.evidence)))
  artifacts.set('text-runs.json',Buffer.from(encodeTextRuns(input.textRuns)))
  imageSize={width:input.imageWidth,height:input.imageHeight};scale=input.feetPerImagePx
  const result=await proposeTakeoffAreas({sheet_version_id:versionId})
  for(const [label,expected] of [['BEDROOM 2',118],['BEDROOM 3',118],['MASTER BEDROOM',180]]){
   const areas=result.proposals.filter(p=>p.label===label)
   assert.equal(areas.length,1,label);assert.ok(Math.abs(areas[0].areaSqft-expected)/expected<.02,label)
  }
  assert.ok(result.warnings.some(w=>w.includes('ENTRY')),'incomplete coverage must remain visible')
  const chosen=result.proposals.filter(p=>p.label==='BEDROOM 2'||p.label==='BEDROOM 3')
  await acceptTakeoffAreas({...payload(),expected_scale:scale,areas:chosen})
  assert.equal(rows.size,2)
  for(const row of rows.values())assert.ok(Math.abs(row.quantity-118)/118<.02)
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})

test('a concurrent measurement change rejects the complete acceptance batch',async()=>{
 snapshotChanged=true
 await assert.rejects(()=>acceptTakeoffAreas(payload()),/Measurements changed/)
 assert.equal(rows.size,0)
})
test('missing transaction migration fails clearly without a non-atomic fallback',async()=>{
 writeError={code:'PGRST202',message:'Function not found'}
 await assert.rejects(()=>acceptTakeoffAreas(payload()),/transaction database update/)
 assert.equal(rows.size,0)
})

test('Tornincaso proposals pass actual service parsing and atomic acceptance with mocked persistence',{skip:!process.env.ARC_TORNINCASO_PDF},async()=>{
 const {execFileSync}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
 const {encodeTextRuns}=require('../lib/drawings/text-runs')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arc-torn-service-'))
 try {
  const target=path.join(dir,'fixture.json')
  execFileSync(process.execPath,['scripts/import-area-pdf.js',process.env.ARC_TORNINCASO_PDF,'4',String(4/72),target])
  const {input}=JSON.parse(fs.readFileSync(target,'utf8'))
  artifacts.set('area-evidence.json',Buffer.from(JSON.stringify(input.evidence)))
  artifacts.set('text-runs.json',Buffer.from(encodeTextRuns(input.textRuns)))
  imageSize={width:input.imageWidth,height:input.imageHeight};scale=input.feetPerImagePx
  const result=await proposeTakeoffAreas({sheet_version_id:versionId})
  for(const label of ['BEDROOM 1','BEDROOM 2','BEDROOM 3','OFFICE','POWDER'])assert.equal(result.proposals.filter(p=>p.label===label).length,1,label)
  const chosen=result.proposals.filter(p=>p.label==='OFFICE'||p.label==='POWDER'||p.label==='OUTDOOR LIVING / OUTDOOR KITCHEN')
  assert.ok(chosen.some(p=>p.label.startsWith('OUTDOOR')&&p.holes.length>0),'pool void reaches acceptance as a deduction')
  await acceptTakeoffAreas({...payload(),expected_scale:scale,areas:chosen})
  assert.equal(rows.size,chosen.reduce((count,area)=>count+1+area.holes.length,0),'outer areas and all deductions are persisted together')
  const first=rows.size
  await acceptTakeoffAreas({...payload(),expected_scale:scale,areas:chosen})
  assert.equal(rows.size,first,'retry cannot duplicate outer areas or deductions')
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})

test('finish scope notes are persisted with outer areas and deductions and bounded by validation',async()=>{
 const p=payload();p.areas[0].holes=[hole];p.areas[0].finishScopeNote='Same tile through shared living/dining; exclude fixed island.'
 await acceptTakeoffAreas(p)
 assert.ok([...rows.values()].every(r=>r.data.style.finish_scope_note===p.areas[0].finishScopeNote))
 const invalid=payload();invalid.areas[0].finishScopeNote='x'.repeat(501)
 await assert.rejects(acceptTakeoffAreas(invalid))
})


test('hybrid service records source-bound observations and exports only the current drawing replay',async()=>{
 const {encodeTextRuns}=require('../lib/drawings/text-runs')
 const path={id:1,commands:[['M',.1,.1],['L',.9,.1],['L',.9,.9],['L',.1,.9],['Z']],kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:1,dashes:[],layer:[],groups:[],clips:[],evenOdd:false}
 artifacts.set('area-evidence.json',Buffer.from(JSON.stringify({version:1,extractionProfile:"floor-area-2",truncated:false,paths:[path]})))
 artifacts.set('text-runs.json',Buffer.from(encodeTextRuns([{text:'BEDROOM',x:.3,y:.3,w:.2,h:.02}])))
 visionAnswer={elements:[{pathIds:[1],kind:'wall'}],openings:[]}
 const result=await proposeTakeoffAreas({sheet_version_id:versionId})
 assert.equal(visionCalls,1);assert.equal(result.diagnostic.recognition,'completed')
 assert.equal(result.proposals.length,1);assert.equal(result.proposals[0].areaSqft,256)
 assert.equal(result.architecture.spaces[0].boundary.status,'needs-review')
 const replay=JSON.parse(await exportAreaDetectionReplay(versionId,result.diagnostic.inputHash))
 assert.equal(replay.source.sheetVersionId,versionId);assert.equal(replay.input.visualObservations.length,1)
 await assert.rejects(()=>exportAreaDetectionReplay(versionId,'../other-org'),/Invalid/)
 const key='replay-'+result.diagnostic.inputHash+'.json'
 artifacts.set(key,Buffer.from(JSON.stringify({...replay,source:{sheetVersionId:randomUUID()}})))
 await assert.rejects(()=>exportAreaDetectionReplay(versionId,result.diagnostic.inputHash),/different drawing/)
})

test('empty recognition saves its replay but remains unavailable and retryable',async()=>{
 const {encodeTextRuns}=require('../lib/drawings/text-runs')
 imageSize={width:10000,height:1000}
 const paths=Array.from({length:5},(_,i)=>{
   const x=.04+i*.2
   return {id:i+1,commands:[['M',x,.1],['L',x+.1,.1],['L',x+.1,.9],['L',x,.9],['Z']],kind:'stroke',color:[0],colorSpace:'DeviceGray',opacity:1,width:1,dashes:[],layer:[],groups:[],clips:[],evenOdd:false}
 })
 artifacts.set('area-evidence.json',Buffer.from(JSON.stringify({version:1,extractionProfile:"floor-area-2",truncated:false,paths})))
 artifacts.set('text-runs.json',Buffer.from(encodeTextRuns(paths.map((_,i)=>({text:'BEDROOM '+(i+1),x:.07+i*.2,y:.3,w:.01,h:.02})))))
 visionAnswer={elements:[],openings:[]}
 const first=await proposeTakeoffAreas({sheet_version_id:versionId})
 assert.equal(first.diagnostic.recognition,'unavailable');assert.equal(visionCalls,4)
 assert.ok(artifacts.has('replay-'+first.diagnostic.inputHash+'.json'))
 await proposeTakeoffAreas({sheet_version_id:versionId})
 assert.equal(visionCalls,8,'Explicit retry must not return a permanent partial-result cache')
})
