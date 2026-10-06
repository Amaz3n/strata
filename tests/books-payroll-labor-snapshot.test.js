require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module')
const {payrollReconciliationFromSnapshot}=require('../lib/services/books/payroll-labor-snapshot')
const {laborBasisFromJobCost}=require('../lib/services/books/labor-evidence')
const {draftFromFact}=require('../lib/services/books/fact-drafts')
const id=n=>'99700000-0000-4000-8000-'+String(n).padStart(12,'0'),org=id(1)
function fixture(){
 const time={id:id(3),org_id:org,project_id:id(4),cost_code_id:id(5),worker_user_id:id(6),work_date:'2026-09-10',updated_at:'2026-09-10T11:59:00Z',status:'pm_approved',hours:'8',base_rate_cents:3000,burden_multiplier:'1.5',is_overtime:false,ot_multiplier:'1.5',is_double_time:false,dt_multiplier:'2',labor_cost_policy_version:1,cost_cents:36000}
 const cost={id:id(2),org_id:org,project_id:time.project_id,cost_code_id:time.cost_code_id,source_type:'time_entry',source_id:time.id,status:'posted',incurred_on:time.work_date,cost_cents:time.cost_cents,updated_at:'2026-09-10T12:00:00.000001Z',metadata:{...time}}
 const basis=laborBasisFromJobCost(org,cost)
 const fact={id:id(7),org_id:org,source_type:'labor_cost',source_id:cost.id,source_version:1,accounting_date:time.work_date,payload:{amount_cents:cost.cost_cents,project_id:cost.project_id,dimensions:{cost_code_id:cost.cost_code_id},labor_basis:basis}}
 const chart=[['5030','cogs','direct_labor'],['2200','liability','payroll_clearing'],['2230','liability','other_liability']].map(([code,account_type,subtype],i)=>({id:id(20+i),org_id:org,code,account_type,subtype,active:true}))
 const draft=draftFromFact({sourceType:'labor_cost',sourceId:cost.id,accountingDate:fact.accounting_date,sourceVersion:1,projectionVersion:1,policyVersion:1,payload:fact.payload})
 const journal={id:id(8),org_id:org,source_type:'labor_cost',source_id:cost.id,fact_id:fact.id,entry_date:time.work_date,status:'posted',reversal_of_entry_id:null}
 const lines=draft.lines.map((line,i)=>{const account=chart.find(row=>row.code===line.accountCode);return {id:id(30+i),org_id:org,entry_id:journal.id,account_id:account.id,project_id:line.projectId,debit_cents:line.debitCents,credit_cents:line.creditCents,dimensions:{...line.dimensions,books_account_classification:{version:1,account_id:account.id,code:account.code,account_type:account.account_type,subtype:account.subtype}}}})
 const receipt={org_id:org,source_type:'labor_cost',source_id:cost.id,fact_id:fact.id,journal_id:journal.id,source_observed_at:cost.updated_at}
 const run={id:id(9),org_id:org,provider:'Payroll register',provider_run_id:'RUN-9',period_start:'2026-09-01',period_end:'2026-09-15',accrual_date:'2026-09-15',pay_date:'2026-09-18',source_checksum:'a'.repeat(64),employees:[{worker_id:time.worker_user_id,employee_reference:'W-6',gross_cents:24000,net_cents:18000,employee_taxes_cents:5000,employee_deductions_cents:1000,employer_taxes_cents:2500,employer_benefits_cents:500,allocations:[{id:id(10),project_id:time.project_id,cost_code_id:time.cost_code_id,cost_account_code:'5030',gross_cents:24000,employer_taxes_cents:2500,employer_benefits_cents:500,labor_evidence_ids:[cost.id]}]}],controls:{gross_cents:24000,net_cents:18000,employee_taxes_cents:5000,employee_deductions_cents:1000,employer_taxes_cents:2500,employer_benefits_cents:500,funding_cents:27000}}
 const snapshot={orgId:org,capturedAt:'2026-09-15T12:00:00Z',databaseSnapshot:'100:101:',tables:{time_entries:[time],job_cost_entries:[cost],accounting_facts:[fact],journal_entries:[journal],journal_lines:lines,books_projection_receipts:[receipt],gl_accounts:chart}}
 return {run,snapshot,time,cost,basis,fact,journal,lines,receipt,chart}
}
const reconcile=f=>payrollReconciliationFromSnapshot(org,f.run,f.snapshot)
test('native labor accrual preview also exposes already-recorded withholding instead of treating wages as automatically unpaid',()=>{
 const f=fixture()
 f.snapshot.tables.journal_entries.push({id:id(70),org_id:org,source_type:'payroll_settlement',source_id:null,entry_date:'2026-09-18',status:'posted',reversal_of_entry_id:null})
 for(const [index,code,debit,credit] of [[0,'2200',6000,0],[1,'2230',0,6000]]){
  const account=f.chart.find(row=>row.code===code)
  f.snapshot.tables.journal_lines.push({id:id(71+index),org_id:org,entry_id:id(70),account_id:account.id,project_id:null,debit_cents:debit,credit_cents:credit,dimensions:{payment_reference:'Previous withholding reclassification'}})
 }
 const result=reconcile(f)
 assert.equal(result.recognizedGrossCents,24000)
 assert.equal(result.liabilityHistory.requiresSettlementAttribution,true)
 assert.equal(result.liabilityHistory.organizationWagesMovementCents,-6000)
 assert.equal(result.liabilityHistory.organizationDeductionsMovementCents,6000)
 assert.equal(result.liabilityHistory.unpaidStatusProven,false)
})
test('one snapshot reconciles original wages and replaces estimated burden without duplicating payroll cost',()=>{
 const f=fixture(),result=reconcile(f)
 assert.equal(result.recognizedGrossCents,24000);assert.equal(result.estimatedBurdenCents,12000)
 assert.equal(result.costVarianceCents,-9000);assert.equal(result.wageVarianceCents,0)
 assert.equal(result.laborEvidence[0].source_revision,f.basis.source_revision)
 assert.equal(result.databaseSnapshot,'100:101:');assert.equal(result.previewOnly,true);assert.equal(result.providerSourceVerified,false)
 assert.equal(result.draft.lines.filter(row=>row.accountCode==='5030').reduce((n,row)=>n+row.debitCents-row.creditCents,0),-9000)
 assert.equal(result.constructionImpact.projectCostDeltaCents,-9000)
 assert.equal(result.constructionImpact.allocations[0].sourceJobCostIds[0],f.cost.id)
 assert.ok(result.constructionImpact.allocations[0].blockers.includes('missing_budget_lines'))
 assert.equal(result.constructionImpact.postingImplemented,false)
 assert.equal(result.liabilityHistory.requiresSettlementAttribution,false)
 assert.equal(result.liabilityHistory.unpaidStatusProven,false)
})
test('original capture survives note-only revisions; mutable time cannot fabricate wage or worker evidence',()=>{
 const f=fixture();f.cost.updated_at='2026-09-11T12:00:00.000002Z';f.receipt.source_observed_at=f.cost.updated_at
 f.time.updated_at=f.cost.updated_at;f.time.worker_name='Updated display name'
 assert.equal(reconcile(f).laborEvidence[0].source_revision,f.basis.source_revision)
 for(const mutate of [f=>delete f.fact.payload.labor_basis,f=>f.time.worker_user_id=id(99),f=>f.time.base_rate_cents=3001,f=>f.time.work_date='2026-08-31',f=>f.cost.metadata.hours='9',f=>f.cost.cost_cents++,f=>f.time.status='submitted']){
  const fresh=fixture();mutate(fresh);assert.throws(()=>reconcile(fresh),/evidence|differ|approval|posting/)
 }
})
test('missing, stale, foreign, duplicate and unposted accounting evidence fail closed',()=>{
 for(const mutate of [f=>delete f.snapshot.tables.time_entries,f=>f.snapshot.orgId=id(99),f=>f.run.org_id=id(99),f=>f.chart[0].org_id=id(99),f=>f.snapshot.tables.books_projection_receipts=[],f=>f.receipt.source_observed_at='2026-09-10T12:00:00Z',f=>f.journal.status='draft',f=>f.receipt.fact_id=id(99),f=>f.journal.fact_id=id(99),f=>f.cost.status='voided',f=>f.snapshot.tables.job_cost_entries=[],f=>f.snapshot.tables.journal_entries.push({...f.journal}),f=>f.snapshot.tables.books_projection_receipts.push({...f.receipt})]){
  const fresh=fixture();mutate(fresh);assert.throws(()=>reconcile(fresh))
 }
})
test('time and posted-ledger completeness cannot be bypassed by omitting labor IDs or deleting a source',()=>{
 for(const mutate of [f=>f.snapshot.tables.time_entries.push({...f.time,id:id(40)}),f=>f.run.employees[0].allocations[0].labor_evidence_ids=[],f=>f.snapshot.tables.job_cost_entries=[],f=>f.snapshot.tables.accounting_facts=[],f=>f.snapshot.tables.time_entries.push({...f.time,id:id(40),worker_user_id:null}),f=>f.cost.metadata.worker_user_id=null]){
  const fresh=fixture();mutate(fresh);assert.throws(()=>reconcile(fresh),/missing|unassigned|source|orphan|attribution|evidence|posting/)
 }
 const other=fixture();other.snapshot.tables.time_entries.push({...other.time,id:id(40),worker_user_id:id(99),status:'draft'})
 assert.equal(reconcile(other).recognizedGrossCents,24000,'known unrelated worker drafts do not block this run')
})
test('journal amount, dimensions and frozen classifications must match original evidence exactly',()=>{
 for(const mutate of [f=>f.lines.pop(),f=>f.lines[0].debit_cents++,f=>f.lines[1].credit_cents++,f=>f.lines[0].project_id=id(99),f=>f.lines[0].dimensions.cost_code_id=id(99),f=>f.lines[0].dimensions.labor_worker_id=id(99),f=>f.lines[0].dimensions.labor_basis_hash='0'.repeat(64),f=>delete f.lines[0].dimensions.books_account_classification,f=>f.lines[0].dimensions.books_account_classification.account_id=id(99),f=>f.lines[0].dimensions.books_account_classification.account_type='income',f=>f.lines[0].dimensions.books_account_classification.legacy_unknown=true,f=>f.fact.payload.dimensions.cost_code_id=null]){
  const fresh=fixture();mutate(fresh);assert.throws(()=>reconcile(fresh))
 }
 const f=fixture();f.chart[0].name='Renamed cost account';assert.equal(reconcile(f).recognizedGrossCents,24000)
})
test('construction inventory and custom cost accounts preserve original posted classification',()=>{
 for(const [code,type,subtype] of [['1160','asset','work_in_progress'],['LAB-05030','cogs','direct_labor']]){
  const f=fixture();f.chart[0].code=code;f.chart[0].account_type=type;f.chart[0].subtype=subtype
  f.fact.payload.cost_account_code=code;f.run.employees[0].allocations[0].cost_account_code=code
  Object.assign(f.lines[0].dimensions.books_account_classification,{code,account_type:type,subtype})
  const result=reconcile(f);assert.equal(result.laborEvidence[0].account_code,code)
  assert.equal(result.draft.lines.filter(row=>row.accountCode===code).reduce((n,row)=>n+row.debitCents-row.creditCents,0),-9000)
 }
 const f=fixture();f.time.cost_code_id=null;f.cost.cost_code_id=null;f.fact.payload.dimensions={}
 f.basis=laborBasisFromJobCost(org,f.cost);f.fact.payload.labor_basis=f.basis
 const {booksDigest}=require('../lib/services/books/hash')
 for(const line of f.lines){delete line.dimensions.cost_code_id;line.dimensions.labor_basis_hash=booksDigest(f.basis)}
 f.run.employees[0].allocations[0].cost_code_id=null
 assert.equal(reconcile(f).laborEvidence[0].cost_code_id,null)
})
test('reversed or revised history needs reviewed attribution and latest fact ownership',()=>{
 for(const mutate of [f=>f.snapshot.tables.journal_entries.push({...f.journal,id:id(40),status:'reversed'}),f=>f.snapshot.tables.accounting_facts.push({...f.fact,id:id(40),source_version:2}),f=>f.journal.reversal_of_entry_id=id(40),f=>f.fact.payload.labor_basis.source_revision='2026-09-11T12:00:00Z']){
  const fresh=fixture();mutate(fresh);assert.throws(()=>reconcile(fresh),/historical|latest|posting|revision|identity/)
 }
})
let calls=[],denied=false,serviceFixture=fixture(),rpcError=null,preview
const original=Module._load
try{
 Module._load=function(name,...args){
  if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:id(50),supabase:{}})}
  if(name==='./access')return {requireBooksAuthorization:async input=>{calls.push(['auth',input.permission,input.orgId]);if(denied)throw new Error('Denied')}}
  if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>({rpc:async(name,args)=>{calls.push(['rpc',name,args]);return {data:serviceFixture.snapshot,error:rpcError}}})}
  return original.call(this,name,...args)
 }
 preview=require('../lib/services/books/payroll-preview').previewPayrollReconciliation
}finally{Module._load=original}
test('actual server preview authorizes before a single scoped snapshot and rejects caller supplied labor evidence',async()=>{
 calls=[];denied=true;await assert.rejects(preview(serviceFixture.run),/Denied/);assert.equal(calls.length,1);denied=false
 calls=[];await assert.rejects(preview({...serviceFixture.run,org_id:id(99)}),/organization/);assert.equal(calls.length,1)
 calls=[];await assert.rejects(preview({...serviceFixture.run,laborEvidence:[]}),/Unrecognized/);assert.equal(calls.length,1)
 calls=[];const result=await preview(serviceFixture.run);assert.equal(result.recognizedGrossCents,24000)
 assert.deepEqual(calls,[['auth','books.adjust',org],['rpc','capture_books_export_snapshot',{p_org_id:org}]])
 rpcError={message:'Snapshot failed'};await assert.rejects(preview(serviceFixture.run),/Snapshot failed/);rpcError=null
})

