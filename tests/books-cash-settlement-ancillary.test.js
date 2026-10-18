require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {cashSettlementAncillaryFromSnapshot:build}=require('../lib/services/books/cash-settlement-ancillary')
const {draftFromFact}=require('../lib/services/books/fact-drafts')
const {CONSTRUCTION_CHART_TEMPLATE}=require('../lib/services/books/chart-of-accounts')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,org=id(1),revision='2026-09-20T12:00:00.000001+00:00'
function fixture(){
 const tables=Object.fromEntries(['journal_entries','journal_lines','accounting_facts','payments','payment_allocations','payment_run_fee_charges','payment_runs','org_funding_sources','books_projection_receipts'].map(name=>[name,[]]))
 tables.payments=[{id:id(2),invoice_id:id(90),amount_cents:10000,gross_cents:10100,fee_cents:150,processor_fee_cents:75,platform_fee_cents:75,status:'paid',received_at:revision,updated_at:revision}]
 tables.payment_run_fee_charges=[{id:id(7),run_id:id(8),funding_source_id:id(9),status:'succeeded',amount_cents:300,settled_at:revision,updated_at:revision}]
 tables.payment_runs=[{id:id(8),funding_source_id:id(9)}];tables.org_funding_sources=[{id:id(9)}]
 const payloads=[['invoice_payment',id(2),id(3),id(4),{amount_cents:10000,gross_cents:10100,fee_cents:150}],['ap_fee_charge',id(7),id(5),id(6),{amount_cents:300}]]
 for(const [type,source,fact,entry,payload] of payloads){
  tables.accounting_facts.push({id:fact,source_type:type,source_id:source,accounting_date:'2026-09-20',payload})
  tables.journal_entries.push({id:entry,fact_id:fact,source_type:type,source_id:source,entry_date:'2026-09-20',status:'posted',reversal_of_entry_id:null})
  const draft=draftFromFact({sourceType:type,sourceId:source,accountingDate:'2026-09-20',sourceVersion:1,projectionVersion:1,policyVersion:1,payload})
  tables.journal_lines.push(...draft.lines.map((line,i)=>{const account=CONSTRUCTION_CHART_TEMPLATE.find(account=>account.code===line.accountCode),accountId=id(100+Number(line.accountCode));return {entry_id:entry,line_no:i+1,account_id:accountId,debit_cents:line.debitCents,credit_cents:line.creditCents,project_id:id(91),dimensions:{...line.dimensions,books_account_classification:{version:1,account_id:accountId,code:line.accountCode,account_type:account.accountType,subtype:account.subtype}}}}))
  tables.books_projection_receipts.push({source_type:type,source_id:source,fact_id:fact,journal_id:entry,source_observed_at:revision})
 }
 for(const rows of Object.values(tables))for(const row of rows)row.org_id=org
 return {orgId:org,capturedAt:revision,databaseSnapshot:'one-mvcc',tables}
}
const run=(snapshot,start='2026-09-01',end='2026-10-31')=>build(org,start,end,snapshot)
test('receipt split fees, recoveries and separately collected AP fees stay distinct from principal',()=>{
 const result=run(fixture());assert.equal(result.feeExpenseCents,450);assert.equal(result.ancillaryIncomeCents,100)
 assert.equal(result.rows.find(row=>row.kind==='income').accountCode,'4920');assert.ok(result.rows.every(row=>row.dimensions.project_id===id(91)))
 assert.equal(result.databaseSnapshot,'one-mvcc')
})
test('fee corrections cancel original amounts at their actual posted cutoff before replacements',()=>{
 const snapshot=fixture(),tables=snapshot.tables,original=tables.journal_entries[0],fact=tables.accounting_facts[0]
 original.status='reversed'
 tables.journal_entries.push({...original,id:id(30),status:'posted',fact_id:null,source_type:'reversal',entry_date:'2026-10-01',reversal_of_entry_id:original.id},{...original,id:id(31),status:'posted',fact_id:id(32),entry_date:'2026-10-01'})
 tables.accounting_facts.push({...fact,id:id(32),accounting_date:'2026-10-01'})
 const lines=tables.journal_lines.filter(row=>row.entry_id===original.id)
 tables.journal_lines.push(...lines.map(row=>({...structuredClone(row),entry_id:id(30),debit_cents:row.credit_cents,credit_cents:row.debit_cents})),...lines.map(row=>({...structuredClone(row),entry_id:id(31)})))
 tables.books_projection_receipts[0].fact_id=id(32);tables.books_projection_receipts[0].journal_id=id(31)
 const whole=run(snapshot)
 // Current receipt moved outside the earlier cutoff: the report needs a
 // reviewed historical revision rather than accepting today's receipt.
 assert.equal(whole.feeExpenseCents,450)
 assert.throws(()=>run(snapshot,'2026-09-01','2026-09-30'),/Refresh/)
 assert.equal(run(snapshot,'2026-10-01').feeExpenseCents,0)
})
test('missing, stale, orphaned and unposted fee evidence blocks understated ancillary costs',()=>{
 const missing=fixture();missing.tables.journal_entries=missing.tables.journal_entries.filter(entry=>entry.source_type!=='ap_fee_charge');assert.throws(()=>run(missing),/no posted expense/)
 const stale=fixture();stale.tables.payment_run_fee_charges[0].updated_at='2026-09-20T12:00:00.000002+00:00';assert.throws(()=>run(stale),/Refresh/)
 const orphan=fixture();orphan.tables.payment_run_fee_charges=[];assert.throws(()=>run(orphan),/operational source history/)
 const receipt=fixture();receipt.tables.books_projection_receipts=[];assert.throws(()=>run(receipt),/Refresh/)
 const allocated=fixture();allocated.tables.payments[0].invoice_id=null;allocated.tables.payment_allocations.push({org_id:org,payment_id:id(2),invoice_id:id(90)});allocated.tables.journal_entries=allocated.tables.journal_entries.filter(entry=>entry.source_type!=='invoice_payment');assert.throws(()=>run(allocated),/no posted fee evidence/)
})
test('source split fees, frozen amounts, ownership and classification cannot silently drift',()=>{
 const split=fixture();split.tables.payments[0].processor_fee_cents=76;assert.throws(()=>run(split),/Operational receipt fees/)
 const fact=fixture();fact.tables.accounting_facts[0].payload.fee_cents=151;assert.throws(()=>run(fact),/frozen source fact/)
 const funding=fixture();funding.tables.payment_runs[0].funding_source_id=id(99);assert.throws(()=>run(funding),/funding ownership/)
 const card=fixture();const cash=card.tables.journal_lines.find(row=>row.entry_id===id(6)&&row.credit_cents>0).dimensions.books_account_classification;cash.account_type='liability';cash.subtype='credit_card';assert.throws(()=>run(card),/Noncash/)
 const legacy=fixture();delete legacy.tables.journal_lines[0].dimensions.books_account_classification;assert.throws(()=>run(legacy),/historical account/)
})
test('supplier discounts are income beside gross paid costs and never reduce principal a second time',()=>{
 const snapshot=fixture(),tables=snapshot.tables,payment=id(40),fact=id(41),entry=id(42)
 tables.payments.push({org_id:org,id:payment,bill_id:id(43),amount_cents:5000,status:'completed',received_at:revision,updated_at:revision})
 const payload={amount_cents:5000,discount_cents:100}
 tables.accounting_facts.push({org_id:org,id:fact,source_type:'bill_payment',source_id:payment,accounting_date:'2026-09-20',payload})
 tables.journal_entries.push({org_id:org,id:entry,fact_id:fact,source_type:'bill_payment',source_id:payment,entry_date:'2026-09-20',status:'posted',reversal_of_entry_id:null})
 const draft=draftFromFact({sourceType:'bill_payment',sourceId:payment,accountingDate:'2026-09-20',sourceVersion:1,projectionVersion:1,policyVersion:1,payload})
 for(const [i,line] of draft.lines.entries()){const account=CONSTRUCTION_CHART_TEMPLATE.find(account=>account.code===line.accountCode),accountId=id(100+Number(line.accountCode));tables.journal_lines.push({org_id:org,entry_id:entry,line_no:i+1,account_id:accountId,debit_cents:line.debitCents,credit_cents:line.creditCents,dimensions:{books_account_classification:{version:1,account_id:accountId,code:line.accountCode,account_type:account.accountType,subtype:account.subtype}}})}
 tables.books_projection_receipts.push({org_id:org,source_type:'bill_payment',source_id:payment,fact_id:fact,journal_id:entry,source_observed_at:revision})
 assert.equal(run(snapshot).ancillaryIncomeCents,200);assert.equal(run(snapshot).feeExpenseCents,450)
})
test('snapshot scope, dates, duplicates and unbalanced journals are rejected',()=>{
 const foreign=fixture();foreign.tables.payment_run_fee_charges[0].org_id=id(99);assert.throws(()=>run(foreign),/foreign organization/)
 const absent=fixture();delete absent.tables.payment_run_fee_charges;assert.throws(()=>run(absent),/missing/)
 const duplicate=fixture();duplicate.tables.journal_lines.push(duplicate.tables.journal_lines[0]);assert.throws(()=>run(duplicate),/Duplicate/)
 const unbalanced=fixture();unbalanced.tables.journal_lines[0].debit_cents++;assert.throws(()=>run(unbalanced),/not balanced/)
 const undated=fixture();undated.tables.payment_run_fee_charges[0].settled_at=null;assert.throws(()=>run(undated),/valid settlement date/)
})
