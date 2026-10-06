require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {cashInvoiceIncomeFromSnapshot:build}=require('../lib/services/books/cash-income-snapshot')
const {directSettlementEvidence}=require('../lib/services/books/settlement-evidence')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,org=id(1),invoice=id(2),payment=id(3),revision='2026-09-20T12:00:00.000001+00:00'
function fixture(){
 const tables=Object.fromEntries(['journal_entries','journal_lines','accounting_facts','gl_accounts','invoices','payments','payment_allocations','payment_reversals','receivable_adjustments','books_projection_receipts'].map(name=>[name,[]]))
 tables.gl_accounts=[{id:id(4),code:'1100'},{id:id(5),code:'1000'},{id:id(6),code:'4010'},{id:id(11),code:'2250'}]
 tables.invoices=[{id:invoice,updated_at:revision}]
 tables.payments=[{id:payment,invoice_id:invoice,amount_cents:10700,status:'completed',received_at:revision,updated_at:revision}]
 tables.accounting_facts=[{id:id(7),source_type:'invoice',source_id:invoice,accounting_date:'2026-09-01',payload:{total_cents:10700,tax_cents:700,revenue_basis:'on_invoice',revenue_lines:[{account_code:'4010',amount_cents:10000}]}},{id:id(8),source_type:'invoice_payment',source_id:payment,accounting_date:'2026-09-20',payload:{amount_cents:10700,settlement_evidence:directSettlementEvidence({paymentId:payment,invoiceId:invoice})}}]
 tables.journal_entries=[{id:id(9),fact_id:id(7),source_type:'invoice',source_id:invoice,status:'posted',entry_date:'2026-09-01',reversal_of_entry_id:null},{id:id(10),fact_id:id(8),source_type:'invoice_payment',source_id:payment,status:'posted',entry_date:'2026-09-20',reversal_of_entry_id:null}]
 tables.journal_lines=[{entry_id:id(9),account_id:id(4),debit_cents:10700,credit_cents:0},{entry_id:id(9),account_id:id(6),debit_cents:0,credit_cents:10000},{entry_id:id(9),account_id:id(11),debit_cents:0,credit_cents:700},{entry_id:id(10),account_id:id(4),debit_cents:0,credit_cents:10700},{entry_id:id(10),account_id:id(5),debit_cents:10700,credit_cents:0}]
 tables.books_projection_receipts=[{source_type:'invoice_payment',source_id:payment,source_observed_at:revision,journal_id:id(10),fact_id:id(8)},{source_type:'invoice',source_id:invoice,source_observed_at:revision,journal_id:id(9),fact_id:id(7)}]
 for(const rows of Object.values(tables))for(const row of rows)row.org_id=org
 return {orgId:org,capturedAt:revision,databaseSnapshot:'single-mvcc-snapshot',tables}
}
const run=snapshot=>build(org,'2026-09-01','2026-09-30',snapshot)
test('reconciled single-snapshot cash invoice income separates tax and carries source provenance',()=>{
 const result=run(fixture());assert.equal(result.incomeCents,10000);assert.equal(result.salesTaxCents,700)
 assert.equal(result.databaseSnapshot,'single-mvcc-snapshot');assert.equal(result.settlementEvidence[0].paymentId,payment)
 assert.equal(result.rows[0].snapshotId,id(7))
 const paid=fixture();paid.tables.payments[0].status='paid';assert.equal(run(paid).incomeCents,10000)
})
test('missing, stale and omitted payment postings block plausible but incomplete income',()=>{
 const missing=fixture();missing.tables.journal_entries.pop();assert.throws(()=>run(missing),/does not reconcile/)
 const stale=fixture();stale.tables.payments[0].updated_at='2026-09-20T12:00:00.000002+00:00';assert.throws(()=>run(stale),/Refresh/)
 const omitted=fixture();omitted.tables.payments.push({...omitted.tables.payments[0],id:id(99)});assert.throws(()=>run(omitted),/does not reconcile/)
 const orphan=fixture();orphan.tables.payments=[];assert.throws(()=>run(orphan),/operational payment history/)
 const staleInvoice=fixture();staleInvoice.tables.invoices[0].updated_at='2026-09-20T12:00:00.000002+00:00';assert.throws(()=>run(staleInvoice),/Refresh the invoice/)
})
test('legacy basis, revised tax, credits and advance policies block until reviewed',()=>{
 const legacy=fixture();delete legacy.tables.accounting_facts[0].payload.revenue_lines;assert.throws(()=>run(legacy),/historical attribution/)
 const revised=fixture();revised.tables.accounting_facts.push({...revised.tables.accounting_facts[0],id:id(99),payload:{...revised.tables.accounting_facts[0].payload,revenue_lines:[{account_code:'4020',amount_cents:10000}]}});revised.tables.journal_entries.push({...revised.tables.journal_entries[0],id:id(100),fact_id:id(99)});assert.throws(()=>run(revised),/differs|Revised invoice/)
 const credit=fixture();credit.tables.receivable_adjustments.push({org_id:org,invoice_id:invoice,status:'posted',effective_date:'2026-09-25'});assert.throws(()=>run(credit),/credits or writeoffs/)
 const advance=fixture();advance.tables.journal_entries[0].source_type='customer_deposit_receipt';assert.throws(()=>run(advance),/Advance receipts/)
})
test('snapshot completeness and organization scope are mandatory',()=>{
 const absent=fixture();delete absent.tables.payments;assert.throws(()=>run(absent),/missing payments/)
 const foreign=fixture();foreign.tables.payments[0].org_id=id(99);assert.throws(()=>run(foreign),/foreign organization/)
 assert.throws(()=>build(id(99),'2026-09-01','2026-09-30',fixture()),/organization mismatch/)
})
test('real succeeded refund status reconciles principal and reverses income and tax',()=>{
 const snapshot=fixture(),refundId=id(20),refundFactId=id(21),refundEntryId=id(22)
 snapshot.tables.payment_reversals.push({id:refundId,org_id:org,payment_id:payment,invoice_id:invoice,amount_cents:1070,status:'succeeded',occurred_at:'2026-09-25T12:00:00Z',updated_at:revision})
 snapshot.tables.accounting_facts.push({id:refundFactId,org_id:org,source_type:'payment_reversal',source_id:refundId,accounting_date:'2026-09-25',payload:{amount_cents:1070,side:'invoice_payment',settlement_evidence:directSettlementEvidence({paymentId:payment,invoiceId:invoice})}})
 snapshot.tables.journal_entries.push({id:refundEntryId,org_id:org,fact_id:refundFactId,source_type:'payment_reversal',source_id:refundId,status:'posted',entry_date:'2026-09-25',reversal_of_entry_id:null})
 snapshot.tables.journal_lines.push({org_id:org,entry_id:refundEntryId,account_id:id(4),debit_cents:1070,credit_cents:0},{org_id:org,entry_id:refundEntryId,account_id:id(5),debit_cents:0,credit_cents:1070})
 snapshot.tables.books_projection_receipts.push({org_id:org,source_type:'payment_reversal',source_id:refundId,source_observed_at:revision,journal_id:refundEntryId,fact_id:refundFactId})
 const result=run(snapshot);assert.equal(result.incomeCents,9000);assert.equal(result.salesTaxCents,630);assert.equal(result.appliedPrincipalCents,9630)
 snapshot.tables.payment_reversals[0].status='pending';assert.throws(()=>run(snapshot),/does not reconcile/)
})
test('cash income service authorizes whole books access before its one snapshot read',async()=>{
 const Module=require('node:module'),original=Module._load;let denied=false,reads=0
 const service={async rpc(name,args){assert.equal(name,'capture_books_export_snapshot');assert.equal(args.p_org_id,org);reads++;return {data:fixture(),error:null}}}
 let load
 try{Module._load=function(name,...args){if(name==='server-only')return {};if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>service};if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:id(99),supabase:service})};if(name==='@/lib/services/books/access')return {requireBooksAuthorization:async args=>{assert.equal(args.permission,'books.read');assert.equal(args.orgId,org);if(denied)throw new Error('Denied')}};return original.call(this,name,...args)};load=require('../lib/services/books/cash-income').buildCashInvoiceIncome}finally{Module._load=original}
 denied=true;await assert.rejects(load('2026-09-01','2026-09-30'),/Denied/);assert.equal(reads,0)
 denied=false;assert.equal((await load('2026-09-01','2026-09-30')).incomeCents,10000);assert.equal(reads,1)
})
