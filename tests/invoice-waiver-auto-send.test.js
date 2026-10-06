require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module')
test('signed packet automatically issues for its original actor; unsigned, cancelled, changed, or already sent packets do not',async()=>{
 const invoice={id:'inv',status:'draft',metadata:{waiver_packet:{enabled:true,delivery_mode:'after_signature',waiver_id:'waiver',signer_id:'sam',actor_id:'preparer',recipients:['client@example.test']}}}
 const flow={version:2,lifecycle:'draft',signing_document_id:'doc',shared:true}
 let issued=0,assigned='sam',physicalExecution=null
 const db={from(table){const filters={};const q={select(){return q},eq(k,v){filters[k]=v;return q},single(){return q},then(resolve){if(table!=='orgs')assert.equal(filters.org_id,'org');const data=table==='invoices'?invoice:table==='invoice_lien_waivers'?{metadata:{workflow:flow,physical_execution:physicalExecution}}:table==='documents'?{metadata:{waiver_signer_id:assigned}}:{product_tier:'residential'};return Promise.resolve({data,error:null}).then(resolve)}};return q}}
 const original=Module._load;Module._load=function(request,...args){if(request==='@/lib/services/invoices')return{issueInvoiceWithContext:async(ctx,args)=>{issued++;assert.equal(ctx.userId,'preparer');assert.deepEqual(args.recipients,['client@example.test']);invoice.status='sent'}};return original.call(this,request,...args)}
 try{
 const {sendInvoiceAfterWaiverSignature:send}=require('../lib/services/invoice-waiver-auto-send')
 await send(db,'org','inv','waiver');assert.equal(issued,0)
 flow.lifecycle='signed';flow.needs_review=true;await send(db,'org','inv','waiver');assert.equal(issued,0)
 flow.needs_review=false;invoice.metadata.waiver_packet.enabled=false;await send(db,'org','inv','waiver');assert.equal(issued,0)
 invoice.metadata.waiver_packet.enabled=true;assigned='other';await assert.rejects(send(db,'org','inv','waiver'),/needs review/);assert.equal(issued,0)
 assigned='sam';await send(db,'org','inv','waiver');assert.equal(issued,1)
 await send(db,'org','inv','waiver');assert.equal(issued,1)
 invoice.status='draft';invoice.metadata.waiver_packet.delivery_mode='after_physical_execution';delete flow.signing_document_id
 await assert.rejects(send(db,'org','inv','waiver'),/Confirm the executed waiver/)
 physicalExecution={confirmed_by:'uploader'}
 await send(db,'org','inv','waiver');assert.equal(issued,2)
 await send(db,'org','inv','waiver');assert.equal(issued,2)
 }finally{Module._load=original}
})
