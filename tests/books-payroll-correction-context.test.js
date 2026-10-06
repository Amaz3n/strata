require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {sourceFixture,prepareSource,reviewSource}=require('./helpers/books-payroll-correction-source-fixture'),{capture}=require('./helpers/books-payroll-workflow-fixture'),{id,org}=require('./helpers/books-payroll-register-fixture')
const {payrollCorrectionPlan}=require('../lib/services/books/payroll-correction-plan')
const read=name=>fs.readFileSync(path.join(__dirname,'../supabase/migrations',name),'utf8')
async function ready(t,options={},mutate){const f=await sourceFixture(t,options);await f.db.exec(read('20261004021236_books_payroll_correction_math.sql'));await f.db.exec(read('20261004022226_books_payroll_correction_context.sql'));if(mutate)mutate(f.evidence);await prepareSource(f);await reviewSource(f);return f}
const context=f=>f.db.query('select lock_books_payroll_correction_context($1,$2) result',[org,id(700)]).then(r=>r.rows[0].result)
test('SQL freezes complete correction construction/liability context and matches independent project/worker preview',async t=>{
 const f=await ready(t),tables=(await capture(f.db)).tables,plan=payrollCorrectionPlan({request:f.evidence.request,correctedRun:f.evidence.run,tables}),actual=await context(f)
 assert.equal(actual.orgId,org);assert.equal(actual.sourceId,id(700));assert.equal(actual.originalPostingId,id(260));assert.equal(actual.sourceHash,tables.books_payroll_correction_sources[0].evidence_hash)
 for(const key of ['projectCosts','workers','remainingBeforeAdditionalAttribution','blockers','requiresConstructionReview','preservedBillableCostIds'])assert.deepEqual(actual[key],plan[key],key)
 for(const key of Object.keys(actual.math))assert.deepEqual(actual.math[key],plan[key],key)
 assert.equal(actual.contextHash.length,64);assert.equal(actual.context.billable_costs[0].billable_cents,tables.billable_costs[0].billable_cents)
 assert.equal(actual.context.budget_lines[0].id,id(84));assert.equal(actual.postingImplemented,false);assert.equal(actual.locksHeldUntilTransactionEnd,true)
 assert.deepEqual((await capture(f.db)).tables,tables)
 const acl=(await f.db.query("select has_function_privilege('authenticated','lock_books_payroll_correction_context(uuid,uuid)','execute') exposed,prosecdef definer from pg_proc where proname='lock_books_payroll_correction_context'")).rows[0];assert.deepEqual(acl,{exposed:false,definer:false})
})
test('changed budget/GMP/billing and period evidence changes complete context while preserving customer rates',async t=>{
 const f=await ready(t),original=await context(f),tables=(await capture(f.db)).tables
 await f.db.query('update budget_lines set cost_code_id=null where id=$1',[id(84)])
 let next=await context(f);assert.notEqual(next.contextHash,original.contextHash);assert.ok(next.projectCosts[0].blockers.includes('review_changed_budget_scope'))
 await f.db.query("update billable_costs set metadata=jsonb_set(metadata,'{billing_method}','\"cost_plus_markup\"') where id=$1",[id(86)])
 next=await context(f);assert.ok(next.projectCosts[0].blockers.includes('review_changed_customer_billing_basis'));assert.equal(next.math.customerAmountDeltaCents,0);assert.equal(next.requiresConstructionReview,true)
 await f.db.query("update accounting_periods set status='closed' where id=$1",[id(250)])
 next=await context(f);assert.ok(next.blockers.includes('correction_date_requires_one_open_period'))
 assert.deepEqual(next.projectCosts,payrollCorrectionPlan({request:f.evidence.request,correctedRun:f.evidence.run,tables:(await capture(f.db)).tables}).projectCosts)
 const after=(await capture(f.db)).tables;for(const name of ['journal_entries','journal_lines','accounting_facts','job_cost_entries','time_entries','books_payroll_labor_ownership'])assert.deepEqual(after[name],tables[name])
 assert.equal(after.billable_costs[0].billable_cents,tables.billable_costs[0].billable_cents)
})
test('additional dated liabilities remain unassigned and all sides must balance with original account identity',async t=>{
 const f=await ready(t),original=await context(f)
 await f.db.exec('begin')
 await f.db.query("insert into journal_entries(id,org_id,entry_date,entry_kind,memo,source_type,source_id,posting_key,policy_version,projection_version,created_by) values($1,$2,'2026-09-21','operational','Later reviewed settlement','payroll_settlement',$3,'later-payroll-settlement',1,1,$4)",[id(800),org,id(801),id(50)])
 await f.db.query("insert into journal_lines(id,org_id,entry_id,line_no,account_id,debit_cents,credit_cents,dimensions) values($1,$2,$3,1,$4,100,0,'{}'),($5,$2,$3,2,$6,0,100,'{}')",[id(802),org,id(800),id(30),id(803),id(32)])
 await f.db.query("update journal_entries set status='posted',posted_at=now(),posted_by=$1 where org_id=$2 and id=$3",[id(50),org,id(800)]);await f.db.exec('commit')
 const next=await context(f);assert.deepEqual(next.additionalLiabilityJournalIds,[id(800)]);assert.ok(next.blockers.includes('review_additional_liability_attribution'));assert.notEqual(next.contextHash,original.contextHash)
 assert.equal(next.context.liability_lines.filter(row=>row.entry_id===id(800)).length,2);assert.equal(next.remainingBeforeAdditionalAttribution.netPayCents,20000)
 for(const statement of [
  "update journal_lines set dimensions='{\"books_account_classification\":{}}' where id='"+id(802)+"'",
  "update journal_lines set dimensions='{\"books_account_classification\":{\"account_id\":\""+id(999)+"\",\"code\":\"2200\",\"account_type\":\"liability\"}}' where id='"+id(802)+"'",
  'update journal_lines set debit_cents=case when debit_cents>0 then 9007199254740992 else 0 end,credit_cents=case when credit_cents>0 then 9007199254740992 else 0 end where entry_id=\''+id(800)+'\'',
 ]){
  await f.db.exec('begin');await f.db.exec('set local session_replication_role=replica');await f.db.exec(statement);await f.db.exec('set local session_replication_role=origin')
  await assert.rejects(context(f),/amount or classification differs/);await f.db.exec('rollback')
 }
 await f.db.exec('set session_replication_role=replica');await f.db.query('update journal_lines set credit_cents=101 where id=$1',[id(803)]);await f.db.exec('set session_replication_role=origin')
 await assert.rejects(context(f),/unbalanced/)
})
test('withdrawn/missing/foreign sources cannot provide current correction context',async t=>{
 const f=await ready(t)
 await assert.rejects(f.db.query('select lock_books_payroll_correction_context($1,$2)',[id(999),id(700)]),/reviewed source/)
 await assert.rejects(f.db.query('select lock_books_payroll_correction_context($1,$2)',[org,id(999)]),/reviewed source/)
 await f.db.query('select withdraw_books_payroll_correction_source($1,$2,$3,$4)',[org,id(700),id(50),'Withdraw original correction source before posting'])
 await assert.rejects(context(f),/reviewed source/)
})
test('context holds source/calendar advisory fences inside caller transaction and releases them on completion',async t=>{
 const f=await ready(t),original=await context(f)
 await f.db.exec('begin');await context(f)
 const locks=(await f.db.query("select mode from pg_locks where locktype='advisory' and granted")).rows
 assert.ok(locks.some(row=>row.mode==='ExclusiveLock'));assert.ok(locks.some(row=>row.mode==='ShareLock'))
 await f.db.query('update budget_lines set cost_code_id=null where id=$1',[id(84)])
 assert.notEqual((await context(f)).contextHash,original.contextHash)
 await f.db.exec('rollback')
 assert.equal((await f.db.query("select count(*)::int n from pg_locks where locktype='advisory' and granted")).rows[0].n,0)
 assert.equal((await context(f)).contextHash,original.contextHash)
})
test('service-role preflight uses immutable receipts without obtaining mutation privileges',async t=>{
 const f=await ready(t)
 // Match operational service grants while preserving explicit private immutable
 // receipt/ownership ACLs; a database-owner-only fixture masks row-lock mistakes.
 await f.db.exec('grant select,insert,update on all tables in schema public to service_role;revoke update on books_payroll_postings,books_payroll_labor_ownership from service_role;alter role service_role bypassrls;set role service_role')
 const rights=(await f.db.query("select has_table_privilege(current_user,'books_payroll_postings','update') receipt_update,has_table_privilege(current_user,'books_payroll_labor_ownership','update') ownership_update")).rows[0]
 assert.deepEqual(rights,{receipt_update:false,ownership_update:false})
 const current=await context(f);assert.equal(current.sourceId,id(700));assert.equal(current.math.costDeltaCents,2000)
 const evidence=structuredClone(f.evidence);evidence.run.id=id(710);evidence.request.id=id(710)
 assert.equal((await prepareSource(f,evidence,'service-role-correction-source-key')).rows[0].id,id(710))
 await f.db.query('select review_books_payroll_correction_source($1,$2,$3,$4::jsonb,$5)',[org,id(710),id(51),JSON.stringify(evidence),'Independent role-tested correction source review'])
 assert.equal((await f.db.query('select reviewed_books_payroll_correction_delta($1,$2) result',[org,id(710)])).rows[0].result.costDeltaCents,2000)
 await f.db.exec('reset role')
})
test('a positive aggregate correction cannot hide recovery owed by an already paid original worker',async t=>{
 const {booksDigest}=require('../lib/services/books/hash')
 const f=await ready(t,{paid:true},e=>{
  e.run.employees[0].worker_id=id(50);e.run.employees[0].allocations[0].id=id(711);e.run.employees[0].allocations[0].labor_evidence_ids=[]
  e.source_mapping_digest=booksDigest({source:e.source_proof,columns:e.column_mapping,workers:e.run.employees.map(worker=>({worker_id:worker.worker_id,employee_reference:worker.employee_reference,allocations:worker.allocations}))})
 })
 const current=await context(f)
 assert.equal(current.remainingBeforeAdditionalAttribution.netPayCents,2000)
 assert.equal(current.workers.find(row=>row.workerId===id(2)).remainingBeforeAdditionalAttribution.netPayCents,-18000)
 assert.equal(current.workers.find(row=>row.workerId===id(50)).remainingBeforeAdditionalAttribution.netPayCents,20000)
 assert.ok(current.blockers.includes('review_employee_or_provider_overpayment_recovery'));assert.equal(current.math.cashDeltaCents,0)
 assert.ok(current.projectCosts.some(row=>row.blockers.includes('review_new_or_reallocated_budget_and_gmp')))
 const tables=(await capture(f.db)).tables,plan=payrollCorrectionPlan({request:f.evidence.request,correctedRun:f.evidence.run,tables})
 assert.deepEqual(current.workers,plan.workers);assert.deepEqual(current.projectCosts,plan.projectCosts);assert.deepEqual(current.blockers,plan.blockers)
})
