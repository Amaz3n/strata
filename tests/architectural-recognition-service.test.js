require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),sharp=require('sharp')
let saved,reads,renders,calls,image
const originalLoad=Module._load
Module._load=function(request,parent,main){
 if(parent?.filename.endsWith('/lib/services/architectural-recognition.ts')){
  if(request==='@/lib/storage/drawings-tiles-storage')return {
   downloadTilesObject:async({path})=>{reads++;if(!saved.has(path))throw Error('Missing');return saved.get(path)},
   uploadTilesObject:async({path,bytes})=>{saved.set(path,bytes)},
  }
  if(request==='@/lib/services/drawings-sheet-images')return {renderSheetWindowImage:async()=>{renders++;return {data:image,mediaType:'image/png'}}}
  if(request==='@/lib/services/ai/drawings-vision')return {runDrawingsVisionObject:async options=>{
   calls++;assert.equal(options.allowFallback,false);assert.equal(options.allowEscalation,false)
   assert.ok(options.timeoutMs>0&&options.timeoutMs<=45000)
   return {elements:[{kind:'wall',pathIds:[1]}],openings:[]}
  }}
 }
 return originalLoad.call(this,request,parent,main)
}
const {createArchitecturalRecognizer}=require('../lib/services/architectural-recognition')
Module._load=originalLoad
const input={supabase:{},orgId:'org',sheetVersionId:'sheet',tilesBasePath:'org/sheet',imageWidth:100,imageHeight:100,evidence:{version:1,paths:[]}}
const request={region:{x0:0,y0:0,x1:1,y1:1},catalogue:[{id:1,prior:'unknown',kind:'stroke',bounds:[.1,.1,.8,.1],commands:[['M',.1,.1],['L',.8,.1]]}]}
test.beforeEach(async()=>{saved=new Map();reads=0;renders=0;calls=0;image=await sharp({create:{width:100,height:100,channels:3,background:'white'}}).png().toBuffer()})
test('persisted classifications resume in a fresh recognizer without rendering or spending another provider call',async()=>{
 const first=createArchitecturalRecognizer(input)
 assert.equal(await first.cached(request),null)
 const answer=await first(request)
 assert.equal(reads,1,'cache lookup and execution share the same read')
 assert.equal(calls,1);assert.equal(renders,1);assert.equal(saved.size,1)
 const resumed=createArchitecturalRecognizer(input)
 assert.deepEqual(await resumed.cached(request),answer)
 assert.deepEqual(await resumed(request),answer)
 assert.equal(reads,2);assert.equal(calls,1);assert.equal(renders,1)
})
test('different evidence, sheet or crop cannot reuse a saved classification',async()=>{
 await createArchitecturalRecognizer(input)(request)
 for(const changed of [{...input,sheetVersionId:'new-sheet'},{...input,evidence:{...input.evidence,truncated:true}}])
  assert.equal(await createArchitecturalRecognizer(changed).cached(request),null)
 assert.equal(await createArchitecturalRecognizer(input).cached({...request,region:{x0:0,y0:0,x1:.9,y1:1}}),null)
 assert.equal(calls,1)
})
test('empty, corrupt and incorrectly fingerprinted saved answers are retried instead of becoming permanent empty hits',async()=>{
 await createArchitecturalRecognizer(input)(request)
 const [key,bytes]=[...saved.entries()][0],valid=JSON.parse(bytes)
 for(const bad of ['{',JSON.stringify({...valid,answer:{elements:[],openings:[]}}),JSON.stringify({...valid,fingerprint:'wrong'})]){
  saved.set(key,Buffer.from(bad))
  const retry=createArchitecturalRecognizer(input)
  assert.equal(await retry.cached(request),null)
  assert.ok(await retry(request))
 }
 assert.equal(calls,4)
})

test('context source identity changes both the registered overlay and persisted classification fingerprint',async()=>{
 const first=createArchitecturalRecognizer(input);await first(request)
 const originalSaved=JSON.parse([...saved.values()][0].toString('utf8'))
 const contextual={...request,contextCatalogue:[{id:2,prior:'unknown',kind:'stroke',bounds:[.1,.2,.8,.2],commands:[['M',.1,.2],['L',.8,.2]]}]}
 const next=createArchitecturalRecognizer(input);assert.equal(await next.cached(contextual),null);await next(contextual);assert.equal(calls,2);assert.equal(saved.size,2)
 const changed=JSON.parse([...saved.values()][1].toString('utf8'));assert.notEqual(changed.fingerprint,originalSaved.fingerprint);assert.notEqual(changed.sourceImage.annotatedSha256,originalSaved.sourceImage.annotatedSha256)
 const resumed=createArchitecturalRecognizer(input);assert.ok(await resumed.cached(contextual));assert.equal(calls,2)
 assert.equal(await resumed.cached({...contextual,contextCatalogue:[{...contextual.contextCatalogue[0],commands:[['M',.1,.2],['L',.7,.2]]}]}),null)
})
