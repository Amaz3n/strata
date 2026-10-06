const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
function fixture(transfer,object){
 const query={select(){return this},eq(){return this},maybeSingle:async()=>({data:transfer})}
 const mocks={
  '@/lib/supabase/server':{createServiceSupabaseClient:()=>({from:()=>query})},
  '@/lib/storage/files-storage':{headFilesObject:async()=>object},
 }
 const code=ts.transpileModule(fs.readFileSync('lib/services/document-upload-object.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 const mod={exports:{}};Function('require','module','exports',code)(id=>mocks[id],mod,mod.exports)
 return mod.exports.assertDocumentUploadObject
}
const input={orgId:'org',userId:'actor',projectId:'project',storagePath:'org/object',fileName:'plan.pdf',mimeType:'application/pdf',sizeBytes:10}
const transfer={id:'transfer',created_by:'actor',project_id:'project',file_name:'plan.pdf',content_type:'application/pdf',file_size:10,identity:'content',cancelled_at:null}
const object={size:10,metadata:{'transfer-id':'transfer','content-identity':'content'}}
test('matching reservation and object proof finalize',()=>fixture(transfer,object)(input))
test('legacy finalization still verifies actual byte length',async()=>{
 await fixture(null,object)(input)
 await assert.rejects(fixture(null,{...object,size:9})(input),/size/)
})
test('another actor, cancelled reservation and changed intent are rejected',async()=>{
 for(const changed of [{created_by:'other'},{cancelled_at:'now'},{file_size:11},{project_id:'other'},{file_name:'other.pdf'}]){
  await assert.rejects(fixture({...transfer,...changed},object)(input),/reservation/)
 }
})
test('equal-sized object must still prove the reserved transfer identity',async()=>{
 await assert.rejects(fixture(transfer,{size:10,metadata:{'transfer-id':'other','content-identity':'content'}})(input),/reservation/)
})

test('direct versions require a reservation even for an existing object',async()=>{
 await assert.rejects(fixture(null,object)({...input,requireReservation:true}),/reservation/)
})
