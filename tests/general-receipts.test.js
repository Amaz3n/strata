require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),{randomUUID}=require('node:crypto')
test('receipts include general invoices and enforce one customer and per-invoice permission',async()=>{
  const org=randomUUID(),actor=randomUUID(),client=randomUUID(),other=randomUUID(),project=randomUUID()
  const general={id:randomUUID(),project_id:null,status:'sent',balance_due_cents:10000,metadata:{customer_id:client,customer_name:'Customer One'}}
  const job={id:randomUUID(),project_id:project,status:'sent',balance_due_cents:10000,metadata:{customer_name:'Bill-to label'},project:{id:project,name:'Job',client_id:client,client:{full_name:'Customer One'}}}
  const foreign={id:randomUUID(),project_id:null,status:'sent',balance_due_cents:10000,metadata:{customer_id:other,customer_name:'Other'}}
  const rows=[general,job,foreign];let rpcCalls=0,denyInvoice=null
  const db={from(table){const filters={};const q={select(columns){if(table==='invoices'){assert.ok(!columns.includes('projects!inner'));assert.ok(!columns.includes(', customer_name,'))};return q},eq(k,v){filters[k]=v;return q},in(k,v){filters[k]=v;return q},gt(){return q},order(){return q},limit(){return q},then(resolve){assert.equal(filters.org_id,org);return Promise.resolve({data:table==='invoices'?rows.filter(row=>!filters.id||filters.id.includes(row.id)):[],error:null}).then(resolve)}};return q},async rpc(name){rpcCalls++;assert.equal(name,'apply_multi_invoice_payment_atomic');return {data:{group:{id:randomUUID(),total_cents:200},items:[],duplicate:true},error:null}}}
  const stubs={
    '@/lib/services/context':{requireOrgContext:async()=>({orgId:org,userId:actor,supabase:db})},
    '@/lib/services/authorization':{requireAuthorization:async input=>{if(input.resourceId===denyInvoice)throw Error('Denied invoice');return {divisionScope:'all'}}},
    '@/lib/supabase/server':{createServiceSupabaseClient:()=>db},
    '@/lib/services/financial-parties':{getFinancialPartyReceivables:async()=>({projects:[{project_id:project}],included_contact_ids:[client]})},
  }
  const original=Module._load;Module._load=function(request,...args){if(stubs[request])return stubs[request];if(request.startsWith('@/lib/services/')||request.startsWith('@/lib/integrations/payments/')||request==='@/lib/payments/fee-engine')return {};return original.call(this,request,...args)}
  try{
    const {getReceivePaymentWorkspace,recordMultiInvoicePayment}=require('../lib/services/payments')
    const workspace=await getReceivePaymentWorkspace({partyType:'contact',partyId:client})
    assert.deepEqual(workspace.invoices.map(i=>i.id),[general.id,job.id]);assert.equal(workspace.invoices[0].projectId,null);assert.equal(workspace.invoices[0].projectName,'General billing')
    assert.equal(workspace.invoices[0].customerKey,workspace.invoices[1].customerKey)
    assert.equal(workspace.invoices[1].customerName,'Customer One')
    const input={received_at:new Date().toISOString(),method:'check',idempotency_key:randomUUID(),allocations:[general,job].map(i=>({invoice_id:i.id,amount_cents:100}))}
    await recordMultiInvoicePayment(input);assert.equal(rpcCalls,1)
    await assert.rejects(recordMultiInvoicePayment({...input,allocations:[general,foreign].map(i=>({invoice_id:i.id,amount_cents:100}))}),/separate receipt/);assert.equal(rpcCalls,1)
    await assert.rejects(recordMultiInvoicePayment({...input,party_type:'contact',party_id:client,allocations:[{invoice_id:foreign.id,amount_cents:100}]}),/does not belong/);assert.equal(rpcCalls,1)
    denyInvoice=general.id;await assert.rejects(recordMultiInvoicePayment(input),/Denied invoice/);assert.equal(rpcCalls,1)
  }finally{Module._load=original}
})
