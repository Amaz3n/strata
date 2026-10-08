require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {cashProfitAndLossFromSnapshot:build}=require('../lib/services/books/cash-profit-loss')
const {org,fixture,unsupported,classification}=require('./support/books-cash-profit-loss-fixture')
const run=snapshot=>build(org,'2026-09-01','2026-09-30',snapshot)
test('cash P&L uses native paid classifications, business dimensions, exact totals and source evidence',()=>{
 const snapshot=fixture(),result=run(snapshot)
 assert.equal(result.cogsCents,2);assert.equal(result.expenseCents,1);assert.equal(result.netIncomeCents,-3);assert.equal(result.netCashMovementCents,-3);assert.equal(result.paidPurchasePrincipalCents,3)
 assert.equal(result.salesTaxCollectedCents,0);assert.equal(result.capitalizedPurchasesCents,0);assert.equal(result.databaseSnapshot,'one-revision')
 assert.equal(result.rows[0].projectName,'Native construction job');assert.equal(result.rows[0].dimensions.books_account_classification,undefined)
 assert.equal(result.evidence[0].documentId,'purchase');assert.equal(result.evidence[0].entryId,'entry')
 assert.equal(result.evidence[0].dimensions.books_account_classification.version,1)
 snapshot.tables.gl_accounts[0].account_type='expense';snapshot.tables.gl_accounts[0].code='6999';snapshot.tables.gl_accounts[2].subtype='other_asset';assert.equal(run(snapshot).cogsCents,2)
})
test('unsupported current or opening income/clearing history blocks publication, but later activity does not',()=>{
 for(const date of ['2026-09-21','2026-08-01']){const snapshot=fixture();unsupported(snapshot,{date});assert.throws(()=>run(snapshot),/cannot classify.*manual:source/)}
 const future=fixture();unsupported(future,{date:'2026-10-01'});assert.equal(run(future).netIncomeCents,-3)
 const payroll=fixture();unsupported(payroll,{source:'payroll_settlement'});assert.throws(()=>run(payroll),/payroll_settlement/)
})
test('noncash revenue recognition is excluded only with complete balanced classified evidence and no cash leg',()=>{
 const snapshot=fixture();unsupported(snapshot,{source:'revenue_recognition',cash:false});assert.equal(run(snapshot).revenueCents,0)
 snapshot.tables.journal_lines.at(-1).dimensions.books_account_classification.subtype='cash';assert.throws(()=>run(snapshot),/cannot classify/)
 const unbalanced=fixture();unsupported(unbalanced,{source:'revenue_recognition',cash:false});unbalanced.tables.journal_lines.at(-1).debit_cents=99;assert.throws(()=>run(unbalanced),/balanced|imbalance/i)
 const mislabeled=fixture();unsupported(mislabeled,{source:'revenue_recognition',cash:false});mislabeled.tables.journal_entries.at(-1).entry_kind='adjustment';assert.throws(()=>run(mislabeled),/cannot classify/)
 const missing=fixture();unsupported(missing,{cash:false});delete missing.tables.journal_lines.at(-1).dimensions.books_account_classification;assert.throws(()=>run(missing),/historical account classification/)
})
test('a bank categorization or manual journal settled only in cash counts on its date; any other leg still needs review',()=>{
 for(const source of ['bank_transaction','manual_adjustment']){const snapshot=fixture();unsupported(snapshot,{source});snapshot.tables.journal_entries.at(-1).entry_kind='adjusting'
  const result=run(snapshot);assert.equal(result.revenueCents,100);assert.equal(result.netIncomeCents,97);assert.equal(result.evidence.at(-1).source,'direct_cash_entry')}
 const accrual=fixture();unsupported(accrual,{source:'manual_adjustment',cash:false});accrual.tables.journal_entries.at(-1).entry_kind='adjusting';assert.throws(()=>run(accrual),/cannot classify/)
 const earlier=fixture();unsupported(earlier,{source:'bank_transaction',date:'2026-08-01'});earlier.tables.journal_entries.at(-1).entry_kind='adjusting';assert.equal(run(earlier).revenueCents,0)
})
test('a cost allocation moves no cash, so cash basis keeps the cost where it was paid',()=>{
 const snapshot=fixture();unsupported(snapshot,{source:'cost_allocation',cash:false});snapshot.tables.journal_entries.at(-1).entry_kind='adjusting'
 assert.equal(run(snapshot).netIncomeCents,-3)
 const withCash=fixture();unsupported(withCash,{source:'cost_allocation',cash:true});withCash.tables.journal_entries.at(-1).entry_kind='adjusting';assert.throws(()=>run(withCash),/cannot classify/)
})
test('an unexpected cash leg under an accrual source cannot bypass the cash movement reconciliation',()=>{
 const snapshot=fixture();unsupported(snapshot,{source:'invoice',cash:true});assert.throws(()=>run(snapshot),/does not reconcile to posted cash movements/)
})
test('incomplete, foreign, stale and duplicated source evidence cannot become a cash P&L',()=>{
 const missing=fixture();missing.tables.books_projection_receipts=[];assert.throws(()=>run(missing),/Refresh/)
 const foreign=fixture();foreign.tables.project_expenses[0].org_id='foreign';assert.throws(()=>run(foreign),/foreign organization/)
 const stale=fixture();stale.tables.project_expenses[0].updated_at='2026-09-20T12:00:01Z';assert.throws(()=>run(stale),/Refresh/)
 const duplicate=fixture();duplicate.tables.journal_entries.push({...duplicate.tables.journal_entries[0]});assert.throws(()=>run(duplicate),/Duplicate/)
 assert.throws(()=>build(org,'2026-09-30','2026-09-01',fixture()),/date|reversed/)
})
test('cash P&L service checks organization-wide Books authorization before exactly one snapshot RPC',async()=>{
 const Module=require('node:module'),original=Module._load;let denied=false,reads=0
 const client={async rpc(name,args){assert.equal(name,'capture_books_export_snapshot');assert.equal(args.p_org_id,org);reads++;return {data:fixture(),error:null}}}
 let load
 try{Module._load=function(name,...args){if(name==='server-only')return {};if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>client};if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:'user',supabase:client})};if(name==='@/lib/services/books/access')return {requireBooksAuthorization:async input=>{assert.equal(input.permission,'books.read');assert.equal(input.resourceType,'cash_profit_loss');if(denied)throw new Error('Denied')}};return original.call(this,name,...args)};load=require('../lib/services/books/cash-activity').buildCashProfitAndLoss}finally{Module._load=original}
 denied=true;await assert.rejects(load('2026-09-01','2026-09-30'),/Denied/);assert.equal(reads,0)
 denied=false;assert.equal((await load('2026-09-01','2026-09-30')).netIncomeCents,-3);assert.equal(reads,1)
})
test('loans, transfers and equipment are bridged to cash; depreciation is listed, not deducted',()=>{
 const snapshot=fixture(),t=snapshot.tables
 const accounts={cash:['1000','asset','cash'],savings:['1001','asset','cash'],loan:['2500','liability','long_term_debt'],interest:['6060','expense','interest'],truck:['1500','asset','fixed_assets'],accum:['1590','asset','accumulated_depreciation'],dep:['6080','expense','depreciation'],accrued:['2220','liability','other_liability']}
 for(const [id,[code,type,subtype]] of Object.entries(accounts))t.gl_accounts.push({id,org_id:org,code,account_type:type,subtype,normal_balance:['asset','expense'].includes(type)?'debit':'credit'})
 const entry=(id,source,lines)=>{t.journal_entries.push({id,org_id:org,fact_id:null,source_type:source,source_id:id,status:'posted',entry_kind:'operational',entry_date:'2026-09-15',reversal_of_entry_id:null})
  lines.forEach(([account,debit,credit],i)=>{const [code,type,subtype]=accounts[account];t.journal_lines.push({id:`${id}:${i}`,org_id:org,entry_id:id,account_id:account,line_no:i+1,debit_cents:debit,credit_cents:credit,dimensions:{books_account_classification:classification(account,code,type,subtype)}})})}
 entry('draw','books_debt_instrument',[['cash',10000,0],['loan',0,10000]])
 entry('repay','books_debt_instrument',[['loan',900,0],['interest',100,0],['cash',0,1000]])
 entry('move','bank_transaction',[['savings',500,0],['cash',0,500]])
 entry('buy','books_fixed_asset',[['truck',3600,0],['cash',0,3600]])
 entry('depreciate','books_fixed_asset',[['dep',100,0],['accum',0,100]])
 const result=run(snapshot)
 assert.deepEqual(result.bridge.map(row=>[row.category,row.amountCents]),[['transfer',0],['loan',9100],['fixed_assets',-3600]])
 assert.deepEqual(result.bookOnly,[{sourceType:'books_fixed_asset',accountCode:'6080',kind:'expense',amountCents:100}])
 assert.equal(result.expenseCents,101);assert.equal(result.netCashMovementCents,-3+10000-1000-3600)
 entry('accrual-paid','payroll_settlement',[['accrued',700,0],['cash',0,700]])
 assert.throws(()=>run(snapshot),/cannot classify payroll_settlement:accrual-paid/)
})
