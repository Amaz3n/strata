require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {lineageFixture,nextSource,nextProposal,postLineage,migration}=require('./helpers/books-payroll-correction-lineage-fixture'),{correctionPostingFixture,postCorrection}=require('./helpers/books-payroll-correction-posting-fixture'),{capture}=require('./helpers/books-payroll-workflow-fixture'),{id,org}=require('./helpers/books-payroll-register-fixture')
const {parsePayrollCorrectionContext}=require('../lib/services/books/payroll-correction-context'),{verifyPayrollCorrectionPosting}=require('../lib/services/books/payroll-correction-posting'),{payrollCorrectionLineage}=require('../lib/services/books/payroll-correction-lineage'),{BOOKS_EXPORT_SCHEMA_VERSION,EXPORT_TABLES,verifyBooksExportBundle}=require('../lib/services/books/export-contract'),{booksDigest}=require('../lib/services/books/hash'),{historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive')
const money=['journal_entries','journal_lines','accounting_facts','job_cost_entries','books_payroll_correction_postings'],native=['time_entries','billable_costs','books_payroll_imports','books_payroll_postings','books_payroll_labor_ownership']
const archive=(f,tables,version=BOOKS_EXPORT_SCHEMA_VERSION)=>({tables,manifest:{schemaVersion:version,orgId:org,tables:Object.fromEntries(Object.entries(tables).map(([table,rows])=>[table,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:tables.files.map(file=>({id:file.id,storagePath:file.storage_path,sizeBytes:file.size_bytes,checksum:file.checksum})),supportingHistoricalFiles:historicalDocumentInventory(tables,org)},supportingObjects:tables.files.map(file=>({fileId:file.id,dataBase64:f.registers.get(file.id).toString('base64')})),supportingHistoricalObjects:[]})
async function verifyAll(f){const tables=(await capture(f.db)).tables;for(const row of tables.books_payroll_correction_postings)verifyPayrollCorrectionPosting(row,tables);return tables}
async function third(f){const first=(await postLineage(f)).rows[0].result,s=await nextSource(f),p=await nextProposal(f,s),second=(await postLineage(f,p,1)).rows[0].result,s3=await nextSource(f,{number:2,gross:25000,date:'2026-09-22'}),p3=await nextProposal(f,s3,2),last=(await postLineage(f,p3,2)).rows[0].result;return {first,second,last,p,p3,s3}}
test('three actual corrections adjust the latest posted full register and cumulative unpaid payroll exactly once',async t=>{
 const f=await lineageFixture(t),before=(await capture(f.db)).tables,{first,second,last,p,p3}=await third(f),tables=await verifyAll(f)
 assert.deepEqual([first.sequence,second.sequence,last.sequence],[1,2,3]);assert.deepEqual([first.previousPostingId,second.previousPostingId,last.previousPostingId],[null,first.postingId,second.postingId])
 assert.deepEqual([first.jobCosts[0].costCents,second.jobCosts[0].costCents,last.jobCosts[0].costCents],[2000,2000,-3000])
 assert.equal(p.plan.remainingBeforeAdditionalAttribution.netPayCents,22000);assert.equal(p3.plan.remainingBeforeAdditionalAttribution.netPayCents,19000);assert.equal(p3.plan.workers[0].remainingBeforeAdditionalAttribution.netPayCents,19000)
 assert.deepEqual(p3.plan.additionalLiabilityJournalIds,[]);assert.deepEqual(p3.plan.blockers,[])
 const total=rows=>rows.reduce((n,row)=>n+Number(row.cost_cents),0);assert.equal(total(tables.job_cost_entries)-total(before.job_cost_entries),1000)
 for(const name of native)assert.deepEqual(tables[name],before[name],name)
 for(const row of tables.books_payroll_correction_postings){const q=tables.books_payroll_correction_proposals.find(p=>p.id===row.proposal_id);assert.equal(q.posted_receipt_id,row.id);assert.deepEqual(q.plan.baseline.previousPostingId,row.previous_posting_id);assert.equal(row.result.jobCosts[0].budgetLineId,id(84));assert.equal(row.result.jobCosts[0].gmpClassification,'outside_gmp')}
 for(const journal of [first,second,last])assert.ok(tables.journal_lines.filter(l=>l.entry_id===journal.journalId).every(l=>l.dimensions.payroll_run_id===id(6)))
 const context=await f.db.query('select books_payroll_correction_baseline($1,$2,null,true) result',[org,id(260)]);assert.equal(context.rows[0].result.baseline.previousPostingId,last.postingId)
})
test('unposted reviewed documentary revisions never become the next monetary baseline',async t=>{
 const f=await lineageFixture(t);const documentary=await nextSource(f,{gross:90000}),first=(await postLineage(f)).rows[0].result
 const source=await nextSource(f,{number:2,gross:28000}),proposal=await nextProposal(f,source,2),result=(await postLineage(f,proposal,2)).rows[0].result,tables=await verifyAll(f)
 assert.equal(tables.books_payroll_correction_sources.find(s=>s.id===documentary.id).revision,2);assert.equal(tables.books_payroll_correction_sources.find(s=>s.id===source.id).revision,3)
 assert.equal(result.sequence,2);assert.equal(proposal.plan.baseline.previousSourceId,id(700));assert.equal(result.previousPostingId,first.postingId);assert.equal(result.jobCosts[0].costCents,2000)
 assert.equal(tables.books_payroll_correction_proposals.length,2)
})
test('original paid payroll plus cumulative actual corrections distinguishes remaining unpaid from employee recovery',async t=>{
 const f=await lineageFixture(t,{paid:true});await postLineage(f)
 const s=await nextSource(f,{gross:25000}),p=await nextProposal(f,s),r=(await postLineage(f,p,1)).rows[0].result
 assert.equal(p.plan.math.liabilityDelta.netPayCents,-1000);assert.equal(p.plan.remainingBeforeAdditionalAttribution.netPayCents,1000);assert.equal(r.jobCosts[0].costCents,-1000)
 const next=await nextSource(f,{number:2,gross:22000,date:'2026-09-22'}),context=(await f.db.query('select lock_books_payroll_correction_context($1,$2) result',[org,next.id])).rows[0].result
 assert.equal(context.remainingBeforeAdditionalAttribution.netPayCents,-2000);assert.ok(context.blockers.includes('review_employee_or_provider_overpayment_recovery'))
 await assert.rejects(nextProposal(f,next,2),/unresolved business/);await verifyAll(f)
})
test('later correction cannot precede the latest actual journal, and changed or fabricated ancestry cannot approve money',async t=>{
 const f=await lineageFixture(t);await postLineage(f);const s=await nextSource(f,{date:'2026-09-25'}),p=await nextProposal(f,s);await postLineage(f,p,1)
 await assert.rejects(nextSource(f,{number:2,date:'2026-09-24'}),/cannot precede/)
 const next=await nextSource(f,{number:3,date:'2026-09-26',gross:29000}),context=(await f.db.query('select lock_books_payroll_correction_context($1,$2) result',[org,next.id])).rows[0].result,tables=(await capture(f.db)).tables
 assert.equal(parsePayrollCorrectionContext(context,tables).baseline.sequence,3)
 for(const mutate of [p=>p.baseline.previousPostingId=id(999),p=>p.baseline.previousSourceId=id(700),p=>p.baseline.previousPlanDigest='a'.repeat(64),p=>p.baseline.sequence=2]){const bad=structuredClone(context);mutate(bad);assert.throws(()=>parsePayrollCorrectionContext(bad,tables),/baseline/);delete bad.locksHeldUntilTransactionEnd;await assert.rejects(f.db.query('select prepare_books_payroll_correction_proposal($1,$2,$3,$4,$5::jsonb,$6,$7)',[org,id(980),next.id,id(2),JSON.stringify(bad),'Prepare forged monetary predecessor context','forged-lineage-proposal-key']),/context changed/)}
})
test('late failure rolls back money and the posted proposal reservation, preserving retry and existing history',async t=>{
 const f=await lineageFixture(t);await postLineage(f);const s=await nextSource(f),p=await nextProposal(f,s),before=(await capture(f.db)).tables
 await f.db.exec("create function mutate_lineage_budget() returns trigger language plpgsql as $$begin if new.source_type='payroll_correction' then update budget_lines set cost_code_id=null where id=new.budget_line_id;end if;return new;end$$;create trigger mutate_lineage_budget after insert on job_cost_entries for each row execute function mutate_lineage_budget()")
 await assert.rejects(postLineage(f,p,1),/evidence changed inside monetary transaction/)
 const after=(await capture(f.db)).tables;for(const name of [...money,...native,'books_payroll_correction_proposals','budget_lines'])assert.deepEqual(after[name],before[name],name)
 assert.equal(after.books_payroll_correction_proposals.find(q=>q.id===p.id).posted_receipt_id,null)
 await f.db.exec('drop trigger mutate_lineage_budget on job_cost_entries');await postLineage(f,p,1);await verifyAll(f)
})
test('posted reservations cannot be released or claimed without matching actual money, and ancestry fails before recursive cycles',async t=>{
 const f=await lineageFixture(t),r=(await postLineage(f)).rows[0].result,s=await nextSource(f),p=await nextProposal(f,s)
 await assert.rejects(f.db.query('update books_payroll_correction_proposals set posted_receipt_id=null where id=$1',[f.proposal.id]),/immutable/)
 await assert.rejects(f.db.query('update books_payroll_correction_proposals set posted_receipt_id=$1 where id=$2',[r.postingId,p.id]),/matching actual monetary receipt/)
 await assert.rejects(f.db.query('update books_payroll_correction_proposals set posted_receipt_id=$1 where id=$2',[id(999),p.id]),/foreign key|matching actual monetary receipt/)
 const second=(await postLineage(f,p,1)).rows[0].result,tables=(await capture(f.db)).tables,row=tables.books_payroll_correction_postings.find(p=>p.id===second.postingId)
 for(const overrides of [{previous_posting_id:second.postingId},{previous_posting_id:id(999)},{sequence:3}]){
  const bad={...row,...overrides};assert.throws(()=>verifyPayrollCorrectionPosting(bad,tables));await assert.rejects(f.db.query('select assert_books_payroll_correction_posting($1::jsonb)',[JSON.stringify(bad)]),/ancestry|sequence/)
 }
 const corrupt=structuredClone(tables);corrupt.books_payroll_correction_postings[1].previous_posting_id=second.postingId;assert.throws(()=>payrollCorrectionLineage(corrupt,org,id(260)),/branched or cyclic/)
 await verifyAll(f)
})
test('schema 17 exports complete monetary ancestry and restores historical and latest retries with ordinary guards',async t=>{
 const f=await lineageFixture(t),history=await third(f),tables=await verifyAll(f),bundle=archive(f,tables)
 assert.equal(BOOKS_EXPORT_SCHEMA_VERSION,34);assert.equal(verifyBooksExportBundle(bundle).valid,true,JSON.stringify(verifyBooksExportBundle(bundle)))
 const downgraded=structuredClone(bundle);downgraded.manifest.schemaVersion=16;assert.equal(verifyBooksExportBundle(downgraded).valid,false,"sequential money cannot be hidden under the older receipt contract")
 for(const mutate of [b=>b.tables.books_payroll_correction_postings.splice(0,1),b=>b.tables.books_payroll_correction_postings[1].previous_posting_id=id(999),b=>b.tables.books_payroll_correction_proposals[1].posted_receipt_id=null,b=>b.tables.books_payroll_correction_postings[2].sequence=2,b=>b.tables.job_cost_entries.find(j=>j.source_type==='payroll_correction').cost_cents++]){const bad=structuredClone(bundle);mutate(bad);for(const [name,rows] of Object.entries(bad.tables))bad.manifest.tables[name]={rows:rows.length,checksum:booksDigest(rows)};assert.equal(verifyBooksExportBundle(bad).valid,false)}
 const target=await lineageFixture(t);await target.db.exec('set session_replication_role=replica');for(const name of [...EXPORT_TABLES].reverse())await target.db.exec(`delete from ${name}`)
 for(const name of EXPORT_TABLES)for(const row of tables[name]){const keys=Object.keys(row);await target.db.query(`insert into ${name}(${keys.map(k=>'"'+k+'"').join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row).map(v=>v&&typeof v==='object'?JSON.stringify(v):v))}
 await target.db.exec('set session_replication_role=origin');assert.deepEqual((await capture(target.db)).tables,tables)
 target.proposal=f.proposal;assert.deepEqual((await postLineage(target)).rows[0].result,history.first);assert.deepEqual((await postLineage(target,history.p3,2)).rows[0].result,history.last)
 await target.db.query("update accounting_periods set status='closed' where id=$1",[id(250)]);await target.db.query('update budget_lines set cost_code_id=null where id=$1',[id(84)]);assert.deepEqual((await postLineage(target,history.p3,2)).rows[0].result,history.last)
 await assert.rejects(target.db.exec('delete from books_payroll_correction_postings'),/immutable/)
})
test('legacy first correction upgrades and archive recovery derives only its proven posted reservation before a new correction',async t=>{
 const {prepareBooksRestorePlan}=require('../lib/services/books/restore-plan')
 const f=await correctionPostingFixture(t),r=(await postCorrection(f)).rows[0].result,oldTables=(await capture(f.db)).tables;f.registers=new Map([[id(8),f.registerBytes],[id(702),f.bytes]])
 const bundle=archive(f,oldTables,16),unchanged=structuredClone(bundle);assert.equal(verifyBooksExportBundle(bundle).valid,true)
 await f.db.exec(migration());let tables=await verifyAll(f);assert.equal(tables.books_payroll_correction_proposals[0].posted_receipt_id,r.postingId);assert.equal(tables.books_payroll_correction_postings[0].sequence,1);assert.equal(tables.books_payroll_correction_postings[0].result.version,1)
 assert.deepEqual((await postCorrection(f)).rows[0].result,r)
 const columns=(await f.db.query("select table_name as table,column_name as name,is_nullable='NO' as \"notNull\",column_default is not null as \"hasDefault\",is_generated <> 'NEVER' as generated from information_schema.columns where table_schema='public'")).rows,catalog={columns,foreignKeys:[]}
 const plan=prepareBooksRestorePlan({bundle,catalog,dependencies:[],fundingActors:{}});assert.equal(plan.preflight.readyForRestoreAttempt,true,JSON.stringify(plan.preflight));assert.deepEqual(bundle,unchanged);assert.equal(plan.tables.books_payroll_correction_proposals[0].posted_receipt_id,r.postingId);assert.ok(plan.changes.some(c=>c.table==='books_payroll_correction_proposals'&&c.fields.includes('posted_receipt_id')))
 await f.db.exec('set session_replication_role=replica');for(const name of EXPORT_TABLES)await f.db.exec(`delete from ${name}`)
 for(const [name,rows] of Object.entries(plan.tables))for(const row of rows){const keys=Object.keys(row);await f.db.query(`insert into ${name}(${keys.map(k=>'"'+k+'"').join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row).map(v=>v&&typeof v==='object'?JSON.stringify(v):v))}
 await f.db.exec('set session_replication_role=origin');assert.deepEqual((await postCorrection(f)).rows[0].result,r)
 const source=await nextSource(f),proposal=await nextProposal(f,source),second=(await postLineage(f,proposal,1)).rows[0].result;assert.equal(second.sequence,2);assert.equal(second.previousPostingId,r.postingId);assert.equal(second.jobCosts[0].costCents,2000);await verifyAll(f)
})
test('actual service-role lineage posting retains private salary evidence and immutable receipt ACLs',async t=>{
 const f=await lineageFixture(t);await f.db.exec('grant select,insert,update on all tables in schema public to service_role;revoke update on books_payroll_postings,books_payroll_labor_ownership,books_payroll_correction_postings from service_role;alter role service_role bypassrls;set role service_role')
 await postLineage(f);const s=await nextSource(f),p=await nextProposal(f,s);await postLineage(f,p,1);await verifyAll(f)
 assert.deepEqual((await f.db.query("select has_table_privilege('authenticated','books_payroll_correction_postings','select') exposed,has_function_privilege('authenticated','books_payroll_correction_baseline(uuid,uuid,uuid,boolean)','execute') rpc,has_table_privilege(current_user,'books_payroll_correction_postings','update') mutation,(select prosecdef from pg_proc where proname='books_payroll_correction_baseline') definer")).rows[0],{exposed:false,rpc:false,mutation:false,definer:false});await f.db.exec('reset role')
})
test('a longer actual monetary chain preserves complete approval and export proof through each posted register',async t=>{
 const f=await lineageFixture(t);await postLineage(f);let last,proposal
 for(let number=1;number<=8;number++){
  const source=await nextSource(f,{number,gross:26000+number*100,date:'2026-09-'+String(20+number)})
  proposal=await nextProposal(f,source,number);last=(await postLineage(f,proposal,number)).rows[0].result
  assert.equal(last.sequence,number+1);assert.equal(last.jobCosts[0].costCents,100)
 }
 const tables=await verifyAll(f);assert.equal(tables.books_payroll_correction_postings.length,9);assert.equal(proposal.plan.remainingBeforeAdditionalAttribution.netPayCents,20800)
 assert.equal(verifyBooksExportBundle(archive(f,tables)).valid,true)
})
