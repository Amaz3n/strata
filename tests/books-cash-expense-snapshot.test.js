require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {cashDirectExpensesFromSnapshot:build}=require('../lib/services/books/cash-expense-snapshot')
const {draftFromFact}=require('../lib/services/books/fact-drafts')
const {cashCostBasisFromExpenseJournal}=require('../lib/services/books/cash-costs')
const {postExpenseFromCostLines}=require('../lib/services/books/posting-rules')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,org=id(1),expense=id(2),revision='2026-09-20T12:00:00.000001+00:00'
function fixture(){
 const tables=Object.fromEntries(['journal_entries','journal_lines','accounting_facts','project_expenses','books_projection_receipts'].map(name=>[name,[]]))
 tables.project_expenses=[{id:expense,status:'approved',expense_date:'2026-09-20',amount_cents:3000,tax_cents:0,updated_at:revision}]
 tables.accounting_facts=[{id:id(3),source_type:'expense',source_id:expense,accounting_date:'2026-09-20',payload:{amount_cents:3000,cost_lines:[{account_code:'6000',amount_cents:2000,dimensions:{cost_code_id:id(90)}},{account_code:'1500',amount_cents:1000}]}}]
 tables.journal_entries=[{id:id(4),status:'posted',fact_id:id(3),source_type:'expense',source_id:expense,entry_date:'2026-09-20',reversal_of_entry_id:null}]
 const draft=draftFromFact({sourceType:'expense',sourceId:expense,accountingDate:'2026-09-20',sourceVersion:1,projectionVersion:1,policyVersion:1,payload:tables.accounting_facts[0].payload})
 tables.journal_lines=draft.lines.map((line,i)=>({entry_id:id(4),line_no:i+1,account_id:id(i+10),debit_cents:line.debitCents,credit_cents:line.creditCents,dimensions:{...line.dimensions,books_account_classification:{version:1,account_id:id(i+10),code:line.accountCode,account_type:line.accountCode==='6000'?'expense':'asset',subtype:line.accountCode==='6000'?'rent':line.accountCode==='1500'?'fixed_assets':'cash',normal_balance:'debit'}}}))
 tables.books_projection_receipts=[{source_type:'expense',source_id:expense,source_observed_at:revision,fact_id:id(3),journal_id:id(4)}]
 for(const rows of Object.values(tables))for(const row of rows)row.org_id=org
 return {orgId:org,capturedAt:revision,databaseSnapshot:'one-revision',tables}
}
const run=(snapshot,start='2026-09-01',end='2026-10-31')=>build(org,start,end,snapshot)
test('standalone expense replay keeps explicit native overhead/capitalized accounts and dimensions',()=>{
 const snapshot=fixture(),result=run(snapshot)
 assert.equal(result.expenseCents,2000);assert.equal(result.capitalizedCents,1000);assert.equal(result.paidPrincipalCents,3000)
 assert.equal(result.rows.find(row=>row.accountCode==='6000').dimensions.cost_code_id,id(90))
 assert.equal(run(snapshot,'2026-10-01').paidPrincipalCents,0)
 const fact={...snapshot.tables.accounting_facts[0].payload,cost_lines:[{account_code:'6000',amount_cents:2000},{amount_cents:1000}]}
 const draft=draftFromFact({sourceType:'expense',sourceId:expense,accountingDate:'2026-09-20',sourceVersion:1,projectionVersion:1,policyVersion:1,payload:fact})
 assert.equal(draft.lines.find(line=>line.accountCode==='6900').debitCents,1000)
})
test('direct-expense correction cancels original costs and retains posted replacement dates',()=>{
 const snapshot=fixture(),tables=snapshot.tables,original=tables.journal_entries[0]
 original.status='reversed'
 tables.journal_entries.push({...original,id:id(30),status:'posted',source_type:'reversal',fact_id:null,reversal_of_entry_id:original.id},{...original,id:id(31),status:'posted',entry_date:'2026-10-01',fact_id:id(32)})
 tables.accounting_facts.push({...structuredClone(tables.accounting_facts[0]),id:id(32),accounting_date:'2026-10-01'})
 const originalLines=tables.journal_lines.slice()
 tables.journal_lines.push(...originalLines.map(line=>({...structuredClone(line),entry_id:id(30),debit_cents:line.credit_cents,credit_cents:line.debit_cents})),...originalLines.map(line=>({...structuredClone(line),entry_id:id(31)})))
 tables.project_expenses[0].expense_date='2026-10-01';tables.books_projection_receipts[0].journal_id=id(31);tables.books_projection_receipts[0].fact_id=id(32)
 assert.equal(run(snapshot).paidPrincipalCents,3000)
 assert.equal(run(snapshot,'2026-09-01','2026-09-30').paidPrincipalCents,0)
 assert.equal(run(snapshot,'2026-10-01').paidPrincipalCents,3000)
})
test('missing/stale/orphaned or wrong-org source evidence blocks plausible incomplete expenses',()=>{
 const missing=fixture();missing.tables.journal_entries=[];assert.throws(()=>run(missing),/does not reconcile/)
 const stale=fixture();stale.tables.project_expenses[0].updated_at='2026-09-20T12:00:00.000002+00:00';assert.throws(()=>run(stale),/Refresh/)
 const orphan=fixture();orphan.tables.project_expenses=[];assert.throws(()=>run(orphan),/operational source/)
 const scope=fixture();scope.tables.journal_lines[0].org_id=id(99);assert.throws(()=>run(scope),/foreign organization/)
 const absent=fixture();delete absent.tables.books_projection_receipts;assert.throws(()=>run(absent),/missing/)
})
test('old ignored coding, unpaid liabilities, and absent historical classification require review',()=>{
 const old=fixture();old.tables.journal_lines[0].dimensions.books_account_classification.code='6900';assert.throws(()=>run(old),/native coding differs/)
 const legacy=fixture();delete legacy.tables.journal_lines[0].dimensions.books_account_classification;assert.throws(()=>run(legacy),/historical review/)
 const card=fixture();const funding=card.tables.journal_lines.at(-1).dimensions.books_account_classification;funding.account_type='liability';funding.subtype='credit_card';assert.throws(()=>run(card),/reviewed paid-cost/)
})
test('signed correcting journals preserve exact capitalized cost while rejecting cash transfers',()=>{
 const snapshot=fixture(),lines=snapshot.tables.journal_lines.map(line=>({...line,debit_cents:line.credit_cents,credit_cents:line.debit_cents}))
 const result=cashCostBasisFromExpenseJournal({factId:id(3),expenseId:expense,accountingDate:'2026-09-20',amountCents:-3000,lines})
 assert.equal(result.components.find(row=>row.kind==='capitalized').amountCents,-1000)
 assert.throws(()=>cashCostBasisFromExpenseJournal({factId:id(3),expenseId:expense,accountingDate:'2026-09-20',amountCents:3000,lines}),/cash funding/)
 // Floating-point addition used to lose one cent in this mixed-sign sequence.
 const huge=Number.MAX_SAFE_INTEGER
 assert.throws(()=>postExpenseFromCostLines({id:expense,date:'2026-09-20',amountCents:huge,costLines:[{amountCents:huge},{amountCents:2},{amountCents:-1}],projectionVersion:1,policyVersion:1,sourceVersion:1}),/does not equal/)
})
test('combined accounting activity authorizes access and passes one captured revision to all engines',async()=>{
 const Module=require('node:module'),original=Module._load,snapshot=fixture();let denied=false,reads=0,load;const consumed=[]
 const service={async rpc(){reads++;return {data:snapshot,error:null}}}
 try{Module._load=function(name,...args){if(name==='server-only')return {};if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>service};if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:id(99),supabase:service})};if(name==='@/lib/services/books/access')return {requireBooksAuthorization:async args=>{assert.equal(args.permission,'books.read');if(denied)throw new Error('Denied')}};const engine={'@/lib/services/books/cash-income-snapshot':'cashInvoiceIncomeFromSnapshot','@/lib/services/books/cash-cost-snapshot':'cashBillCostsFromSnapshot','@/lib/services/books/cash-expense-snapshot':'cashDirectExpensesFromSnapshot','@/lib/services/books/cash-settlement-ancillary':'cashSettlementAncillaryFromSnapshot'}[name];if(engine)return {[engine]:(orgId,start,end,data)=>{assert.equal(orgId,org);consumed.push(data);return {databaseSnapshot:data.databaseSnapshot}}};return original.call(this,name,...args)};load=require('../lib/services/books/cash-activity').buildCashAccountingActivity}finally{Module._load=original}
 denied=true;await assert.rejects(load('2026-09-01','2026-10-31'),/Denied/);assert.equal(reads,0)
 denied=false;const result=await load('2026-09-01','2026-10-31');assert.equal(reads,1);assert.equal(consumed.length,4);assert.ok(consumed.every(data=>data===snapshot));assert.equal(result.directExpenses.databaseSnapshot,'one-revision')
})

test('journal validation detects the one-cent imbalance that floating-point aggregate sums masked',()=>{
 const {assertBalancedJournalDraft}=require('../lib/services/books/types')
 const huge=Number.MAX_SAFE_INTEGER
 const lines=[{accountCode:'5000',debitCents:huge,creditCents:0},{accountCode:'6000',debitCents:2,creditCents:0},{accountCode:'1000',debitCents:0,creditCents:huge},{accountCode:'1001',debitCents:0,creditCents:1}]
 assert.equal(lines.reduce((sum,line)=>sum+line.debitCents,0),lines.reduce((sum,line)=>sum+line.creditCents,0),'the old sums incorrectly balanced')
 assert.throws(()=>assertBalancedJournalDraft({lines}),/not balanced/)
 assert.throws(()=>assertBalancedJournalDraft({lines:lines.map((line,i)=>i===3?{...line,creditCents:2}:line)}),/totals exceed safe/)
 assert.deepEqual(assertBalancedJournalDraft({lines:[lines[0],lines[2]]}),{debitCents:huge,creditCents:huge})
})
