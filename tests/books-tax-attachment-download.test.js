require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),{createHash}=require('node:crypto')
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path')
const org='99600000-0000-4000-8000-000000000001',id=n=>'99600000-0000-4000-8000-'+String(n).padStart(12,'0')
const bytes=Buffer.from('Reviewed original evidence, preserved after a file changes.\n')
const proof={version:1,org_id:org,file_id:id(2),document_version_id:id(3),storage_path:org+'/tax/original.txt',file_name:'Tax "evidence"\r\n.txt',mime_type:'text/plain',size_bytes:bytes.length,checksum:createHash('sha256').update(bytes).digest('hex')}
const makeBatch=()=>({org_id:org,lines:[{id:id(4),kind:'permanent',amount_cents:100,description:'Permanent difference',evidence_reference:'Reviewed tax calculation',evidence_file_id:proof.file_id,project_id:null,evidence_snapshot:proof}]})
let batch=makeBatch(),denied=false,streamed=bytes,calls=[],storageError=false,inflightAbort=null,cancellations=0
const client={from(table){calls.push(['table',table]);const query={select(){return query},eq(key,value){calls.push([key,value]);return query},maybeSingle:async()=>({data:batch,error:null})};return query}}
const original=Module._load;let download,stage,GET
try{
 Module._load=function(name,...args){
  if(name==='server-only')return {}
  if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:id(9),supabase:client})}
  if(name==='@/lib/services/books/access'||name==='./access')return {requireBooksAuthorization:async input=>{calls.push(['authorize',input.permission]);if(denied)throw new Error('Denied')}}
  if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>client}
  if(name==='@/lib/storage/files-storage')return {getFilesObjectStream:async input=>{
   calls.push(['object',input.path]);assert.equal(input.orgId,org)
   if(storageError)throw new Error('Unavailable object')
   return {body:new ReadableStream({start(controller){controller.enqueue(streamed.subarray(0,10));if(inflightAbort){const abort=inflightAbort;setImmediate(()=>abort.abort());return}controller.enqueue(streamed.subarray(10));controller.close()},cancel(){cancellations++}})}
  }}
  return original.call(this,name,...args)
 }
 download=require('../lib/services/books/tax-attachment-download').downloadTaxWorkpaperAttachment
 stage=require('../lib/services/books/tax-attachments').stageVerifiedTaxAttachment
 GET=require('../app/api/books/tax-workpapers/[workpaperId]/attachments/[lineId]/route').GET
}finally{Module._load=original}
const temporaryDirectories=async()=>new Set((await fs.readdir(os.tmpdir())).filter(name=>name.startsWith('arc-tax-evidence-')))
async function assertClean(before){
 const deadline=Date.now()+2000
 while(Date.now()<deadline){const current=await temporaryDirectories();if([...current].every(name=>before.has(name)))return;await new Promise(resolve=>setTimeout(resolve,10))}
 assert.deepEqual(await temporaryDirectories(),before,'private staging files must be removed')
}
test('authorization and organization/line identity reject before original storage is touched',async()=>{
 calls=[];denied=true;await assert.rejects(download(id(5),id(4)),error=>error.status===403);assert.deepEqual(calls,[['authorize','books.read']]);denied=false
 for(const value of [null,{...makeBatch(),org_id:id(99)},makeBatch()]){
  batch=value;calls=[];await assert.rejects(download(id(5),id(99)),error=>error.status===404);assert.ok(!calls.some(row=>row[0]==='object'))
 }
 calls=[];await assert.rejects(download('bad',id(4)),error=>error.status===400);assert.deepEqual(calls,[])
 batch=makeBatch();batch.lines[0].evidence_snapshot=null
 await assert.rejects(download(id(5),id(4)),error=>error.status===409);batch=makeBatch()
})
test('download delivers the original verified bytes and cleans staging on completion or cancellation',async()=>{
 const before=await temporaryDirectories();calls=[];streamed=bytes
 const attachment=await download(id(5),id(4));assert.equal(attachment.name,proof.file_name)
 assert.deepEqual(Buffer.from(await new Response(attachment.body).arrayBuffer()),bytes)
 assert.ok(calls.some(row=>row[0]==='org_id'&&row[1]===org))
 assert.ok(calls.some(row=>row[0]==='object'&&row[1]===proof.storage_path));assert.ok(!calls.some(row=>row[1]==='files'))
 await assertClean(before)
 const cancelled=await stage(client,org,proof);await cancelled.cancel();await assertClean(before)
 const controller=new AbortController();controller.abort()
 await assert.rejects(stage(client,org,proof,controller.signal),/abort/i);await assertClean(before)
 inflightAbort=new AbortController();const priorCancellations=cancellations
 await assert.rejects(stage(client,org,proof,inflightAbort.signal),/abort/i)
 inflightAbort=null;assert.equal(cancellations,priorCancellations+1);await assertClean(before)
})
test('corruption, wrong size and unavailable originals fail before a download body is returned and clean temporary files',async()=>{
 const before=await temporaryDirectories()
 for(const content of [Buffer.from('x'.repeat(bytes.length)),bytes.subarray(1),Buffer.concat([bytes,Buffer.from('extra')])]){
  streamed=content;await assert.rejects(download(id(5),id(4)),error=>error.status===409);await assertClean(before)
 }
 streamed=bytes;storageError=true;await assert.rejects(download(id(5),id(4)),error=>error.status===409);storageError=false;await assertClean(before)
})
test('actual route sends private attachment headers and surfaces evidence failures without exposing storage details',async()=>{
 const before=await temporaryDirectories(),request=new Request('http://localhost/api/books/tax-workpapers/'+id(5)+'/attachments/'+id(4))
 const params=Promise.resolve({workpaperId:id(5),lineId:id(4)})
 const response=await GET(request,{params});assert.equal(response.status,200)
 assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('content-type'),'application/octet-stream')
 assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('content-length'),String(bytes.length))
 assert.ok(!response.headers.get('content-disposition').includes('\r'));assert.ok(!response.headers.get('content-disposition').includes('%0D'))
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);await assertClean(before)
 streamed=Buffer.from('corrupt');const failure=await GET(request,{params});assert.equal(failure.status,409)
 assert.ok(!(await failure.text()).includes(proof.storage_path));streamed=bytes;await assertClean(before)
})
