const assert = require("node:assert/strict")
const test = require("node:test")
const {loadHandler,database} = require("./fixtures/drawing-lifecycle/harness.cjs")
const path='org/project/drawings/uploads/operation/generation.pdf'
function fixture() {
 const operation={storage_path:path,generation:'generation',multipart_upload_id:'bound-upload',transfer_id:'transfer'}
 let allowed=true, active=true
 const {requireDrawingUploadForPath:gate}=loadHandler('app/api/drawings/multipart/upload-gate.ts',{
 '@/lib/services/permissions':{hasProjectPermission:async()=>allowed},
 '@/lib/services/drawing-upload-operations':{getDrawingUploadOperationForTransfer:async()=>{if(!active)throw Error('cancelled');return operation}},
 })
 const db=database({projects:[{id:'project',org_id:'org'}]})
 const input={supabase:db.client,orgId:'org',userId:'user',storagePath:path,uploadId:'bound-upload',transferId:'transfer'}
 return {gate,input,deny:()=>allowed=false,cancel:()=>active=false}
}
test('reservation followups require exact path, upload ID and transfer ownership',async()=>{
 const f=fixture();assert.equal(await f.gate(f.input),null)
 for(const patch of [{uploadId:'other'},{transferId:'other'},{storagePath:path.replace('generation','stale')},{storagePath:path.replace('org/','foreign/')},{uploadId:undefined}]) assert.ok(await f.gate({...f.input,...patch}))
 f.cancel();assert.equal((await f.gate(f.input)).status,409)
})
test('project permission and path validation apply to legacy and reserved routes',async()=>{
 const f=fixture();f.deny();assert.equal((await f.gate(f.input)).status,403)
 for(const storagePath of ['org/project/drawings/uploads/../generation.pdf','org/project/drawings/uploads/a/b/c','org/project/drawings/uploads/a\\b']) assert.equal((await f.gate({...f.input,storagePath})).status,400)
})

test('repeated create and lost binding response keep one authoritative upload',async()=>{
 const orgId='11111111-1111-4111-8111-111111111111',projectId='22222222-2222-4222-8222-222222222222',operationId='33333333-3333-4333-8333-333333333333',generation='44444444-4444-4444-8444-444444444444',transferId='55555555-5555-4555-8555-555555555555'
 const identity='sha256-chain-v1:8:'+ 'a'.repeat(64)
 const operation={id:operationId,generation,storage_path:`${orgId}/${projectId}/drawings/uploads/${operationId}/${generation}.pdf`,intent:{fileSize:8,fileName:'plans.pdf',mimeType:'application/pdf',fingerprint:identity},multipart_upload_id:null}
 let creates=0,aborts=0,loseBinding=true
 const db=database({projects:[{id:projectId,org_id:orgId}]})
 const {POST}=loadHandler('app/api/drawings/multipart/create/route.ts',{
 '@/lib/services/context':{requireOrgContext:async()=>({supabase:db.client,orgId,userId:'user'})},
 '@/lib/services/permissions':{hasProjectPermission:async()=>true},
 '@/lib/storage/drawings-pdfs-storage':{createDrawingPdfMultipartUpload:async input=>{creates++;assert.equal(input.operationId,operationId);assert.equal(input.generation,generation);return {storagePath:operation.storage_path,uploadId:'upload',provider:'r2'}},abortDrawingPdfMultipartUpload:async()=>{aborts++}},
 '@/lib/services/drawing-upload-operations':{getDrawingUploadOperationForTransfer:async()=>({...operation}),claimDrawingUploadTransfer:async input=>{if(input.uploadId){operation.multipart_upload_id=input.uploadId;if(loseBinding){loseBinding=false;throw Error('lost response')}}return {...operation}}},
 })
 const request=()=>new Request('https://fixture.invalid/api/drawings/multipart/create',{method:'POST',body:JSON.stringify({projectId,operationId,generation,transferId,identity,fileSize:8,fileName:'plans.pdf',contentType:'application/pdf'})})
 assert.equal((await POST(request())).status,200);assert.equal((await POST(request())).status,200)
 assert.equal(creates,1);assert.equal(aborts,0)
})

