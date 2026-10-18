const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript')
test('waiver chase queues a stable recipient reminder before sending and preserves retryability',async()=>{
 const source=fs.readFileSync('lib/services/payment-holds.ts','utf8'),start=source.indexOf('export async function sendVendorBillWaiverChase'),exports={},queued=[],sent=[],writes=[]
 const bill={id:'bill',project_id:'project',company_id:'company',company:{email:'vendor@example.test'},metadata:{}},waiver={id:'waiver',status:'sent',waiver_type:'conditional_progress',metadata:{document_id:'doc'}},request={id:'request',status:'sent',sent_to_email:'signer@example.test',sequence:1,envelope_id:'env'}
 const db={from(table){let patch;const q={select(){return q},eq(){return q},in(){return q},order(){return q},maybeSingle(){return q},update(p){patch=p;return q},then(resolve){if(patch)writes.push(patch);return Promise.resolve({data:table==='vendor_bills'?bill:table==='lien_waivers'?[waiver]:[request],error:null}).then(resolve)}};return q}}
 let fail=true
 vm.runInNewContext(ts.transpileModule(source.slice(start),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date,Error,Number,Math,createServiceSupabaseClient:()=>db,enqueueOutboxJob:async job=>{queued.push(job);return {enqueued:true}},deliverAutomaticSigningReminder:async input=>{sent.push(input);if(fail)throw Error('provider unavailable')},recordEvent:async()=>{}})
 await assert.rejects(exports.sendVendorBillWaiverChase('org','bill',{attempt:2}),/provider unavailable/)
 assert.equal(queued.length,1);assert.equal(writes.length,0)
 fail=false;await exports.sendVendorBillWaiverChase('org','bill',{attempt:2})
 assert.equal(queued[0].payload.delivery_key,queued[1].payload.delivery_key);assert.equal(sent[0].deliveryKey,sent[1].deliveryKey)
 assert.equal(queued[0].jobType,'send_esign_reminder');assert.equal(writes[0].metadata.waiver_chase.delivery,'sent')
})
