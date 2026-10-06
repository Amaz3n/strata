require('../scripts/register-ts-node-test')
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function service({reply=null,error=null}={}){
 const calls=[],compiled={exports:{}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/services/agreement-creation.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,require(name){
  if(name==='zod')return require(name)
  if(name==='@/lib/sales/agreement-quote')return require('../lib/sales/agreement-quote')
  if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>({rpc:async(name,input)=>{calls.push({name,input});return {data:reply,error}}})}
  return {}
 }})
 const request={reservationId:id(2),lotId:id(3),expectedQuoteHash:'a'.repeat(64),optionItems:[],incentiveIds:[],terms:null}
 const input={orgId:id(1),actorId:id(4),reservationId:id(2),request}
 return {api:compiled.exports,input,calls}
}
function receipt(){return {receipt_id:id(5),created:false,contract:{id:id(6),org_id:id(1),project_id:id(7),contract_type:'purchase_agreement',status:'draft',total_cents:100,snapshot:{purchase_agreement:{configuration:{lot_id:id(3)},pricing:{quoteHash:'a'.repeat(64),totalCents:100}}}}}}
test('receipt probe is read-only and session identity and reviewed inputs are forwarded unchanged',async()=>{
 const f=service();assert.equal(await f.api.saveAgreementCreation(f.input),null)
 assert.equal(f.calls[0].name,'create_purchase_agreement_atomic')
 assert.equal(f.calls[0].input.p_actor_id,id(4));assert.equal(f.calls[0].input.p_org_id,id(1));assert.equal(f.calls[0].input.p_reservation_id,id(2))
 assert.equal(f.calls[0].input.p_expected,null);assert.equal(f.calls[0].input.p_snapshot,null)
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].input.p_request)),f.input.request)
 await assert.rejects(f.api.saveAgreementCreation({...f.input,snapshot:{purchase_agreement:{}}}),/receipt is invalid/)
 assert.equal(f.calls.length,2,'failed commit never falls back to an alternate write')
})
test('failed, malformed, cross-organization and inconsistent quote/amount receipts cannot report success',async()=>{
 const bad=[null,{}, {...receipt(),receipt_id:'bad'}]
 for(const mutate of [r=>r.contract.org_id=id(99),r=>r.contract.snapshot.purchase_agreement.configuration.lot_id=id(99),r=>r.contract.snapshot.purchase_agreement.pricing.quoteHash='b'.repeat(64),r=>r.contract.total_cents=101,r=>r.contract.total_cents=1.5,r=>r.contract.contract_type='other']){const r=receipt();mutate(r);bad.push(r)}
 for(const reply of bad){const f=service({reply});await assert.rejects(f.api.saveAgreementCreation({...f.input,snapshot:{}}));assert.equal(f.calls.length,1)}
 const failed=service({error:{message:'Response lost'}});await assert.rejects(failed.api.saveAgreementCreation(failed.input),/could not be confirmed/)
 const valid=service({reply:receipt()});assert.equal((await valid.api.saveAgreementCreation(valid.input)).contract.id,id(6))
 await assert.rejects(valid.api.saveAgreementCreation({...valid.input,expected:{lot:{project_id:id(99)}}}),/receipt is invalid/)
})
test('transaction price changes propagate the actionable quote-review error',async()=>{
 const f=service({error:{message:'Community base price changed',details:'AGREEMENT_QUOTE_CHANGED'}})
 await assert.rejects(f.api.saveAgreementCreation(f.input),error=>error.code==='AGREEMENT_QUOTE_CHANGED')
 assert.equal(f.calls.length,1)
})
