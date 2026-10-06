const assert = require('node:assert/strict')
const test = require('node:test')
const { unzipSync } = require('fflate')
const { loadHandler } = require('./fixtures/drawing-lifecycle/harness.cjs')
const zip = loadHandler('lib/files/streaming-zip.ts')
const org='00000000-0000-4000-8000-000000000001',user='00000000-0000-4000-8000-000000000002',project='00000000-0000-4000-8000-000000000003',file='00000000-0000-4000-8000-000000000004',id='00000000-0000-4000-8000-000000000005'
function fixture() {
 const manifest=[{id:file,org_id:org,project_id:project,file_name:'plan.pdf',storage_path:`${org}/source`,size_bytes:4,folder_path:'plans',updated_at:'2026-01-01T00:00:00Z'}]
 const row={id,org_id:org,created_by:user,file_ids:[file],manifest,status:'queued',storage_path:null,attempt_id:null,error_message:null,expires_at:new Date(Date.now()+86400000).toISOString()}
 let allowed=true, owner=user, uploadFails=false, lostCommit=false
 const objects=new Map(),deleted=[]
 const service={rpc:async(_fn,args)=>{
  assert.equal(args.p_org_id,org)
  if(row.status==='ready'||row.status==='expired')return {data:[],error:null}
  row.status='processing';row.attempt_id=args.p_attempt_id;return {data:[structuredClone(row)],error:null}
 },from(table){let value;const filters=[];let one=false;const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},maybeSingle(){one=true;return q},update(v){value=v;return q},upsert(){return q},then(resolve,reject){return Promise.resolve().then(()=>{
  const rows=(table==='files'?manifest:[row]).filter(r=>filters.every(fn=>fn(r)))
  if(value){rows.forEach(r=>Object.assign(r,value));if(lostCommit){lostCommit=false;return {data:null,error:{message:'response lost'}}}}
  return {data:structuredClone(one?rows[0]??null:rows),error:null}
 }).then(resolve,reject)}};return q}}
 const sut=loadHandler('lib/services/document-exports.ts',{
  '@/lib/services/context':{requireOrgContext:async()=>({orgId:org,userId:owner})},
  '@/lib/services/permissions':{requireProjectPermission:async()=>{if(!allowed)throw Error('Forbidden')},requirePermission:async()=>{if(!allowed)throw Error('Forbidden')}},
  '@/lib/supabase/server':{createServiceSupabaseClient:()=>service},
  '@/lib/files/streaming-zip':zip,
  '@/lib/storage/files-storage':{
   getFilesObjectStream:async()=>({body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('plan'));c.close()}})}),
   uploadFilesStream:async({path,stream})=>{if(uploadFails){await stream.cancel();throw Error('upload failed')}objects.set(path,new Uint8Array(await new Response(stream).arrayBuffer()))},
   createFilesDownloadUrl:async()=>({downloadUrl:'https://fixture.test/download'}),
   listFilesObjects:async()=>[...objects.keys()].map(name=>({name})),
   deleteFilesObjects:async({paths})=>{paths.forEach(path=>{deleted.push(path);objects.delete(path)})},
  }
 })
 return {sut,row,objects,deleted,deny:()=>{allowed=false},otherOwner:()=>{owner=project},failUpload:()=>{uploadFails=true},loseCommit:()=>{lostCommit=true}}
}
test('export streams exact manifest bytes and reconciles lost database commit response',async()=>{
 const f=fixture();f.loseCommit();await f.sut.processDocumentExport(org,{export_id:id});assert.equal(f.row.status,'ready');assert.equal(f.objects.size,1)
 const bytes=f.objects.get(f.row.storage_path);assert.equal(new TextDecoder().decode(unzipSync(bytes)['plans/plan.pdf']),'plan')
 await f.sut.processDocumentExport(org,{export_id:id});assert.equal(f.objects.size,1)
})
test('download rechecks owner and current permissions before signing',async()=>{
 const f=fixture();await f.sut.processDocumentExport(org,{export_id:id});assert.equal(await f.sut.getDocumentExportDownload(id),'https://fixture.test/download')
 f.deny();await assert.rejects(f.sut.getDocumentExportDownload(id),/Forbidden/)
 const g=fixture();g.otherOwner();await assert.rejects(g.sut.getDocumentExport(id),/not found/)
})
test('failed attempts remain queued until the final durable retry',async()=>{
 const f=fixture();f.failUpload();await assert.rejects(f.sut.processDocumentExport(org,{export_id:id}));assert.equal(f.row.status,'queued')
 await assert.rejects(f.sut.processDocumentExport(org,{export_id:id},true));assert.equal(f.row.status,'failed')
})
test('expiry fences generation and deletes every immutable attempt output',async()=>{
 const f=fixture();await f.sut.processDocumentExport(org,{export_id:id});await assert.rejects(f.sut.processDocumentExportCleanup(org,{export_id:id}),/not expired/)
 f.row.expires_at=new Date(Date.now()-1000).toISOString();await f.sut.processDocumentExportCleanup(org,{export_id:id});assert.equal(f.row.status,'expired');assert.equal(f.objects.size,0);assert.equal(f.deleted.length,1)
 await assert.rejects(f.sut.getDocumentExportDownload(id),/expired/)
})

test('a retried expired worker cleans output that arrived after the first expiry sweep',async()=>{
 const f=fixture();f.row.status='expired';f.row.expires_at=new Date(Date.now()-1000).toISOString()
 f.objects.set(`${org}/document-exports/${id}/late.zip`,new Uint8Array([1]))
 await f.sut.processDocumentExport(org,{export_id:id})
 assert.equal(f.objects.size,0);assert.equal(f.deleted.length,1)
})
