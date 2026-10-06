require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { invoiceWaiverContentHash } = require('../lib/lien-waivers/invoice-content')

test('separate delivery requires a current waiver and the exact signer envelope', async () => {
  const original = Module._load
  Module._load = function(request,...args){if(request==='@/lib/services/invoice-waiver-workflow')return {};return original.call(this,request,...args)}
  try {
    const { assertInvoiceWaiverPacketReady } = require('../lib/services/invoice-waiver-packet')
    const invoice = { id:'invoice',total_cents:10000,metadata:{waiver_packet:{enabled:true,waiver_id:'waiver',delivery_mode:'separate_signature',signer_id:'signer',envelope_id:'envelope'}} }
    const flow = {version:2,lifecycle:'draft',signing_document_id:'document',invoice_content_hash:invoiceWaiverContentHash(invoice)}
    const waiver = {id:'waiver',amount_cents:10000,metadata:{workflow:flow}}
    let signer='signer', status='sent'
    const db = {from(table){const filters={};const q={select(){return q},eq(k,v){filters[k]=v;return q},neq(){return q},maybeSingle(){return q},then(resolve){assert.equal(filters.org_id,'org');if(table==='envelopes'){assert.equal(filters.id,'envelope');assert.equal(filters.document_id,'document')};return Promise.resolve({data:table==='invoice_lien_waivers'?[waiver]:table==='documents'?{metadata:{waiver_signer_id:signer}}:{id:'envelope',status},error:null}).then(resolve)}};return q}}
    await assertInvoiceWaiverPacketReady(db,'org',invoice)
    signer='other';await assert.rejects(assertInvoiceWaiverPacketReady(db,'org',invoice),/selected signer/)
    signer='signer';status='draft';await assert.rejects(assertInvoiceWaiverPacketReady(db,'org',invoice),/selected signer/)
    status='executed';await assertInvoiceWaiverPacketReady(db,'org',invoice)
    flow.invoice_content_hash='stale';await assert.rejects(assertInvoiceWaiverPacketReady(db,'org',invoice),/waiver changed/)
  } finally {Module._load=original}
})

test('final review requests the signature without issuing the customer invoice and resumes without another email', async () => {
  let allow=false, sends=0, issues=0, status='draft', failInvoice=true, metadata={}
  const invoice={id:'invoice',status:'draft',approval_status:'not_required',updated_at:'revision',metadata:{},total_cents:10000}
  const waiver={id:'waiver',metadata:{workflow:{version:2,lifecycle:'draft',input:{signer_name:'Sam'}}}}
  const db={from(table){let patch;const q={select(){return q},eq(){return q},in(){return q},order(){return q},limit(){return q},single(){return q},maybeSingle(){return q},update(value){patch=value;return q},then(resolve){if(patch){if(table==='invoices')invoice.metadata=patch.metadata;else if(table==='invoice_lien_waivers')waiver.metadata=patch.metadata;else metadata=patch.metadata};return Promise.resolve({data:table==='envelopes'?{id:'envelope'}:patch?{id:'row'}:{metadata},error:null}).then(resolve)}};return q}}
  const ctx={supabase:db,orgId:'org',userId:'creator',invoice}
  const stubs={
    'next/cache':{revalidatePath(){}},
    '@/lib/services/invoice-waiver-workflow':{
      invoiceWaiverContext:async(_id,permission)=>{assert.equal(permission,'invoice.send');if(!allow)throw Error('Denied');return ctx},
      getInvoiceWaiverRecord:async()=>({ctx,waiver}),
      startInvoiceWaiverSigning:async()=>({documentId:'document',status,waiver}),
    },
    '@/lib/services/waiver-signers':{listWaiverSigners:async()=>[{id:'signer',name:'Sam',email:'sam@example.test'}]},
    '@/app/(app)/signatures/actions':{sendDocumentEnvelopeAction:async()=>{sends++;status='sent';return {success:true,data:{envelopeId:'envelope'}}}},
    '@/lib/services/invoices':{assertInvoiceCanIssue:async()=>{},getInvoiceWithLines:async()=>invoice,issueInvoice:async({recipients})=>{issues++;assert.deepEqual(recipients,['customer@example.test']);assert.equal(invoice.metadata.waiver_packet.delivery_mode,'separate_signature');assert.equal(waiver.metadata.workflow.shared,false);assert.equal(waiver.metadata.workflow.sharing_requested,false);if(failInvoice)throw Error('Delivery unavailable');return invoice}},
  }
  const original=Module._load
  Module._load=function(request,...args){return stubs[request]??original.call(this,request,...args)}
  try {
    const {sendInvoiceWithWaiverRequestAction:send}=require('../app/(app)/invoices/waiver-actions')
    assert.equal((await send('invoice','waiver','signer',['customer@example.test'])).success,false)
    assert.equal(sends,0)
    allow=true
    assert.equal((await send('invoice','waiver','signer',['invalid'])).success,false)
    assert.equal(sends,0)
    assert.equal((await send('invoice','waiver','creator',['customer@example.test'])).success,false)
    assert.equal(sends,0)
    const result=await send('invoice','waiver','signer',['customer@example.test'])
    assert.equal(result.success,true,result.error);assert.equal(sends,1);assert.equal(issues,0)
    assert.equal(invoice.metadata.waiver_packet.delivery_mode,'after_signature')
    assert.equal(invoice.metadata.waiver_packet.actor_id,'creator')
    assert.deepEqual(invoice.metadata.waiver_packet.recipients,['customer@example.test'])
    assert.equal((await send('invoice','waiver','signer',['customer@example.test'])).success,true)
    assert.equal(sends,1);assert.equal(issues,0)
  }finally{Module._load=original}
})
