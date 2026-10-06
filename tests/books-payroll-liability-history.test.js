require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {PGlite}=require('@electric-sql/pglite')
const {fixture,id,org}=require('./helpers/books-payroll-register-fixture')
const {payrollLiabilityHistory}=require('../lib/services/books/payroll-liability-history')
const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261003214553_books_payroll_liability_history.sql'),'utf8')
const original=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261003203019_books_payroll_import_drafts.sql'),'utf8')
const originalFunction=original.slice(original.indexOf('create function public.books_payroll_source_revision('),original.indexOf('\ncreate function public.capture_books_payroll_context'))
function scenario(){
 const accounts=[...fixture().postingAccounts,{id:id(40),org_id:org,code:'1000',account_type:'asset',subtype:'cash',active:true}]
 const entry={id:id(41),org_id:org,status:'posted',source_type:'payroll_settlement',source_id:null,entry_date:'2026-09-18',reversal_of_entry_id:null,posting_key:'clearing_settlement:2200:provider-payment'}
 const lines=[['2200',24000,0],['1000',0,18000],['2230',0,6000]].map(([code,debit_cents,credit_cents],i)=>{
  const account=accounts.find(row=>row.code===code)
  return {id:id(42+i),org_id:org,entry_id:entry.id,account_id:account.id,project_id:null,debit_cents,credit_cents,dimensions:{books_account_classification:{version:1,account_id:account.id,code,account_type:account.account_type,subtype:account.subtype},payment_reference:'Provider payment',evidence_url:'https://example.com/original'}}
 })
 return {entry,lines,accounts,tables:{time_entries:[],job_cost_entries:[],accounting_facts:[],journal_entries:[entry],journal_lines:lines,books_projection_receipts:[],gl_accounts:accounts}}
}
test('manual payroll settlement preserves gross clearing debit, withholding reclassification and cash evidence as unassigned history',()=>{
 const f=scenario(),before=JSON.stringify(f),history=payrollLiabilityHistory(org,f.tables)
 assert.equal(history.organizationWagesMovementCents,-24000);assert.equal(history.organizationDeductionsMovementCents,6000)
 assert.equal(history.movements.length,1);assert.equal(history.movements[0].lines.length,3)
 assert.equal(history.movements[0].lines.find(row=>row.accountCode==='1000').credit_cents,18000)
 assert.equal(history.requiresSettlementAttribution,true);assert.equal(history.unpaidStatusProven,false)
 assert.equal(history.movements[0].requiresAttribution,true);assert.equal(history.previewOnly,true)
 assert.equal(JSON.stringify(f),before)
})
test('outside-period/future payments and claimed worker/run dimensions cannot be presumed unrelated or already owned',()=>{
 const f=scenario();f.entry.entry_date='2027-01-01';f.entry.source_type='manual_adjustment';f.entry.source_id=id(90)
 for(const line of f.lines){line.project_id=id(90);Object.assign(line.dimensions,{payroll_run_id:id(90),payroll_worker_id:id(90)})}
 assert.equal(payrollLiabilityHistory(org,f.tables).requiresSettlementAttribution,true)
 f.entry.entry_date='2020-01-01';assert.equal(payrollLiabilityHistory(org,f.tables).movements.length,1)
})
test('original and reversal remain visible even at zero net liability movement; draft and native labor journals are excluded',()=>{
 const f=scenario();f.entry.status='reversed'
 f.tables.journal_entries.push({...f.entry,id:id(50),status:'posted',reversal_of_entry_id:f.entry.id})
 f.tables.journal_lines.push(...f.lines.map((line,i)=>({...line,id:id(51+i),entry_id:id(50),debit_cents:line.credit_cents,credit_cents:line.debit_cents})))
 const history=payrollLiabilityHistory(org,f.tables)
 assert.equal(history.movements.length,2);assert.equal(history.organizationWagesMovementCents,0);assert.equal(history.organizationDeductionsMovementCents,0)
 assert.equal(history.requiresSettlementAttribution,true)
 for(const entry of f.tables.journal_entries)entry.source_type='labor_cost'
 assert.equal(payrollLiabilityHistory(org,f.tables).movements.length,0)
 f.entry.source_type='payroll_settlement';f.entry.status='draft';assert.equal(payrollLiabilityHistory(org,f.tables).movements.length,0)
})
test('frozen journal classification supplies historical liability identity; missing classification is explicitly unclassified',()=>{
 const f=scenario();f.accounts.find(row=>row.code==='2200').code='OLD-2200'
 let history=payrollLiabilityHistory(org,f.tables);assert.equal(history.organizationWagesMovementCents,-24000)
 assert.equal(history.movements[0].lines[0].classificationSource,'original_journal')
 f.accounts.find(row=>row.code==='OLD-2200').code='2200'
 for(const line of f.lines)delete line.dimensions.books_account_classification
 history=payrollLiabilityHistory(org,f.tables);assert.equal(history.organizationWagesMovementCents,-24000)
 assert.ok(history.movements[0].lines.every(row=>row.classificationSource==='current_chart_unclassified'))
})
test('unbalanced, orphan, wrong-account, foreign and unsafe liability history cannot be accepted',()=>{
 for(const mutate of [f=>f.lines[0].debit_cents++,f=>f.lines[0].entry_id=id(90),f=>f.lines[0].org_id=id(90),
  f=>f.lines[0].dimensions.books_account_classification.account_id=id(90),f=>f.lines[0].dimensions.books_account_classification.account_type='expense',
  f=>f.lines[0].debit_cents=Number.MAX_SAFE_INTEGER+1,f=>delete f.tables.journal_lines,
  f=>f.tables.journal_entries.push({...f.entry}),f=>f.tables.journal_lines.push({...f.lines[0]}),f=>f.tables.gl_accounts.push({...f.accounts[0]})]){
  const f=scenario();mutate(f);assert.throws(()=>payrollLiabilityHistory(org,f.tables))
 }
})
test('empty/native-only history cannot prove unpaid wages; evidence order is stable and source reference changes the digest',()=>{
 const f=scenario(),first=payrollLiabilityHistory(org,f.tables)
 f.tables.journal_lines.reverse();assert.equal(payrollLiabilityHistory(org,f.tables).digest,first.digest)
 f.lines[0].dimensions.payment_reference='Changed payment reference';assert.notEqual(payrollLiabilityHistory(org,f.tables).digest,first.digest)
 f.tables.journal_entries=[];f.tables.journal_lines=[]
 const empty=payrollLiabilityHistory(org,f.tables);assert.equal(empty.requiresSettlementAttribution,false);assert.equal(empty.unpaidStatusProven,false)
})
async function sql(t){
 const db=new PGlite();t.after(()=>db.close());await db.exec('create role anon;create role authenticated;create role service_role;')
 await db.exec(originalFunction)
 return db
}
const snapshot=f=>({orgId:org,tables:f.tables})
const revision=async(db,f,name='books_payroll_source_revision')=>(await db.query(`select public.${name}($1::jsonb,$2::jsonb) revision`,[JSON.stringify(snapshot(f)),JSON.stringify(fixture().run)])).rows[0].revision
test('actual SQL migration retains function identity and invalidates a previously compiled caller with widened liability history',async t=>{
 const db=await sql(t),f=scenario(),old=await revision(db,f)
 const oid=(await db.query("select 'public.books_payroll_source_revision(jsonb,jsonb)'::regprocedure::oid oid")).rows[0].oid
 await db.exec("create function cached_payroll_revision(snapshot jsonb,run jsonb) returns text language plpgsql as $$ begin return public.books_payroll_source_revision(snapshot,run); end $$;")
 assert.equal((await db.query('select cached_payroll_revision($1::jsonb,$2::jsonb) revision',[JSON.stringify(snapshot(f)),JSON.stringify(fixture().run)])).rows[0].revision,old)
 await db.exec(migration)
 assert.equal((await db.query("select 'public.books_payroll_source_revision(jsonb,jsonb)'::regprocedure::oid oid")).rows[0].oid,oid)
 const current=await revision(db,f);assert.notEqual(current,old)
 assert.equal((await db.query('select cached_payroll_revision($1::jsonb,$2::jsonb) revision',[JSON.stringify(snapshot(f)),JSON.stringify(fixture().run)])).rows[0].revision,current)
})
test('SQL dependency vector includes original/reversal, cash proof and outside-period/frozen-classification payments; ordinary cash/drafts stay unrelated',async t=>{
 const db=await sql(t);await db.exec(migration)
 const f=scenario(),base=await revision(db,f)
 for(const mutate of [f=>f.lines[1].credit_cents++,f=>f.lines[0].dimensions.evidence_url='https://example.com/changed',f=>f.entry.entry_date='2027-01-01',f=>f.entry.status='reversed',f=>f.entry.reversal_of_entry_id=id(90)]){
  const changed=scenario();mutate(changed);assert.notEqual(await revision(db,changed),base)
 }
 f.tables.journal_entries.push({...f.entry,id:id(60),source_type:'bank_transaction'})
 f.tables.journal_lines.push({...f.lines[1],id:id(61),entry_id:id(60)})
 assert.equal(await revision(db,f),base,'ordinary cash journal does not stale payroll')
 f.tables.journal_entries[1].source_type='manual_adjustment';f.tables.journal_entries[1].status='draft'
 f.tables.journal_lines.push({...f.lines[0],id:id(62),entry_id:id(60)})
 assert.equal(await revision(db,f),base,'unposted adjustment does not participate')
 f.tables.journal_entries[1].status='posted';assert.notEqual(await revision(db,f),base)
 const frozen=scenario();frozen.accounts.find(row=>row.code==='2200').code='OLD-2200'
 const before=await revision(db,frozen);frozen.lines[0].debit_cents++;assert.notEqual(await revision(db,frozen),before)
})
test('new liability-vector functions remain service-only and scoped to the requested organization',async t=>{
 const db=await sql(t);await db.exec(migration)
 const flags=(await db.query("select has_function_privilege('authenticated','books_payroll_source_revision(jsonb,jsonb)','execute') browser,has_function_privilege('anon','books_payroll_labor_source_revision(jsonb,jsonb)','execute') anon,has_function_privilege('service_role','books_payroll_source_revision(jsonb,jsonb)','execute') service")).rows[0]
 assert.deepEqual(flags,{browser:false,anon:false,service:true})
 const f=scenario();f.lines[0].org_id=id(90);await assert.rejects(revision(db,f),/Foreign payroll/)
})
