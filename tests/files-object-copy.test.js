require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {S3Client}=require('@aws-sdk/client-s3')
const supabase=require('../lib/supabase/server')
const {copyFilesObject}=require('../lib/storage/files-storage')
function storage(t,handler,privacy={data:false,error:null}){
 const createServiceClient=supabase.createServiceSupabaseClient
 const privacyChecks=[]
 supabase.createServiceSupabaseClient=()=>({rpc:async(name,args)=>{privacyChecks.push({name,args});return privacy}})
 const send=S3Client.prototype.send;const keys=['R2_ENDPOINT','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY'];const prior=keys.map(key=>process.env[key])
 process.env.R2_ENDPOINT='https://storage.invalid';process.env.R2_ACCESS_KEY_ID='isolated-test';process.env.R2_SECRET_ACCESS_KEY='isolated-test'
 const calls=[];calls.privacyChecks=privacyChecks;S3Client.prototype.send=async function(command){calls.push(command);return handler(command)}
 t.after(()=>{supabase.createServiceSupabaseClient=createServiceClient;S3Client.prototype.send=send;keys.forEach((key,index)=>{if(prior[index]===undefined)delete process.env[key];else process.env[key]=prior[index]})})
 return calls
}
const input={orgId:'org',sourcePath:'org/library/plan with spaces.pdf',destinationPath:'org/projects/home/plans/version/attempt/plan.pdf',contentType:'application/pdf',expectedSize:100}
test('copy stays in storage, pins the source ETag and preserves private PDF metadata',async t=>{
 const calls=storage(t,command=>command.constructor.name==='HeadObjectCommand'?{ContentLength:100,ETag:'"source"',Metadata:{sha256:'evidence'}}:{CopyObjectResult:{ETag:'"copy"'}})
 const result=await copyFilesObject(input);assert.equal(result.size,100);assert.equal(result.sourceEtag,'"source"')
 assert.deepEqual(calls.map(call=>call.constructor.name),['HeadObjectCommand','CopyObjectCommand'])
 const command=calls[1].input;assert.match(command.CopySource,/plan%20with%20spaces.pdf$/);assert.equal(command.CopySourceIfMatch,'"source"');assert.equal(command.Metadata.sha256,'evidence');assert.equal(command.CacheControl,'private, max-age=3600');assert.equal(command.ContentType,'application/pdf')
 assert.ok(calls.privacyChecks.length>0)
 assert.ok(calls.privacyChecks.every(check=>check.name==='is_books_private_payroll_object'&&check.args.p_org_id==='org'&&[input.sourcePath,input.destinationPath].includes(check.args.p_path)))
})
test('copy rejects foreign or unsafe destinations and same-path overwrites before storage access',async t=>{
 const calls=storage(t,()=>{throw new Error('unexpected storage call')})
 for(const patch of [{sourcePath:'other/file.pdf'},{destinationPath:'other/file.pdf'},{destinationPath:'org/../other.pdf'},{destinationPath:input.sourcePath}])await assert.rejects(copyFilesObject({...input,...patch}),/organization|Invalid storage path|must differ/)
 assert.equal(calls.length,0)
})
test('changed size, missing version evidence and oversized sources never copy',async t=>{
 let head={ContentLength:101,ETag:'version'};const calls=storage(t,()=>head)
 await assert.rejects(copyFilesObject(input),/no longer matches/)
 head={ContentLength:100};await assert.rejects(copyFilesObject(input),/source version evidence/)
 head={ContentLength:5*1024*1024*1024+1,ETag:'version'};await assert.rejects(copyFilesObject(input),/single-object limit/)
 assert.equal(calls.filter(call=>call.constructor.name==='CopyObjectCommand').length,0)
})
test('source mutation refusal and missing copy completion evidence propagate',async t=>{
 let mutate=true;storage(t,command=>{if(command.constructor.name==='HeadObjectCommand')return {ContentLength:100,ETag:'source'};if(mutate)throw new Error('PreconditionFailed');return {}})
 await assert.rejects(copyFilesObject(input),/PreconditionFailed/);mutate=false;await assert.rejects(copyFilesObject(input),/completion evidence/)
})
test('native drawing source fallback copies only the resolved library key',async t=>{
 const calls=storage(t,command=>{if(command.constructor.name==='CopyObjectCommand')return {CopyObjectResult:{ETag:'copy'}};if(command.input.Key.startsWith('drawings-pdfs/'))throw Object.assign(new Error('NotFound'),{name:'NotFound'});return {ContentLength:100,ETag:'source'}})
 await copyFilesObject({...input,sourcePath:'org/home/drawings/uploads/plan.pdf'})
 assert.match(calls.at(-1).input.CopySource,/project-files\/org\/home\/drawings\/uploads\/plan.pdf$/)
})
test('a changed source ETag is refused before copying a persisted reservation',async t=>{
 const calls=storage(t,()=>({ContentLength:100,ETag:'new-version'}))
 await assert.rejects(copyFilesObject({...input,expectedSourceEtag:'reserved-version'}),/reserved copy/)
 assert.equal(calls.length,1);assert.equal(calls[0].constructor.name,'HeadObjectCommand')
})
test('ordinary copy refuses legacy payroll documents before any storage access',async t=>{
 const calls=storage(t,()=>{throw new Error('unexpected storage call')},{data:true,error:null})
 await assert.rejects(copyFilesObject(input),/Private payroll documents cannot be copied/)
 assert.equal(calls.length,0)
 assert.equal(calls.privacyChecks[0].args.p_path,input.sourcePath)
})
test('ordinary copy refuses unverifiable document privacy before storage access',async t=>{
 for(const privacy of [{data:null,error:{message:'RPC unavailable'}},{data:null,error:null}]){
  await t.test(privacy.error?'unavailable classification':'malformed classification',async t=>{
   const calls=storage(t,()=>{throw new Error('unexpected storage call')},privacy)
   await assert.rejects(copyFilesObject(input),/privacy could not be verified/)
   assert.equal(calls.length,0)
  })
 }
})
