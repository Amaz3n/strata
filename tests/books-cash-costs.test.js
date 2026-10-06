require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {cashCostBasisFromBillJournal:basisFromJournal,allocateCashBillCosts:report}=require('../lib/services/books/cash-costs')
const {cashBillSettlementsFromLedger:extract}=require('../lib/services/books/cash-settlement-ledger')
const {directSettlementEvidence}=require('../lib/services/books/settlement-evidence')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const line=(n,code,type,subtype,debit,credit=0)=>({line_no:n,account_id:id(n),debit_cents:debit,credit_cents:credit,project_id:id(90),dimensions:{cost_code_id:id(91),books_account_classification:{version:1,account_id:id(n),code,account_type:type,subtype,normal_balance:type==='liability'?'credit':'debit'}}})
const lines=[line(1,'5000','cogs','job_costs',6000),line(2,'6000','expense','rent',3000),line(3,'1500','asset','fixed_assets',1000),line(4,'2000','liability','accounts_payable',0,9000),line(5,'2010','liability','retainage_payable',0,1000)]
const input={factId:id(80),billId:id(81),accountingDate:'2026-01-01',grossCents:10000,useTaxCents:0,lines,completeSettlementHistory:true}
const basis=basisFromJournal(input)
const event=(n,date,cents,document=basis)=>({eventId:id(n),documentId:document.documentId,snapshotId:document.snapshotId,settledOn:date,appliedCents:cents})
const run=(events,startDate='2026-01-01',endDate='2026-12-31',documents=[basis])=>report({startDate,endDate,documents,settlements:events})

test('paid purchases preserve frozen classifications, retainage principal and construction grain',()=>{
 const result=run([event(1,'2026-02-01',5000)])
 assert.equal(result.cogsCents,3000);assert.equal(result.expenseCents,1500);assert.equal(result.capitalizedCents,500)
 assert.equal(result.appliedPrincipalCents,5000)
 assert.equal(result.rows.find(row=>row.kind==='cogs').dimensions.cost_code_id,id(91))
 assert.equal(result.rows.find(row=>row.kind==='capitalized').accountCode,'1500')
 assert.equal(run([]).appliedPrincipalCents,0)
 const capitalOnly={...basis,components:[{...basis.components[2],amountCents:10000}]}
 assert.equal(run([event(2,'2026-02-01',10000,capitalOnly)],undefined,undefined,[capitalOnly]).capitalizedCents,10000)
})
test('installments and supplier refunds telescope by native cost component across report periods',()=>{
 const events=[event(1,'2026-01-31',1),event(2,'2026-02-01',3332),event(3,'2026-03-01',6667),event(4,'2026-04-01',-10000)]
 const months=[['2026-01-01','2026-01-31'],['2026-02-01','2026-02-28'],['2026-03-01','2026-03-31'],['2026-04-01','2026-04-30']].map(([start,end])=>run(events,start,end))
 for(const key of ['cogsCents','expenseCents','capitalizedCents','appliedPrincipalCents'])assert.equal(months.reduce((sum,row)=>sum+row[key],0),0)
 assert.equal(months[3].capitalizedCents,-1000)
 assert.deepEqual(run(events).rows,[])
 assert.deepEqual(run(events.slice().reverse()),run(events))
 const credits={...basis,components:[{...basis.components[0],amountCents:12000},{...basis.components[1],amountCents:-2000}]}
 assert.equal(run([event(5,'2026-02-01',5000,credits)],undefined,undefined,[credits]).expenseCents,-1000)
})
test('missing frozen classification and unsupported bill tax or journal evidence require review',()=>{
 assert.throws(()=>basisFromJournal({...input,useTaxCents:700}),/use tax/)
 assert.throws(()=>basisFromJournal({...input,lines:lines.map(row=>({...row,dimensions:{}}))}),/historical review/)
 assert.throws(()=>basisFromJournal({...input,lines:lines.map((row,i)=>i===0?{...row,account_id:id(99)}:row)}),/classification/)
 assert.throws(()=>basisFromJournal({...input,lines:[...lines,lines[0]]}),/unique/)
 assert.throws(()=>basisFromJournal({...input,lines:lines.slice(1)}),/reconcile/)
 assert.throws(()=>basisFromJournal({...input,lines:lines.map((row,i)=>i===2?line(3,'1001','asset','cash',1000):row)}),/unsupported/)
 assert.throws(()=>basisFromJournal({...input,grossCents:-10000}),/positive/)
})
test('complete history, unique events, cutoff dates and bounded cumulative principal are mandatory',()=>{
 assert.throws(()=>run([],undefined,undefined,[{...basis,completeSettlementHistory:false}]),/complete/)
 assert.throws(()=>run([event(1,'2025-12-31',1)]),/advances/)
 assert.throws(()=>run([event(1,'2026-02-01',10001),event(2,'2026-03-01',-1)]),/Excess/)
 assert.throws(()=>run([event(1,'2026-02-01',-1)]),/Excess/)
 assert.throws(()=>run([event(1,'2026-02-01',1),event(1,'2026-02-01',1)]),/Duplicate/)
 assert.throws(()=>run([event(1,'2026-02-30',1)]),/calendar/)
 assert.throws(()=>run([{...event(1,'2026-02-01',1),snapshotId:id(99)}]),/matching/)
 const huge={...basis,grossCents:Number.MAX_SAFE_INTEGER,components:[{...basis.components[0],amountCents:Number.MAX_SAFE_INTEGER}]}
 assert.equal(run([event(1,'2026-02-01',Number.MAX_SAFE_INTEGER,huge)],undefined,undefined,[huge]).cogsCents,Number.MAX_SAFE_INTEGER)
 const other={...huge,documentId:id(99),snapshotId:id(98)}
 assert.throws(()=>run([event(1,'2026-02-01',Number.MAX_SAFE_INTEGER,huge),event(2,'2026-02-01',Number.MAX_SAFE_INTEGER,other)],undefined,undefined,[huge,other]),/safe integer/)
})
test('vendor settlements use gross AP relief and cancel corrections before replacement and supplier refunds',()=>{
 const fact={id:id(1),source_type:'bill_payment',source_id:id(2),payload:{amount_cents:5000,settlement_evidence:directSettlementEvidence({paymentId:id(2),billId:basis.documentId})}}
 const entry={id:id(3),status:'reversed',fact_id:fact.id,source_type:fact.source_type,source_id:fact.source_id,entry_date:'2026-02-01',reversal_of_entry_id:null}
 const reversal={...entry,id:id(4),status:'posted',fact_id:null,source_type:'reversal',reversal_of_entry_id:entry.id}
 const replacementFact={...fact,id:id(5)},replacement={...entry,id:id(6),status:'posted',fact_id:replacementFact.id}
 const refundFact={...fact,id:id(7),source_type:'payment_reversal',source_id:id(8),payload:{...fact.payload,side:'bill_payment',amount_cents:1000}}
 const refund={...entry,id:id(9),status:'posted',fact_id:refundFact.id,source_type:refundFact.source_type,source_id:refundFact.source_id,entry_date:'2026-03-01'}
 const ap=(entry_id,debit_cents,credit_cents=0)=>({entry_id,account_code:'2000',debit_cents,credit_cents})
 const events=extract({facts:[fact,replacementFact,refundFact],entries:[entry,reversal,replacement,refund],lines:[ap(entry.id,5000),ap(reversal.id,0,5000),ap(replacement.id,5000),ap(refund.id,0,1000),{entry_id:replacement.id,account_code:'4910',debit_cents:0,credit_cents:100},{entry_id:replacement.id,account_code:'1000',debit_cents:0,credit_cents:4900}]})
 assert.equal(events.reduce((sum,row)=>sum+row.appliedCents,0),4000)
 assert.equal(run(events.map(row=>({...row,snapshotId:basis.snapshotId}))).appliedPrincipalCents,4000)
})

