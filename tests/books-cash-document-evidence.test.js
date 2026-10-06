require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {cashIncomeBasisFromInvoiceFact:basis}=require('../lib/services/books/cash-document-evidence')
const {draftFromFact,preserveLegacyInvoiceIncomePayload:preserve,hashableFactPayload}=require('../lib/services/books/fact-drafts')
const {booksDigest}=require('../lib/services/books/hash')
const {allocateCashDocumentSettlements:report}=require('../lib/services/books/cash-settlement-rules')
const {invoiceHasAccountingPrincipal}=require('../lib/services/books/invoice-revenue-rules')
const payload={total_cents:9700,retainage_cents:1000,tax_cents:700,revenue_basis:'percentage_of_completion',revenue_lines:[{account_code:'4010',amount_cents:8000},{account_code:'4020',amount_cents:2000}]}
const fact={id:'frozen-fact',sourceId:'invoice',accountingDate:'2026-09-01',payload}
test('frozen POC income components support cash income while accrual billing stays deferred',()=>{
 const document=basis(fact,true)
 assert.equal(document.grossCents,10700)
 const result=report({startDate:'2026-09-01',endDate:'2026-09-30',documents:[document],settlements:[{eventId:'receipt',documentId:'invoice',snapshotId:'frozen-fact',settledOn:'2026-09-20',appliedCents:10700}]})
 assert.equal(result.incomeCents,10000);assert.equal(result.salesTaxCents,700)
 const draft=draftFromFact({sourceType:'invoice',sourceId:'invoice',accountingDate:fact.accountingDate,sourceVersion:1,projectionVersion:1,policyVersion:1,payload})
 assert.equal(draft.lines.some(line=>line.accountCode==='4010'),false)
 assert.equal(draft.lines.find(line=>line.accountCode==='2350').creditCents,10000)
 assert.equal(document.snapshotId,fact.id)
 assert.equal(basis(fact).completeSettlementHistory,false)
 const scoped=basis({...fact,payload:{...payload,project_id:'job',project_dimensions:{job:{division_id:'division'}},revenue_lines:payload.revenue_lines.map((row,i)=>({...row,dimensions:{cost_code_id:`cost-${i}`}}))}},true)
 const scopedReport=report({startDate:'2026-09-01',endDate:'2026-09-30',documents:[scoped],settlements:[{eventId:'scoped-receipt',documentId:'invoice',snapshotId:'frozen-fact',settledOn:'2026-09-20',appliedCents:10700}]})
 assert.deepEqual(scopedReport.rows.find(row=>row.accountCode==='4010').dimensions,{project_id:'job',division_id:'division',cost_code_id:'cost-0'})
 assert.deepEqual(scopedReport.rows.find(row=>row.kind==='sales_tax').dimensions,{project_id:'job',division_id:'division'})
})
test('legacy invoice facts retain history rather than claiming today’s account as original evidence',()=>{
 const legacy={...payload};delete legacy.revenue_lines
 for(const payload_hash of [booksDigest(hashableFactPayload('invoice',legacy)),booksDigest({accountingDate:fact.accountingDate,payload:hashableFactPayload('invoice',legacy)})]){
  const previous={accounting_date:fact.accountingDate,payload_hash,payload:legacy}
  assert.equal(preserve('invoice',fact.accountingDate,payload,previous),legacy)
  assert.throws(()=>basis({...fact,payload:legacy}),/reviewed historical/)
  assert.deepEqual(preserve('invoice',fact.accountingDate,{...payload,total_cents:9800},previous).revenue_lines,payload.revenue_lines)
 }
 const previous={accounting_date:fact.accountingDate,payload_hash:booksDigest(hashableFactPayload('invoice',payload)),payload}
 assert.notEqual(booksDigest(hashableFactPayload('invoice',{...payload,revenue_lines:[{account_code:'4030',amount_cents:10000}]})),previous.payload_hash)
})
test('cash document evidence rejects mismatched cents and recognizes explicit captured default accounts',()=>{
 assert.throws(()=>basis({...fact,payload:{...payload,total_cents:9701}}),/equal.*gross/)
 const defaultBasis=basis({...fact,payload:{...payload,revenue_lines:[]}},true)
 assert.equal(defaultBasis.components[0].accountCode,'4000')
 const ordinary=basis({...fact,payload:{...payload,total_cents:10700,retainage_cents:0,revenue_basis:'on_invoice'}},true)
 assert.equal(ordinary.grossCents,10700)
 const fullyRetained=basis({...fact,payload:{...payload,total_cents:0,tax_cents:0,retainage_cents:10000}},true)
 assert.equal(fullyRetained.grossCents,10000)
 assert.equal(report({startDate:'2026-09-01',endDate:'2026-09-30',documents:[fullyRetained],settlements:[]}).incomeCents,0)
 assert.equal(invoiceHasAccountingPrincipal(0,10000,'percentage_of_completion'),true)
 assert.equal(invoiceHasAccountingPrincipal(0,0,'percentage_of_completion'),false)
 const heldDraft=draftFromFact({sourceType:'invoice',sourceId:'invoice',accountingDate:fact.accountingDate,sourceVersion:1,projectionVersion:1,policyVersion:1,payload:{...payload,total_cents:0,tax_cents:0,retainage_cents:10000}})
 assert.deepEqual(heldDraft.lines.map(line=>[line.accountCode,line.debitCents,line.creditCents]),[['1110',10000,0],['2350',0,10000]])
})

test('invoice evidence loader batches scoped snapshots without truncating lines or reading a live chart separately',async()=>{
 const Module=require('node:module'),original=Module._load
 const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
 const requests=[];let missing=false,foreign=false
 const service={from(){throw new Error('Independent live reads would break the snapshot')},async rpc(name,args){
  assert.equal(name,'books_invoice_income_evidence');assert.equal(args.p_org_id,id(9000));assert.ok(args.p_invoice_ids.length<=200);requests.push(args)
  return {error:null,data:args.p_invoice_ids.filter((_,i)=>!missing||i>0).map(invoice=>({id:invoice,updated_at:'2026-09-01T12:00:00.000001+00:00',lines:Array.from({length:invoice===id(1)?1001:1},(_,i)=>({id:id(10000+i),quantity:'1',unit_price_cents:1,cost_code_id:null,metadata:{arc_books_gl_account_id:id(9001)},selected_account:foreign?null:{id:id(9001),code:'4010',account_type:'income',active:true}}))}))}
 }}
 let load
 try{Module._load=function(name,...args){if(name==='server-only')return {};if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>service};return original.call(this,name,...args)};load=require('../lib/services/books/invoice-revenue').loadInvoiceRevenueLines}finally{Module._load=original}
 const result=await load(id(9000),Array.from({length:201},(_,i)=>id(i+1)))
 assert.equal(requests.length,2);assert.equal(result.lines.size,201);assert.equal(result.lines.get(id(1)).length,1001)
 assert.equal(result.sourceVersions.get(id(1)),'2026-09-01T12:00:00.000001+00:00')
 foreign=true;assert.match((await load(id(9000),[id(1)])).errors.get(id(1)),/organization/)
 missing=true;assert.match((await load(id(9000),[id(1)])).errors.get(id(1)),/missing/)
})
