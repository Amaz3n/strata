require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module')
const {invoiceWaiverContentHash}=require('../lib/lien-waivers/invoice-content')
test('physical waiver action saves the authorized pending packet without sending or signing',async()=>{
 const invoice={id:'invoice',status:'draft',updated_at:'revision',metadata:{existing:'preserved'},total_cents:100}
 const waiver={id:'waiver',status:'pending_payment',metadata:{workflow:{version:2,lifecycle:'draft',invoice_content_hash:invoiceWaiverContentHash(invoice)}}}
 let writes=0,conflict=false
 const db={from(table){assert.equal(table,'invoices');let patch;const filters={};const q={update(value){patch=value;return q},eq(k,v){filters[k]=v;return q},select(){return q},maybeSingle(){assert.deepEqual(filters,{org_id:'org',id:'invoice',updated_at:'revision'});if(conflict)return Promise.resolve({data:null,error:null});writes++;Object.assign(invoice,patch);return Promise.resolve({data:{id:'invoice'},error:null})}};return q}}
 const ctx={supabase:db,orgId:'org',userId:'actor',invoice}
 const stubs={
  'next/cache':{revalidatePath(){}},
  '@/lib/services/invoice-waiver-workflow':{invoiceWaiverContext:async(id,permission)=>{assert.equal(permission,'invoice.send');return ctx},getInvoiceWaiverRecord:async()=>({waiver})},
  '@/lib/services/invoices':{getInvoiceWithLines:async()=>invoice,assertInvoiceCanIssue:async()=>{}},
 }
 const original=Module._load;Module._load=function(request,...args){return stubs[request]??original.call(this,request,...args)}
 try{
  const {holdInvoiceForPhysicalWaiverAction:save}=require('../app/(app)/invoices/physical-waiver-actions')
  assert.equal((await save('invoice','waiver',['invalid'])).success,false);assert.equal(writes,0)
  const result=await save('invoice','waiver',['client@example.test'])
  assert.equal(result.success,true);assert.equal(result.data.status,'draft');assert.equal(writes,1)
  assert.equal(invoice.metadata.existing,'preserved')
  assert.equal(invoice.metadata.waiver_packet.delivery_mode,'after_physical_execution')
  assert.deepEqual(invoice.metadata.waiver_packet.recipients,['client@example.test'])
  assert.equal(invoice.metadata.waiver_packet.actor_id,'actor')
  conflict=true;assert.equal((await save('invoice','waiver',['client@example.test'])).success,false)
 }finally{Module._load=original}
})
