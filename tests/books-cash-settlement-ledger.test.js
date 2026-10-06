require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {cashInvoiceSettlementsFromLedger:extract}=require('../lib/services/books/cash-settlement-ledger')
const {directSettlementEvidence}=require('../lib/services/books/settlement-evidence')
const {cashIncomeBasisFromInvoiceFact}=require('../lib/services/books/cash-document-evidence')
const {allocateCashDocumentSettlements}=require('../lib/services/books/cash-settlement-rules')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const fact={id:id(1),source_type:'invoice_payment',source_id:id(2),payload:{amount_cents:10700,settlement_evidence:directSettlementEvidence({paymentId:id(2),invoiceId:id(3)})}}
const entry={id:id(4),status:'posted',fact_id:fact.id,source_type:fact.source_type,source_id:fact.source_id,entry_date:'2026-09-30',reversal_of_entry_id:null}
const line=(entryId,credit,debit=0,dimensions)=>({entry_id:entryId,account_code:'1100',credit_cents:credit,debit_cents:debit,dimensions})
test('collected invoice income uses gross AR principal despite processor fees in the bank deposit',()=>{
 const events=extract({facts:[fact],entries:[entry],lines:[line(entry.id,10700),{entry_id:entry.id,account_code:'1000',debit_cents:10400,credit_cents:0},{entry_id:entry.id,account_code:'6040',debit_cents:300,credit_cents:0}]})
 assert.equal(events[0].appliedCents,10700)
 const document=cashIncomeBasisFromInvoiceFact({id:id(10),sourceId:id(3),accountingDate:'2026-09-01',payload:{total_cents:10700,tax_cents:700,revenue_basis:'on_invoice',revenue_lines:[{account_code:'4010',amount_cents:10000}]}},true)
 const result=allocateCashDocumentSettlements({documents:[document],settlements:events.map(row=>({...row,snapshotId:document.snapshotId})),startDate:'2026-09-01',endDate:'2026-09-30'})
 assert.equal(result.incomeCents,10000);assert.equal(result.salesTaxCents,700)
})
test('a corrected collection cancels its old principal before counting the replacement',()=>{
 const reversal={...entry,id:id(5),fact_id:null,source_type:'reversal',source_id:entry.id,reversal_of_entry_id:entry.id,entry_date:'2026-10-01'}
 const newFact={...fact,id:id(6),payload:{...fact.payload,amount_cents:5000}}
 const replacement={...entry,id:id(7),fact_id:newFact.id,entry_date:'2026-10-01'}
 const result=extract({facts:[fact,newFact],entries:[{...entry,status:'reversed'},reversal,replacement],lines:[line(entry.id,10700),line(reversal.id,0,10700),line(replacement.id,5000)]})
 assert.equal(result.reduce((sum,row)=>sum+row.appliedCents,0),5000)
 assert.equal(result.filter(row=>row.settledOn==='2026-09-30').reduce((sum,row)=>sum+row.appliedCents,0),10700)
 assert.equal(result.filter(row=>row.settledOn==='2026-10-01').reduce((sum,row)=>sum+row.appliedCents,0),-5700)
 assert.ok(result.every(row=>row.paymentId===fact.source_id))
})
test('allocated receipts preserve each invoice and full correction reverses the original allocation',()=>{
 const allocated={...fact,payload:{amount_cents:10700,settlement_evidence:{version:2,kind:'allocated',payment_id:fact.source_id,payment_amount_cents:10700,allocations:[{allocation_id:id(11),invoice_id:id(3),bill_id:null,project_id:null,amount_cents:7000},{allocation_id:id(12),invoice_id:id(13),bill_id:null,project_id:null,amount_cents:3700}]}}}
 const reversal={...entry,id:id(5),source_type:'reversal',reversal_of_entry_id:entry.id}
 const inputs={facts:[allocated],entries:[{...entry,status:'reversed'},reversal],lines:[line(entry.id,7000,0,{invoice_id:id(3)}),line(entry.id,3700,0,{invoice_id:id(13)}),line(reversal.id,0,7000,{invoice_id:id(3)}),line(reversal.id,0,3700,{invoice_id:id(13)})]}
 const result=extract(inputs)
 assert.equal(result.length,4)
 for(const document of [id(3),id(13)])assert.equal(result.filter(row=>row.documentId===document).reduce((sum,row)=>sum+row.appliedCents,0),0)
 assert.throws(()=>extract({...inputs,lines:inputs.lines.map((row,i)=>i===0?{...row,credit_cents:6999}:row)}),/differs/)
})
test('actual customer refunds retain original payment ownership and missing or inconsistent history blocks calculation',()=>{
 const refundFact={...fact,id:id(20),source_type:'payment_reversal',source_id:id(21),payload:{...fact.payload,side:'invoice_payment',amount_cents:1000}}
 const refundEntry={...entry,id:id(22),fact_id:refundFact.id,source_type:refundFact.source_type,source_id:refundFact.source_id}
 const result=extract({facts:[refundFact],entries:[refundEntry],lines:[line(refundEntry.id,0,1000)]})
 assert.equal(result[0].appliedCents,-1000);assert.equal(result[0].paymentId,fact.source_id)
 assert.throws(()=>extract({facts:[],entries:[entry],lines:[line(entry.id,10700)]}),/immutable/)
 assert.throws(()=>extract({facts:[{...fact,payload:{amount_cents:10700}}],entries:[entry],lines:[line(entry.id,10700)]}))
 assert.throws(()=>extract({facts:[fact],entries:[{...entry,source_id:id(99)}],lines:[line(entry.id,10700)]}),/immutable/)
 assert.throws(()=>extract({facts:[fact],entries:[entry],lines:[line(entry.id,10000)]}),/differs/)
 assert.throws(()=>extract({facts:[fact],entries:[{...entry,reversal_of_entry_id:id(99)}],lines:[line(entry.id,10700)]}),/missing.*lineage/)
 assert.deepEqual(extract({facts:[fact],entries:[{...entry,status:'draft'}],lines:[line(entry.id,10700)]}),[])
 assert.throws(()=>extract({facts:[fact],entries:[entry,{...entry,id:id(99)}],lines:[line(entry.id,10700),line(id(99),10700)]}),/multiple original/)
})
