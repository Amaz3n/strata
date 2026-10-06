require('../scripts/register-ts-node-test')
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function service({reply=null,error=null,freezeError=false}={}) {
 const captured={rpc:[],freezes:[]},compiled={exports:{}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/services/agreement-signing-ownership.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
 exports:compiled.exports,require(name){
 if(name==='zod')return require(name)
 if(name==='@/lib/sales/agreement-signing-source')return require('../lib/sales/agreement-signing-source')
 if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>({rpc:async(name,input)=>{captured.rpc.push({name,input});return {data:reply,error}}})}
 if(name==='@/lib/services/esign-execution')return {ensureFrozenSigningSource:async(...args)=>{captured.freezes.push(args);if(freezeError)throw new Error('Integrity failed');return {file_id:id(2),sha256:'a'.repeat(64),storage_path:'frozen.pdf',size_bytes:10}}}
 return {}
 }})
 const contract={id:id(1),org_id:id(3),project_id:id(4),title:'Agreement',number:'PA-1',terms:'Frozen terms',snapshot:{purchase_agreement:{pricing:{quoteHash:'reviewed'}}},total_cents:30000000,currency:'usd',effective_date:'2026-10-03',buyer_contact_id:id(5),co_buyer_contact_id:null}
 return {api:compiled.exports,captured,contract}
}
test('reservation forwards every frozen contract source field and permits only an empty probe',async()=>{
 const f=service();assert.equal(await f.api.reserveAgreementSigningDocument({orgId:id(3),actorId:id(6),contract:f.contract}),null)
 const call=f.captured.rpc[0]
 assert.equal(call.name,'reserve_purchase_agreement_document')
 assert.deepEqual(JSON.parse(JSON.stringify(call.input.p_expected)),f.contract)
 assert.equal(call.input.p_file_id,null)
 await assert.rejects(f.api.reserveAgreementSigningDocument({orgId:id(3),actorId:id(6),contract:f.contract,fileId:id(2)}),/reply is invalid/)
})
test('reservation validates durable identity and never accepts malformed or failed replies',async()=>{
 for(const options of [{reply:{id:'bad',source_file_id:id(2)}},{reply:{id:id(1)}},{error:{message:'Reply lost'}}]){
 const f=service(options);await assert.rejects(f.api.reserveAgreementSigningDocument({orgId:id(3),actorId:id(6),contract:f.contract}))
 assert.equal(f.captured.rpc.length,1)
 }
 const f=service({reply:{id:id(1),source_file_id:id(2)}})
 const owned=await f.api.reserveAgreementSigningDocument({orgId:id(3),actorId:id(6),contract:f.contract,fileId:id(2),recipients:[{email:'buyer@example.test'}]})
 assert.equal(owned.id,id(1));assert.equal(f.captured.rpc[0].input.p_recipients.length,1)
})
test('owned publication uses the persisted frozen source and requires a valid envelope receipt',async()=>{
 const f=service({reply:id(7)}),input={orgId:id(3),actorId:id(6),document:{id:id(1),source_file_id:id(2)}}
 const result=await f.api.publishOwnedAgreementDocument(input)
 assert.deepEqual(Array.from(f.captured.freezes[0]),[id(3),id(1)])
 assert.equal(f.captured.rpc[0].name,'publish_purchase_agreement_document')
 assert.equal(f.captured.rpc[0].input.p_source.sha256,'a'.repeat(64))
 assert.equal(result.envelopeId,id(7));assert.match(result.reason,/queued/)
 for(const options of [{reply:'invalid'},{error:{message:'Timeout'}},{freezeError:true}]){
  const bad=service(options);await assert.rejects(bad.api.publishOwnedAgreementDocument(input))
  assert.equal(bad.captured.rpc.length,options.freezeError?0:1)
 }
})
