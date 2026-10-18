const test=require('node:test')
const assert=require('node:assert/strict')
const {File}=require('node:buffer')
const {loadHandler}=require('./fixtures/drawing-lifecycle/harness.cjs')
function fixture(t){
 const before=global.localStorage;const saved=new Map();global.localStorage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};t.after(()=>{global.localStorage=before})
 let complete=false,putCalls=0,finalizeCalls=0,finalizeFails=false,putFails=false
 const client=loadHandler('lib/services/files-client.ts',{
  '@/app/(app)/documents/actions':{finalizeUploadedFileAction:async input=>{finalizeCalls++;assert.equal(input.transferId,undefined);if(finalizeFails){finalizeFails=false;return {success:false,error:'lost metadata response'}}return {success:true,data:{id:'file',storage_path:input.storagePath}}}},
  '@/lib/action-result':{unwrapAction:r=>{if(!r.success)throw Error(r.error);return r.data}},
  '@/lib/files/upload-fingerprint':{hashDocumentUpload:async()=>({checksum:'a'.repeat(64),fingerprint:'sha256-chain-v1:4:'+ 'b'.repeat(64)})},
  '@/lib/files/content-policy':{validateDocumentUpload:()=>{}},
  '@/lib/services/multipart-upload-client':{
   MULTIPART_THRESHOLD:32*1024*1024,clearMultipartResumeState:k=>saved.delete(k),
   uploadControlRequest:async(url)=>url.endsWith('upload-url')?{storagePath:'org/project/documents/uploads/reserved',uploadUrl:complete?undefined:'signed',completed:complete}:{state:complete?'completed':'uploading'},
   uploadBlobWithProgress:async(_url,_file,_type,_progress,options)=>{assert.equal(options.headers['If-None-Match'],'*');putCalls++;complete=true;if(putFails)throw Error('Upload failed with status 412')},
  }
 })
 return {client,saved,file:new File(['test'],'x.pdf',{type:'application/pdf'}),options:{projectId:'project',transferId:'stable'},loseMetadata:()=>{finalizeFails=true},losePut:()=>{putFails=true},puts:()=>putCalls,finalizations:()=>finalizeCalls}
}
test('failed metadata finalization retains the completed transfer; retry finalizes without another PUT',async t=>{
 const f=fixture(t);f.loseMetadata();await assert.rejects(f.client.uploadDocumentFileDirect(f.file,f.options));assert.equal(f.saved.size,1)
 const result=await f.client.uploadDocumentFileDirect(f.file,f.options);assert.equal(result.id,'file');assert.equal(f.puts(),1);assert.equal(f.finalizations(),2);assert.equal(f.saved.size,0)
})
test('conditional PUT conflict or lost success response reconciles storage before finalization',async t=>{
 const f=fixture(t);f.losePut();const result=await f.client.uploadDocumentFileDirect(f.file,f.options);assert.equal(result.id,'file');assert.equal(f.puts(),1);assert.equal(f.finalizations(),1)
})
