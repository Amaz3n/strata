const test=require('node:test'),assert=require('node:assert/strict')
const {stubModule,freshRequire}=require('./support/modules')

test('customer account combines project and general billing without treating credits as cash',async()=>{
  const invoices=[
    {id:'job-invoice',project_id:'job',status:'partial',total_cents:10000,balance_due_cents:3000,metadata:{customer_id:'different'},issue_date:'2026-01-01'},
    {id:'general-invoice',status:'partial',total_cents:5000,balance_due_cents:2000,metadata:{customer_id:'client'},issue_date:'2026-01-02'},
    {id:'other-general',status:'sent',total_cents:9000,balance_due_cents:9000,metadata:{customer_id:'different'},issue_date:'2026-01-02'},
  ]
  const payments=[{id:'p1',invoice_id:'job-invoice',amount_cents:6000,status:'succeeded',received_at:'2026-01-03',payment_reversals:[]},{id:'p2',invoice_id:'general-invoice',amount_cents:4000,status:'succeeded',received_at:'2026-01-03',payment_reversals:[{id:'r2',amount_cents:1000,status:'succeeded',created_at:'2026-01-04',reversal_type:'refund'}]}]
  const db={from(table){const q={select(){return q},eq(){return q},in(){return q},maybeSingle(){return q},then(resolve){return Promise.resolve({data:table==='contacts'?{id:'client'}:table==='payments'?payments:table==='receivable_adjustments'?[{id:'c1',invoice_id:'job-invoice',adjustment_type:'credit_memo',status:'posted',amount_cents:1000,effective_date:'2026-01-03',reason:'Discount'}]:[],error:null}).then(resolve)}};return q}}
  const stubs={
    '@/lib/services/context':{requireOrgContext:async()=>({orgId:'org',userId:'user',supabase:db})},
    '@/lib/services/authorization':{authorize:async()=>({allowed:false})},
    '@/lib/services/permissions':{requireAnyPermission:async()=>{}},
    '@/lib/services/projects':{listProjects:async()=>[{id:'job',name:'Job',client_id:'client',total_contract_value_cents:10000}]},
    '@/lib/services/invoices':{listInvoicePage:async options=>({hasMore:false,invoices:options.projectId?invoices.filter(i=>i.project_id===options.projectId):invoices.filter(i=>!i.project_id&&options.generalCustomerIds.includes(i.metadata.customer_id))})},
    '@/lib/supabase/server':{createServiceSupabaseClient:()=>db},
  }
  for(const [request,exports] of Object.entries(stubs)) stubModule(request,exports)
  {
    const {getFinancialPartyReceivables}=freshRequire('lib/services/financial-parties.ts')
    const summary=await getFinancialPartyReceivables({partyType:'contact',partyId:'client'})
    assert.equal(summary.invoiced_cents,15000)
    assert.equal(summary.collected_cents,9000)
    assert.equal(summary.outstanding_cents,5000)
    assert.equal(summary.invoice_count,2)
    assert.equal(summary.projects[0].collected_cents,6000)
    const general=summary.activity.find(row=>row.id==='invoice:general-invoice')
    assert.equal(general.project_id,null);assert.equal(general.source_href,'/billing?invoice=general-invoice')
    assert.equal(summary.activity.find(row=>row.id==='reversal:r2').amount_cents,-1000)
    assert.ok(!summary.activity.some(row=>row.invoice_id==='other-general'))
    invoices.push({id:'advance',status:'paid',total_cents:5000,balance_due_cents:0,metadata:{customer_id:'client',invoice_kind:'earnest_deposit'},issue_date:'2026-01-04'})
    payments.push({id:'advance-payment',invoice_id:'advance',amount_cents:5000,status:'succeeded',received_at:'2026-01-04',metadata:{},payment_reversals:[]})
    payments.push({id:'application',invoice_id:'job-invoice',amount_cents:2000,status:'succeeded',received_at:'2026-01-04',metadata:{customer_deposit_application:true,deposit_payment_id:'advance-payment'},payment_reversals:[]})
    invoices[0].balance_due_cents=1000
    const withDeposit=await getFinancialPartyReceivables({partyType:'contact',partyId:'client'})
    assert.equal(withDeposit.invoiced_cents,15000,'a deposit request is not invoice revenue')
    assert.equal(withDeposit.collected_cents,14000,'applying a deposit does not collect the cash twice')
    assert.equal(withDeposit.available_deposit_cents,3000)
    assert.equal(withDeposit.invoice_count,2)
    assert.equal(withDeposit.outstanding_cents,3000,'a deposit request is not a receivable')
    assert.equal(withDeposit.activity.find(row=>row.id==='invoice:advance').kind,'deposit_request')
  }
})
