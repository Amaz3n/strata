require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),{randomUUID}=require('node:crypto')
test('manual refunds authorize the original payment before the privileged transaction',async()=>{
  let allowed=false,divisionScope='all',provider='manual',calls=0,audits=0,duplicate=false
  const org=randomUUID(),payment=randomUUID(),invoice=randomUUID(),actor=randomUUID()
  const db={from(table){assert.equal(table,'payments');const filters={};const q={select(){return q},eq(k,v){filters[k]=v;return q},async maybeSingle(){assert.equal(filters.org_id,org);assert.equal(filters.id,payment);return {data:{id:payment,invoice_id:invoice,project_id:null,provider},error:null}}};return q}}
  const stubs={
    '@/lib/services/context':{requireOrgContext:async()=>({orgId:org,userId:actor,supabase:db})},
    '@/lib/services/authorization':{requireAuthorization:async input=>{assert.equal(input.permission,'payment.release');assert.equal(input.resourceId,payment);if(!allowed)throw Error('Denied');return {divisionScope}}},
    '@/lib/supabase/server':{createServiceSupabaseClient:()=>({rpc:async(name,input)=>{calls++;assert.equal(name,'record_manual_customer_refund_atomic');assert.equal(input.p_org_id,org);assert.equal(input.p_actor_id,actor);return {data:{id:'refund',duplicate},error:null}}})},
    '@/lib/services/audit':{recordAudit:async()=>{audits++}},
    '@/lib/services/events':{recordEvent:async()=>{}},
  }
  const original=Module._load;Module._load=function(request,...args){return stubs[request]??original.call(this,request,...args)}
  try{
    const {recordCustomerRefund}=require('../lib/services/customer-refunds')
    const input={paymentId:payment,amountCents:1000,reason:'Returned by check',idempotencyKey:randomUUID()}
    await assert.rejects(recordCustomerRefund(input),/Denied/);assert.equal(calls,0)
    allowed=true;divisionScope='assigned';await assert.rejects(recordCustomerRefund(input),/Organization-wide/);assert.equal(calls,0)
    divisionScope='all';provider='stripe';await assert.rejects(recordCustomerRefund(input),/payment provider/);assert.equal(calls,0)
    provider='manual';const result=await recordCustomerRefund(input);assert.equal(result.invoiceId,invoice);assert.equal(calls,1);assert.equal(audits,1)
    duplicate=true;await recordCustomerRefund(input);assert.equal(calls,2);assert.equal(audits,1)
    await assert.rejects(recordCustomerRefund({...input,amountCents:-1}));assert.equal(calls,2)
  }finally{Module._load=original}
})