test('HEAD source resolution is opt-in and native upload identity never falls back to library',async t=>{
 const variables=['R2_ENDPOINT','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','DRAWINGS_PDFS_STORAGE'];const old=Object.fromEntries(variables.map(key=>[key,process.env[key]]))
 Object.assign(process.env,{R2_ENDPOINT:'https://fixture.invalid',R2_ACCESS_KEY_ID:'fixture',R2_SECRET_ACCESS_KEY:'fixture',DRAWINGS_PDFS_STORAGE:'r2'})
 t.after(()=>{for(const key of variables)old[key]===undefined?delete process.env[key]:process.env[key]=old[key]})
 const aws=require('@aws-sdk/client-s3'),calls=[]
 const {headDrawingPdfObject}=loadHandler('lib/storage/drawings-pdfs-storage.ts',{
 './drawing-pdf-source':require('../lib/storage/drawing-pdf-source'),
 '@/lib/storage/files-storage':{ensureOrgScopedPath:(org,path)=>{assert.ok(path.startsWith(org+'/'));return path}},
 '@aws-sdk/client-s3':{...aws,S3Client:class{async send(command){calls.push(command.input.Key);if(command.input.Key.startsWith('drawings-pdfs/'))throw Object.assign(Error('missing'),{name:'NoSuchKey'});return {ContentLength:12}}}},
 })
 const path='org/project/drawings/uploads/library-version.pdf'
 assert.equal((await headDrawingPdfObject({orgId:'org',path,resolveSource:true})).size,12)
 assert.deepEqual(calls,['drawings-pdfs/'+path,'project-files/'+path]);calls.length=0
 await assert.rejects(headDrawingPdfObject({orgId:'org',path}),/missing/)
 assert.deepEqual(calls,['drawings-pdfs/'+path])
})

test('multipart abort is idempotent for missing sessions and preserves other storage failures',async t=>{
 const variables=['R2_ENDPOINT','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','DRAWINGS_PDFS_STORAGE'];const old=Object.fromEntries(variables.map(key=>[key,process.env[key]]))
 Object.assign(process.env,{R2_ENDPOINT:'https://fixture.invalid',R2_ACCESS_KEY_ID:'fixture',R2_SECRET_ACCESS_KEY:'fixture',DRAWINGS_PDFS_STORAGE:'r2'})
 t.after(()=>{for(const key of variables)old[key]===undefined?delete process.env[key]:process.env[key]=old[key]})
 const aws=require('@aws-sdk/client-s3');let failure,calls=0
 const {abortDrawingPdfMultipartUpload}=loadHandler('lib/storage/drawings-pdfs-storage.ts',{
 './drawing-pdf-source':require('../lib/storage/drawing-pdf-source'),
 '@/lib/storage/files-storage':{ensureOrgScopedPath:(org,path)=>{assert.ok(path.startsWith(org+'/'));return path}},
 '@aws-sdk/client-s3':{...aws,S3Client:class{async send(command){calls++;assert.ok(command instanceof aws.AbortMultipartUploadCommand);if(failure)throw failure;return {}}}},
 })
 const input={orgId:'org',path:'org/project/drawings/uploads/op/generation.pdf',uploadId:'upload'}
 for(const current of [undefined,{name:'NoSuchUpload'},{$metadata:{httpStatusCode:404}}]) {failure=current;await assert.doesNotReject(abortDrawingPdfMultipartUpload(input))}
 for(const current of [Object.assign(Error('forbidden'),{$metadata:{httpStatusCode:403}}),Object.assign(Error('unavailable'),{$metadata:{httpStatusCode:503}}),Error('connection reset')]) {failure=current;await assert.rejects(abortDrawingPdfMultipartUpload(input),error=>error===current)}
 assert.equal(calls,6)
})