test('actual snapshot RPC feeds the loader with complete scoped rows and preserves statement visibility',async t=>{
 const {PGlite}=require('@electric-sql/pglite')
 const {installBooksExportSnapshot}=require('./fixtures/books-export-snapshot-database')
 const {EXPORT_TABLES}=require('../lib/services/books/export-contract')
 const db=new PGlite();t.after(()=>db.close());const f=fixture()
 await db.exec('create role anon;create role authenticated;create role service_role;')
 f.receipt.id=id(60)
 for(const name of EXPORT_TABLES){
  const records=f.snapshot.tables[name]??[],example=records[0]??{id:id(90),org_id:org}
  const columns=Object.entries(example).map(([key,value])=>`"${key}" ${['id','org_id'].includes(key)?'uuid':typeof value==='number'?'bigint':typeof value==='boolean'?'boolean':value&&typeof value==='object'?'jsonb':'text'}`)
  await db.exec(`create table public.${name}(${columns.join(',')})`)
  for(const record of records){
   const keys=Object.keys(record),values=Object.values(record).map(value=>value&&typeof value==='object'?JSON.stringify(value):value)
   await db.query(`insert into ${name}(${keys.map(key=>`"${key}"`).join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,values)
  }
 }
 await db.query('insert into time_entries select $1,$2,project_id,cost_code_id,worker_user_id,work_date,updated_at,status,hours,base_rate_cents,burden_multiplier,is_overtime,ot_multiplier,is_double_time,dt_multiplier,labor_cost_policy_version,cost_cents from time_entries',[id(99),id(98)])
 await installBooksExportSnapshot(db)
 const capture=async()=> (await db.query('select capture_books_export_snapshot($1::uuid) snapshot',[org])).rows[0].snapshot
 const original=await capture();assert.equal(original.tables.time_entries.length,1)
 assert.equal(payrollReconciliationFromSnapshot(org,f.run,original).recognizedGrossCents,24000)
 const during=(await db.query('with changed as (update time_entries set cost_cents=36001 where org_id=$1 returning id) select capture_books_export_snapshot($1::uuid) snapshot from changed',[org])).rows[0].snapshot
 assert.equal(payrollReconciliationFromSnapshot(org,f.run,during).recognizedGrossCents,24000,'calling statement retains original labor visibility')
 const next=await capture();assert.throws(()=>payrollReconciliationFromSnapshot(org,f.run,next),/differ/)
})

test('uppercase worker UUID input canonicalizes before source selection and cannot hide already posted wages',()=>{
 const f=fixture(),worker='abcdefab-0000-4000-8000-000000000006'
 f.time.worker_user_id=worker;f.cost.metadata.worker_user_id=worker;f.basis.worker_id=worker
 f.run.employees[0].worker_id=worker.toUpperCase()
 const {booksDigest}=require('../lib/services/books/hash')
 for(const line of f.lines){line.dimensions.labor_worker_id=worker;line.dimensions.labor_basis_hash=booksDigest(f.basis)}
 const result=reconcile(f);assert.equal(result.recognizedGrossCents,24000);assert.equal(result.run.employees[0].worker_id,worker)
})

test('worker selection discovers exactly the same original labor without inventing payroll allocations',()=>{
 const {payrollNativeLaborSelection}=require('../lib/services/books/payroll-labor-snapshot');
 const f=fixture(),selection={workerIds:[f.run.employees[0].worker_id],periodStart:f.run.period_start,periodEnd:f.run.period_end};
 const selected=payrollNativeLaborSelection(org,selection,f.snapshot);
 assert.deepEqual(selected.labor,reconcile(f).laborEvidence);
 assert.equal(selected.labor[0].gross_cents,24000);assert.equal(selected.labor[0].estimated_burden_cents,12000);
 assert.ok(!('allocations' in selected));assert.ok(!('draft' in selected));
 for(const changed of [{...selection,workerIds:[...selection.workerIds,...selection.workerIds]},{...selection,periodStart:'2026-09-16'},{...selection,workerIds:[]}])assert.throws(()=>payrollNativeLaborSelection(org,changed,f.snapshot));
 for(const mutate of [f=>f.time.status='submitted',f=>f.cost.cost_cents++,f=>f.receipt.source_observed_at='2026-09-01T00:00:00Z',f=>f.snapshot.tables.journal_lines.pop(),f=>f.snapshot.tables.job_cost_entries=[]]){const bad=fixture();mutate(bad);assert.throws(()=>payrollNativeLaborSelection(org,selection,bad.snapshot));}
});
