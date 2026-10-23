const assert = require('node:assert/strict')
const test = require('node:test')
const { loadHandler } = require('./fixtures/drawing-lifecycle/harness.cjs')
const org = '00000000-0000-4000-8000-000000000001'
const project = '00000000-0000-4000-8000-000000000002'
const user = '00000000-0000-4000-8000-000000000003'
const id = '00000000-0000-4000-8000-000000000004'
const size = 20 * 1024 * 1024
const identity = `sha256-chain-v1:${size}:${'a'.repeat(64)}`
function fixture() {
  const rows = new Map(), objects = new Map(), uploads = new Map(), aborted = []
  let owner = user, created = 0, lostComplete = false, lostBind = false
  const service = { from() {
    const filters = []; let mutation
    const q = {
      select(){return q}, eq(k,v){filters.push(r=>r[k]===v);return q}, is(k,v){filters.push(r=>(r[k]??null)===v);return q}, maybeSingle(){q.single=true;return q},
      upsert(v){mutation={kind:'insert',value:v};return q}, update(v){mutation={kind:'update',value:v};return q},
      then(resolve,reject){return Promise.resolve().then(()=>{
        if(mutation?.kind==='insert'&&!rows.has(mutation.value.id)) rows.set(mutation.value.id,{upload_id:null,cancelled_at:null,expires_at:new Date(Date.now()+86400000).toISOString(),...mutation.value})
        const found=[...rows.values()].filter(r=>filters.every(f=>f(r)))
        if(mutation?.kind==='update') {found.forEach(r=>Object.assign(r,mutation.value)); if(lostBind){lostBind=false;return {error:{message:'lost response'},data:null}}}
        return {data:q.single?structuredClone(found[0]??null):structuredClone(found),error:null}
      }).then(resolve,reject)}
    }; return q
  }}
  const storage = {
    async headFilesObject({path}) {if(!objects.has(path)){const error=new Error('missing');error.name='NotFound';throw error}return objects.get(path)},
    isMissingFilesObject:e=>e.name==='NotFound',
    async createFilesMultipartUpload({path,metadata}) {const uploadId=`u${++created}`;uploads.set(uploadId,{path,metadata,parts:[]});return {uploadId}},
    async abortFilesMultipartUpload({uploadId}){aborted.push(uploadId);uploads.delete(uploadId)},
    async listFilesMultipartParts({uploadId}){if(!uploads.has(uploadId)){const e=new Error('gone');e.name='NoSuchUpload';throw e}return uploads.get(uploadId).parts},
    async createFilesMultipartPartUrl({partNumber}){return {uploadUrl:`fixture:${partNumber}`}},
    async completeFilesMultipartUpload({path,uploadId}){const upload=uploads.get(uploadId);objects.set(path,{size,metadata:upload.metadata});uploads.delete(uploadId);if(lostComplete){lostComplete=false;throw Error('lost complete')}},
    async createFilesUploadUrl({metadata}){return {uploadUrl:'fixture:put',uploadHeaders:Object.fromEntries(Object.entries(metadata).map(([k,v])=>[`x-amz-meta-${k}`,v]))}},
  }
  class UploadPreparationError extends Error {}
  const sut=loadHandler('lib/services/document-upload-transfers.ts',{
    '@/lib/services/context':{requireOrgContext:async()=>({orgId:org,userId:owner})},
    '@/lib/services/files':{UploadPreparationError,prepareProjectDocumentUpload:async input=>({orgId:org,projectId:project,contentType:input.contentType,storagePath:`${org}/${project}/documents/uploads/new-${Math.random()}`})},
    '@/lib/services/permissions':{requireProjectPermission:async()=>{}},
    '@/lib/supabase/server':{createServiceSupabaseClient:()=>service},
    '@/lib/storage/files-storage':storage,
  })
  const input={transferId:id,projectId:project,fileName:'test.pdf',contentType:'application/pdf',fileSize:size,identity}
  return {sut,input,rows,uploads,objects,aborted,owner:v=>{owner=v},loseComplete:()=>{lostComplete=true},loseBind:()=>{lostBind=true},count:()=>created}
}
test('repeated create returns the same server-owned key and upload ID; lost bind response reconciles',async()=>{
 const f=fixture(); f.loseBind(); const a=await f.sut.createDocumentTransfer(f.input,'multipart'); const b=await f.sut.createDocumentTransfer(f.input,'multipart')
 assert.equal(a.storagePath,b.storagePath);assert.equal(a.uploadId,b.uploadId);assert.equal(f.count(),1)
 await assert.rejects(f.sut.createDocumentTransfer({...f.input,fileName:'other.pdf'},'multipart'),/identity/)
})
test('complete reconciles lost R2 response and retry does not complete a consumed session',async()=>{
 const f=fixture();const a=await f.sut.createDocumentTransfer(f.input,'multipart')
 const parts=[{partNumber:1,etag:'one',size:16*1024*1024},{partNumber:2,etag:'two',size:4*1024*1024}]
 f.uploads.get(a.uploadId).parts=parts
 const session={...f.input,...a,parts};f.loseComplete();await f.sut.completeDocumentTransfer(session)
 assert.deepEqual(await f.sut.documentTransferStatus(session),{state:'completed'})
 assert.deepEqual(await f.sut.completeDocumentTransfer(session),{storagePath:a.storagePath})
})
test('wrong owner, forged object identity and incomplete remote parts are rejected',async()=>{
 const f=fixture();const a=await f.sut.createDocumentTransfer(f.input,'multipart');const session={...f.input,...a}
 f.owner('00000000-0000-4000-8000-000000000005');await assert.rejects(f.sut.documentTransferStatus(session),/not found/)
 f.owner(user);await assert.rejects(f.sut.completeDocumentTransfer({...session,parts:[{partNumber:1,etag:'x'}]}),/incomplete/)
 f.objects.set(a.storagePath,{size,metadata:{'transfer-id':id,'content-identity':'wrong'}})
 await assert.rejects(f.sut.documentTransferStatus(session),/does not match/)
})
test('cancel by queue identity aborts a persisted upload, is idempotent and preserves completed bytes',async()=>{
 const f=fixture();const a=await f.sut.createDocumentTransfer(f.input,'multipart')
 await f.sut.cancelDocumentTransferById(f.input);await f.sut.cancelDocumentTransferById(f.input);assert.deepEqual(f.aborted,[a.uploadId])
 const g=fixture();const b=await g.sut.createDocumentTransfer(g.input,'multipart');g.objects.set(b.storagePath,{size,metadata:{'transfer-id':id,'content-identity':identity}})
 await g.sut.cancelDocumentTransferById(g.input);assert.equal(g.aborted.length,0);assert.equal(g.objects.size,1)
})
test('single PUT retry recognizes complete bytes and does not reissue a mutable URL',async()=>{
 const f=fixture();const a=await f.sut.createDocumentTransfer(f.input,'single')
 assert.deepEqual(a.uploadHeaders,{'x-amz-meta-transfer-id':id,'x-amz-meta-content-identity':identity})
 f.objects.set(a.storagePath,{size,metadata:{'transfer-id':id,'content-identity':identity}})
 const b=await f.sut.createDocumentTransfer(f.input,'single');assert.equal(b.completed,true);assert.equal(b.uploadUrl,undefined);assert.equal(a.storagePath,b.storagePath)
})