test('allocated supplier payments require exact frozen bill ownership on every AP line',()=>{
 const other=id(82),payment=id(40),factId=id(41),entryId=id(42)
 const fact={id:factId,source_type:'bill_payment',source_id:payment,payload:{amount_cents:10000,settlement_evidence:{version:2,kind:'allocated',payment_id:payment,payment_amount_cents:10000,allocations:[{allocation_id:id(43),invoice_id:null,bill_id:basis.documentId,project_id:id(90),amount_cents:6000},{allocation_id:id(44),invoice_id:null,bill_id:other,project_id:null,amount_cents:4000}]}}}
 const entry={id:entryId,status:'posted',fact_id:factId,source_type:'bill_payment',source_id:payment,entry_date:'2026-02-01',reversal_of_entry_id:null}
 const rows=[{entry_id:entryId,account_code:'2000',debit_cents:6000,credit_cents:0,dimensions:{bill_id:basis.documentId}},{entry_id:entryId,account_code:'2000',debit_cents:4000,credit_cents:0,dimensions:{bill_id:other}}]
 const result=extract({facts:[fact],entries:[entry],lines:rows})
 assert.equal(result.find(row=>row.documentId===other).appliedCents,4000)
 assert.equal(result.find(row=>row.documentId===basis.documentId).appliedCents,6000)
 assert.throws(()=>extract({facts:[fact],entries:[entry],lines:rows.map((row,i)=>i===0?{...row,debit_cents:5999}:row)}),/differs/)
 assert.throws(()=>extract({facts:[fact],entries:[entry],lines:rows.map(row=>({...row,dimensions:{}}))}),/ownership/)
 const unknown={...fact,source_type:'payment_reversal',payload:{...fact.payload,side:'unknown'}}
 assert.throws(()=>extract({facts:[unknown],entries:[{...entry,source_type:'payment_reversal'}],lines:rows}),/no frozen settlement/)
})
