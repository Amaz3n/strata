require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {nextSource,postLineage}=require('./helpers/books-payroll-correction-lineage-fixture'),{capture}=require('./helpers/books-payroll-workflow-fixture'),{id,org}=require('./helpers/books-payroll-register-fixture')
const {parsePayrollCorrectionContext}=require('../lib/services/books/payroll-correction-context'),{parsePayrollCorrectionProposal}=require('../lib/services/books/payroll-correction-proposal'),{verifyPayrollCorrectionPosting}=require('../lib/services/books/payroll-correction-posting')
const {scenario}=require('./helpers/books-payroll-construction-decisions-fixture')
const current=async(f,choices=f.choices)=>(await f.db.query('select lock_books_payroll_correction_decisions($1,$2,$3::jsonb) result',[org,f.source.id,JSON.stringify(choices)])).rows[0].result
async function prepare(f,plan){plan??=await current(f);delete plan.locksHeldUntilTransactionEnd;await f.db.query('select prepare_books_payroll_correction_proposal($1,$2,$3,$4,$5::jsonb,$6,$7)',[org,id(999),f.source.id,id(2),JSON.stringify(plan),'Prepare explicitly placed corrective project costs','construction-choice-proposal-key']);return (await f.db.query('select to_jsonb(p) row from books_payroll_correction_proposals p where id=$1',[id(999)])).rows[0].row}
const review=(f,p,actor=id(51))=>f.db.query('select review_books_payroll_correction_proposal($1,$2,$3,$4,$5)',[org,p.id,actor,p.plan_digest,'Independent review of cost placement, GMP and preserved customer rates'])
test('reviewed explicit new-project budget/GMP decisions post both signed legs without changing native time or customer billing',async t=>{
 const f=await scenario(t),before=(await capture(f.db)).tables,c=await current(f)
 assert.equal(c.version,3);assert.equal(c.requiresConstructionReview,false);assert.equal(c.constructionDecisions.length,3)
 assert.ok(c.context.budget_lines.some(row=>row.id===id(998)));parsePayrollCorrectionContext(c,before)
 const p=await prepare(f,c);await assert.rejects(review(f,p,id(2)),/separate from all preparers/);await review(f,p)
 const r=(await postLineage(f,p,1)).rows[0].result,tables=(await capture(f.db)).tables
 const moved=tables.job_cost_entries.filter(row=>row.metadata?.payroll_correction_posting_id===r.postingId)
 assert.equal(moved.filter(row=>row.project_id===id(994)).reduce((n,row)=>n+Number(row.cost_cents),0),31000)
 assert.equal(moved.filter(row=>row.project_id===id(4)).reduce((n,row)=>n+Number(row.cost_cents),0),-29000)
 assert.ok(moved.filter(row=>row.project_id===id(994)).every(row=>row.budget_line_id===id(998)&&row.gmp_classification==='outside_gmp'))
 assert.ok(moved.filter(row=>row.project_id===id(4)).every(row=>row.budget_line_id===id(84)))
 for(const name of ['time_entries','billable_costs','books_payroll_imports','books_payroll_postings','books_payroll_labor_ownership'])assert.deepEqual(tables[name],before[name],name)
 for(const receipt of tables.books_payroll_correction_postings)verifyPayrollCorrectionPosting(receipt,tables)
 assert.deepEqual((await postLineage(f,p,1)).rows[0].result,r)
})
test('missing, duplicate, invented, foreign-budget and unreasoned choices cannot gain placement authority',async t=>{
 const f=await scenario(t),before=(await capture(f.db)).tables
 assert.throws(()=>require('../lib/services/books/payroll-correction-plan').payrollCorrectionPlan({request:f.source.evidence.request,correctedRun:f.source.evidence.run,tables:before,constructionDecisions:f.choices}),/require current commercial controls/)
 const attacks=[[],f.choices.slice(1),[f.choices[0],f.choices[0],f.choices[2]],f.choices.map((c,i)=>i===0?{...c,accountId:id(1234)}:c),f.choices.map(c=>({...c,budgetLineId:id(84)})),f.choices.map(c=>({...c,reason:'short'})),f.choices.map(c=>({...c,gmpClassification:null})),f.choices.map(c=>({...c,billingTreatment:null})),f.choices.map(c=>({...c,extra:'bypass'}))]
 for(const attack of attacks)await assert.rejects(current(f,attack),/Construction decision/)
 assert.deepEqual((await capture(f.db)).tables,before)
})
test('placement choices retain cost-plus and closed-project blockers and cannot be changed after monetary review',async t=>{
 const f=await scenario(t)
 await f.db.query("update projects set status='completed' where id=$1",[id(994)]);await f.db.query("update contracts set contract_type='cost_plus' where id=$1",[id(996)])
 let c=await current(f);parsePayrollCorrectionContext(c,(await capture(f.db)).tables)
 const leg=c.projectCosts.find(row=>row.projectId===id(994));assert.ok(leg.blockers.includes('review_late_project_cost_policy'));assert.ok(leg.blockers.includes('review_current_customer_billing_policy'));assert.equal(c.requiresConstructionReview,true)
 await f.db.query("update projects set status='active' where id=$1",[id(994)]);await f.db.query("update contracts set contract_type='time_materials' where id=$1",[id(996)])
 const p=await prepare(f);await review(f,p)
 await assert.rejects(f.db.query("update books_payroll_correction_proposals set plan=jsonb_set(plan,'{constructionDecisions,0,gmpClassification}','\"inside_gmp\"') where id=$1",[p.id]),/immutable/)
 await f.db.query('update budget_lines set cost_code_id=null where id=$1',[id(998)])
 await assert.rejects(postLineage(f,p,1),/budget is outside/)
})
test('late selected-budget scope mutation rolls money and marker back, then exact same approval posts after repair',async t=>{
 const f=await scenario(t),p=await prepare(f);await review(f,p);const before=(await capture(f.db)).tables
 await f.db.exec(`create function late_choice_test() returns trigger language plpgsql as $$begin if new.source_type='payroll_correction' and new.project_id='${id(994)}' then update budget_lines set cost_code_id=null where id='${id(998)}';end if;return new;end$$;create trigger late_choice_test after insert on job_cost_entries for each row execute function late_choice_test();`)
 await assert.rejects(postLineage(f,p,1),/budget is outside/)
 assert.deepEqual((await capture(f.db)).tables,before)
 await f.db.exec('drop trigger late_choice_test on job_cost_entries');await postLineage(f,p,1)
})
test('offline historical approval rejects fabricated placement choices even if proposal hashes are recomputed',async t=>{
 const {createHash}=require('node:crypto')
 const f=await scenario(t),p=await prepare(f);await review(f,p);await postLineage(f,p,1)
 const tables=(await capture(f.db)).tables,row=tables.books_payroll_correction_proposals.find(p=>p.id===id(999));parsePayrollCorrectionProposal(row,tables)
 for(const edit of [r=>r.plan.constructionDecisions[0].budgetLineId=id(84),r=>r.plan.constructionDecisions.pop(),r=>r.plan.version=2]){
  const bad=structuredClone(row);edit(bad);bad.plan_text=JSON.stringify(bad.plan);bad.plan_digest=createHash('sha256').update(bad.plan_text).digest('hex');assert.throws(()=>parsePayrollCorrectionProposal(bad,tables),/budget is outside|each new|decision version/)
 }
})
test('the next monetary correction inherits actual reviewed placement without asking for the same decision again',async t=>{
 const {nextProposal}=require('./helpers/books-payroll-correction-lineage-fixture')
 const f=await scenario(t),p=await prepare(f);await review(f,p);const moved=(await postLineage(f,p,1)).rows[0].result
 const source=await nextSource(f,{number:2,gross:29000,date:'2026-09-22',allocation:{project_id:id(994)}}),proposal=await nextProposal(f,source,2)
 assert.equal(proposal.plan.version,2);assert.equal(proposal.plan.baseline.previousPostingId,moved.postingId);assert.equal(proposal.plan.requiresConstructionReview,false)
 assert.ok(proposal.plan.projectCosts.every(row=>row.projectId===id(994)&&row.budgetLineId===id(998)&&row.gmpClassification==='outside_gmp'))
 const r=(await postLineage(f,proposal,2)).rows[0].result;assert.equal(r.jobCosts.reduce((n,row)=>n+row.costCents,0),1000)
 const tables=(await capture(f.db)).tables;for(const receipt of tables.books_payroll_correction_postings)verifyPayrollCorrectionPosting(receipt,tables)
 await f.db.query('update budget_lines set cost_code_id=null where id=$1',[id(998)]);await f.db.query("update contracts set contract_type='cost_plus' where id=$1",[id(996)])
 assert.deepEqual((await postLineage(f,p,1)).rows[0].result,moved);assert.deepEqual((await postLineage(f,proposal,2)).rows[0].result,r)
})
test('explicit unbudgeted placement is reviewed and archived rather than silently attaching a guessed line',async t=>{
 const f=await scenario(t);f.choices=f.choices.map(choice=>({...choice,budgetLineId:null,reason:'Approved unbudgeted destination costs; estimate revision will be prepared in the project budget workflow.'}))
 const c=await current(f);parsePayrollCorrectionContext(c,(await capture(f.db)).tables);assert.ok(c.projectCosts.filter(row=>row.projectId===id(994)).every(row=>row.budgetLineId===null))
 const p=await prepare(f,c);await review(f,p);const result=(await postLineage(f,p,1)).rows[0].result
 assert.ok(result.jobCosts.filter(row=>row.projectId===id(994)).every(row=>row.budgetLineId===null))
 const tables=(await capture(f.db)).tables;verifyPayrollCorrectionPosting(tables.books_payroll_correction_postings.find(row=>row.id===result.postingId),tables)
})
test('version-three placement approval survives populated scoped restoration and normal-guard posting retries',async t=>{
 const {BOOKS_EXPORT_SCHEMA_VERSION,EXPORT_TABLES,verifyBooksExportBundle}=require('../lib/services/books/export-contract'),{booksDigest}=require('../lib/services/books/hash'),{historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive')
 const f=await scenario(t),p=await prepare(f);await review(f,p);const r=(await postLineage(f,p,1)).rows[0].result,tables=(await capture(f.db)).tables
 const bundle={tables,manifest:{schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,tables:Object.fromEntries(Object.entries(tables).map(([table,rows])=>[table,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:tables.files.map(file=>({id:file.id,storagePath:file.storage_path,sizeBytes:file.size_bytes,checksum:file.checksum})),supportingHistoricalFiles:historicalDocumentInventory(tables,org)},supportingObjects:tables.files.map(file=>({fileId:file.id,dataBase64:f.registers.get(file.id).toString('base64')})),supportingHistoricalObjects:[]}
 assert.equal(verifyBooksExportBundle(bundle).valid,true,JSON.stringify(verifyBooksExportBundle(bundle)))
 const target=await scenario(t);await target.db.exec('set session_replication_role=replica');for(const name of [...EXPORT_TABLES].reverse())await target.db.exec(`delete from ${name}`)
 for(const name of EXPORT_TABLES)for(const row of tables[name]){const keys=Object.keys(row);await target.db.query(`insert into ${name}(${keys.map(k=>'"'+k+'"').join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row).map(v=>v&&typeof v==='object'?JSON.stringify(v):v))}
 await target.db.exec('set session_replication_role=origin');assert.deepEqual((await capture(target.db)).tables,tables)
 assert.deepEqual((await postLineage(target,p,1)).rows[0].result,r)
 await target.db.query("update projects set status='completed' where id=$1",[id(994)]);await target.db.query('update budget_lines set cost_code_id=null where id=$1',[id(998)])
 assert.deepEqual((await postLineage(target,p,1)).rows[0].result,r)
 await assert.rejects(target.db.exec('delete from books_payroll_correction_postings'),/immutable/)
})
test('private invoker decision RPC and actual service-role posting need no immutable-money update authority',async t=>{
 const f=await scenario(t),p=await prepare(f);await review(f,p)
 await f.db.exec('grant select,insert,update on all tables in schema public to service_role;revoke update on books_payroll_postings,books_payroll_labor_ownership,books_payroll_correction_postings from service_role;alter role service_role bypassrls;set role service_role')
 const r=(await postLineage(f,p,1)).rows[0].result;assert.equal(r.sequence,2)
 assert.deepEqual((await f.db.query("select has_function_privilege('authenticated','lock_books_payroll_correction_decisions(uuid,uuid,jsonb)','execute') exposed,(select prosecdef from pg_proc where proname='lock_books_payroll_correction_decisions') definer,has_table_privilege(current_user,'books_payroll_correction_postings','update') mutation")).rows[0],{exposed:false,definer:false,mutation:false})
 await f.db.exec('reset role')
})
