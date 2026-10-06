require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {cashProfitAndLossFromSnapshot:build}=require('../lib/services/books/cash-profit-loss')
const {org,fixture,unsupported}=require('./support/books-cash-profit-loss-fixture')
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
 for(const date of ['2026-09-21','2026-08-01']){const snapshot=fixture();unsupported(snapshot,{date});assert.throws(()=>run(snapshot),/reviewed cash treatment.*manual:source/)}
 const future=fixture();unsupported(future,{date:'2026-10-01'});assert.equal(run(future).netIncomeCents,-3)
 const payroll=fixture();unsupported(payroll,{source:'payroll_settlement'});assert.throws(()=>run(payroll),/payroll_settlement/)
})
test('noncash revenue recognition is excluded only with complete balanced classified evidence and no cash leg',()=>{
 const snapshot=fixture();unsupported(snapshot,{source:'revenue_recognition',cash:false});assert.equal(run(snapshot).revenueCents,0)
 snapshot.tables.journal_lines.at(-1).dimensions.books_account_classification.subtype='cash';assert.throws(()=>run(snapshot),/reviewed cash treatment/)
 const unbalanced=fixture();unsupported(unbalanced,{source:'revenue_recognition',cash:false});unbalanced.tables.journal_lines.at(-1).debit_cents=99;assert.throws(()=>run(unbalanced),/balanced|imbalance/i)
 const mislabeled=fixture();unsupported(mislabeled,{source:'revenue_recognition',cash:false});mislabeled.tables.journal_entries.at(-1).entry_kind='adjustment';assert.throws(()=>run(mislabeled),/reviewed cash treatment/)
 const missing=fixture();unsupported(missing,{cash:false});delete missing.tables.journal_lines.at(-1).dimensions.books_account_classification;assert.throws(()=>run(missing),/historical account classification/)
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
