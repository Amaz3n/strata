require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {cashBillCostsFromSnapshot:build}=require('../lib/services/books/cash-cost-snapshot')
const {directSettlementEvidence}=require('../lib/services/books/settlement-evidence')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,org=id(1),bill=id(2),payment=id(3),revision='2026-09-20T12:00:00.000001+00:00'
function fixture(){
 const tables=Object.fromEntries(['journal_entries','journal_lines','accounting_facts','vendor_bills','payments','payment_allocations','payment_reversals','books_projection_receipts'].map(name=>[name,[]]))
 tables.vendor_bills=[{id:bill,updated_at:revision}]
 tables.payments=[{id:payment,bill_id:bill,amount_cents:5000,status:'paid',received_at:revision,updated_at:revision}]
 tables.accounting_facts=[{id:id(4),source_type:'vendor_bill',source_id:bill,accounting_date:'2026-09-01',payload:{total_cents:10000}},{id:id(5),source_type:'bill_payment',source_id:payment,accounting_date:'2026-09-20',payload:{amount_cents:5000,settlement_evidence:directSettlementEvidence({paymentId:payment,billId:bill})}}]
 tables.journal_entries=[{id:id(6),fact_id:id(4),source_type:'vendor_bill',source_id:bill,status:'posted',entry_date:'2026-09-01',reversal_of_entry_id:null},{id:id(7),fact_id:id(5),source_type:'bill_payment',source_id:payment,status:'posted',entry_date:'2026-09-20',reversal_of_entry_id:null}]
 const line=(entry,n,code,type,subtype,debit,credit=0)=>({entry_id:id(entry),line_no:n,account_id:id(100+Number(code)),debit_cents:debit,credit_cents:credit,project_id:id(90),dimensions:{cost_code_id:id(91),books_account_classification:{version:1,account_id:id(100+Number(code)),code,account_type:type,subtype,normal_balance:['asset','cogs','expense'].includes(type)?'debit':'credit'}}})
 tables.journal_lines=[line(6,1,'5000','cogs','job_costs',6000),line(6,2,'6000','expense','rent',3000),line(6,3,'1500','asset','fixed_assets',1000),line(6,4,'2000','liability','accounts_payable',0,10000),line(7,1,'2000','liability','accounts_payable',5000),line(7,2,'1000','asset','cash',0,5000)]
 tables.books_projection_receipts=[{source_type:'bill_payment',source_id:payment,source_observed_at:revision,journal_id:id(7),fact_id:id(5)},{source_type:'vendor_bill',source_id:bill,source_observed_at:revision,journal_id:id(6),fact_id:id(4)}]
 for(const rows of Object.values(tables))for(const row of rows)row.org_id=org
 return {orgId:org,capturedAt:revision,databaseSnapshot:'single-mvcc',tables}
}
const run=(snapshot,start='2026-09-01',end='2026-09-30')=>build(org,start,end,snapshot)
function withRefund(){
 const snapshot=fixture(),tables=snapshot.tables
 tables.payment_reversals.push({id:id(20),org_id:org,payment_id:payment,bill_id:bill,amount_cents:1000,status:'succeeded',occurred_at:'2026-10-10T12:00:00Z',updated_at:revision})
 tables.accounting_facts.push({id:id(21),org_id:org,source_type:'payment_reversal',source_id:id(20),accounting_date:'2026-10-10',payload:{side:'bill_payment',amount_cents:1000,settlement_evidence:directSettlementEvidence({paymentId:payment,billId:bill})}})
 tables.journal_entries.push({id:id(22),org_id:org,fact_id:id(21),source_type:'payment_reversal',source_id:id(20),status:'posted',entry_date:'2026-10-10',reversal_of_entry_id:null})
 tables.journal_lines.push({...structuredClone(tables.journal_lines[4]),entry_id:id(22),debit_cents:0,credit_cents:1000},{...structuredClone(tables.journal_lines[5]),entry_id:id(22),debit_cents:1000,credit_cents:0})
 tables.books_projection_receipts.push({org_id:org,source_type:'payment_reversal',source_id:id(20),source_observed_at:revision,journal_id:id(22),fact_id:id(21)})
 return snapshot
}
test('reconciled paid-bill snapshot retains frozen COGS, overhead, capitalization and source provenance',()=>{
 const result=run(fixture());assert.equal(result.cogsCents,3000);assert.equal(result.expenseCents,1500);assert.equal(result.capitalizedCents,500)
 assert.equal(result.databaseSnapshot,'single-mvcc');assert.equal(result.rows[0].dimensions.cost_code_id,id(91))
 assert.equal(result.settlementEvidence[0].paymentId,payment)
})
test('omitted journals or payments and stale bill or payment receipts block incomplete paid costs',()=>{
 const missing=fixture();missing.tables.journal_entries.pop();assert.throws(()=>run(missing),/does not reconcile/)
 const omitted=fixture();omitted.tables.payments.push({...omitted.tables.payments[0],id:id(99)});assert.throws(()=>run(omitted),/does not reconcile/)
 const orphan=fixture();orphan.tables.payments=[];assert.throws(()=>run(orphan),/operational supplier payment/)
 const stale=fixture();stale.tables.payments[0].updated_at='2026-09-20T12:00:00.000002+00:00';assert.throws(()=>run(stale),/Refresh/)
 const staleBill=fixture();staleBill.tables.vendor_bills[0].updated_at='2026-09-20T12:00:00.000002+00:00';assert.throws(()=>run(staleBill),/Refresh/)
})
test('same payment total attributed to the wrong operational bill is rejected',()=>{
 const snapshot=fixture();snapshot.tables.vendor_bills.push({...snapshot.tables.vendor_bills[0],id:id(99)});snapshot.tables.payments[0].bill_id=id(99)
 assert.throws(()=>run(snapshot),/bill ownership does not reconcile/)
 const allocation=fixture();allocation.tables.payments[0].bill_id=null;allocation.tables.payment_allocations.push({id:id(98),org_id:org,payment_id:payment,bill_id:bill,amount_cents:4999})
 assert.throws(()=>run(allocation),/allocations do not match/)
})
test('supplier refunds reconcile per bill at their actual cutoff and preserve monthly totals',()=>{
 const snapshot=withRefund(),september=run(snapshot),october=run(snapshot,'2026-10-01','2026-10-31'),total=run(snapshot,'2026-09-01','2026-10-31')
 assert.equal(september.appliedPrincipalCents,5000);assert.equal(october.appliedPrincipalCents,-1000);assert.equal(total.appliedPrincipalCents,4000)
 for(const key of ['cogsCents','expenseCents','capitalizedCents'])assert.equal(september[key]+october[key],total[key])
 snapshot.tables.payment_reversals[0].bill_id=id(99);assert.throws(()=>run(snapshot,'2026-09-01','2026-10-31'),/original operational bill/)
 const excess=withRefund();excess.tables.payment_reversals[0].amount_cents=5001;assert.throws(()=>run(excess,'2026-09-01','2026-10-31'),/exceeds the original/)
 const pending=withRefund();pending.tables.payment_reversals[0].status='pending';assert.throws(()=>run(pending,'2026-09-01','2026-10-31'),/does not reconcile/)
})
test('unsupported funding, credit applications and missing historical classification require review',()=>{
 const card=fixture();const funding=card.tables.journal_lines[5].dimensions.books_account_classification;funding.account_type='liability';funding.subtype='credit_card';assert.throws(()=>run(card),/Noncash supplier funding/)
 const credit=fixture();credit.tables.payments[0].metadata={vendor_credit_applied:true};assert.throws(()=>run(credit),/credit applications/)
 const legacy=fixture();delete legacy.tables.journal_lines[0].dimensions.books_account_classification;assert.throws(()=>run(legacy),/historical review/)
 const tax=fixture();tax.tables.accounting_facts[0].payload.use_tax_accrued_cents=700;assert.throws(()=>run(tax),/use tax/)
})
test('snapshot completeness, organization scope and duplicate identities are mandatory',()=>{
 const absent=fixture();delete absent.tables.payments;assert.throws(()=>run(absent),/missing payments/)
 const foreign=fixture();foreign.tables.payments[0].org_id=id(99);assert.throws(()=>run(foreign),/foreign organization/)
 const duplicate=fixture();duplicate.tables.books_projection_receipts.push(duplicate.tables.books_projection_receipts[0]);assert.throws(()=>run(duplicate),/Duplicate/)
 assert.throws(()=>build(id(99),'2026-09-01','2026-09-30',fixture()),/organization mismatch/)
})
test('paid-cost service authorizes whole books access before its single snapshot read',async()=>{
 const Module=require('node:module'),original=Module._load;let denied=false,reads=0,load
 const service={async rpc(name,args){assert.equal(name,'capture_books_export_snapshot');assert.equal(args.p_org_id,org);reads++;return {data:fixture(),error:null}}}
 try{Module._load=function(name,...args){if(name==='server-only')return {};if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>service};if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:id(99),supabase:service})};if(name==='@/lib/services/books/access')return {requireBooksAuthorization:async args=>{assert.equal(args.permission,'books.read');assert.equal(args.orgId,org);if(denied)throw new Error('Denied')}};return original.call(this,name,...args)};load=require('../lib/services/books/cash-cost-service').buildCashBillCosts}finally{Module._load=original}
 denied=true;await assert.rejects(load('2026-09-01','2026-09-30'),/Denied/);assert.equal(reads,0)
 denied=false;assert.equal((await load('2026-09-01','2026-09-30')).cogsCents,3000);assert.equal(reads,1)
})

test('a later bill cost reclassification cannot silently rewrite earlier paid costs',()=>{
 const snapshot=fixture(),tables=snapshot.tables
 tables.journal_entries[0].status='reversed'
 tables.accounting_facts.push({...structuredClone(tables.accounting_facts[0]),id:id(30)})
 tables.journal_entries.push({...structuredClone(tables.journal_entries[0]),id:id(31),status:'posted',fact_id:id(30)})
 tables.journal_lines.push(...tables.journal_lines.filter(row=>row.entry_id===id(6)).map(row=>{
  const changed=structuredClone(row);changed.entry_id=id(31)
  if(changed.line_no===1){changed.account_id=id(99);changed.dimensions.books_account_classification={...changed.dimensions.books_account_classification,account_id:id(99),code:'5010',subtype:'subcontractor_costs'}}
  return changed
 }))
 tables.books_projection_receipts[1].journal_id=id(31);tables.books_projection_receipts[1].fact_id=id(30)
 assert.throws(()=>run(snapshot),/Revised bill costs/)
})
