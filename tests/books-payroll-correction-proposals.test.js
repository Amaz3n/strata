require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {proposalFixture,prepareProposal,reviewProposal}=require('./helpers/books-payroll-correction-proposal-fixture'),{capture}=require('./helpers/books-payroll-workflow-fixture'),{id,org}=require('./helpers/books-payroll-register-fixture')
const {parsePayrollCorrectionProposal}=require('../lib/services/books/payroll-correction-proposal')
test('actual separate correction proposal preparation/review is immutable and moves no money',async t=>{
 const f=await proposalFixture(t),before=(await capture(f.db)).tables
 await prepareProposal(f);await prepareProposal(f)
 let tables=(await capture(f.db)).tables,row=parsePayrollCorrectionProposal(tables.books_payroll_correction_proposals[0],tables)
 assert.equal(row.status,'draft');assert.equal(row.plan.math.costDeltaCents,2000);assert.equal(row.plan.locksHeldUntilTransactionEnd,undefined)
 await assert.rejects(reviewProposal(f,id(2)),/separate from all preparers/);await assert.rejects(reviewProposal(f,id(50)),/separate from all preparers/)
 await reviewProposal(f);await reviewProposal(f)
 tables=(await capture(f.db)).tables;row=parsePayrollCorrectionProposal(tables.books_payroll_correction_proposals[0],tables);assert.equal(row.status,'reviewed');assert.equal(row.reviewed_by,id(51))
 for(const name of ['journal_entries','journal_lines','accounting_facts','job_cost_entries','time_entries','billable_costs','books_payroll_labor_ownership','books_payroll_postings'])assert.deepEqual(tables[name],before[name])
 await assert.rejects(f.db.exec('delete from books_payroll_correction_proposals'),/cannot be deleted/)
 await assert.rejects(f.db.exec("update books_payroll_correction_proposals set preparation_notes='Alter previously reviewed corrective monetary proposal'"),/immutable/)
 const rights=(await f.db.query("select has_table_privilege('authenticated','books_payroll_correction_proposals','select') exposed,has_function_privilege('authenticated','prepare_books_payroll_correction_proposal(uuid,uuid,uuid,uuid,jsonb,text,text)','execute') prepare")).rows[0];assert.deepEqual(rights,{exposed:false,prepare:false})
})
test('SQL rejects fabricated plan/closure, changed retry intent and stale construction before independent review',async t=>{
 const f=await proposalFixture(t)
 for(const change of [p=>p.math.journalDraft.lines[0].debitCents++,p=>p.projectCosts[0].budgetLineId=null,p=>p.sourceHash='a'.repeat(64),p=>p.blockers.push('invented'),p=>p.context.billable_costs[0].billable_cents++,p=>p.contextHash='a'.repeat(64),p=>p.context.projects[0].org_id=id(999)]){
  const bad=structuredClone(f.plan);change(bad);await assert.rejects(prepareProposal(f,bad),/changed before preparation/)
 }
 await prepareProposal(f);await assert.rejects(prepareProposal(f,f.plan,'correction-proposal-prepare-key',id(50)),/different intent/)
 await f.db.query('update budget_lines set cost_code_id=null where id=$1',[id(84)])
 await assert.rejects(reviewProposal(f),/evidence changed/)
 const tables=(await capture(f.db)).tables;assert.equal(parsePayrollCorrectionProposal(tables.books_payroll_correction_proposals[0],tables).status,'draft','frozen historical proposal survives current budget changes')
})
test('source withdrawal cascades proposal withdrawal, retains independent review and historical retry',async t=>{
 const f=await proposalFixture(t);await prepareProposal(f);await reviewProposal(f)
 await f.db.query('select withdraw_books_payroll_correction_source($1,$2,$3,$4)',[org,id(700),id(50),'Withdraw source and all unposted corrective monetary proposals'])
 const tables=(await capture(f.db)).tables,row=parsePayrollCorrectionProposal(tables.books_payroll_correction_proposals[0],tables);assert.equal(row.status,'withdrawn');assert.equal(row.reviewed_by,id(51));assert.equal((await prepareProposal(f)).rows[0].id,id(750))
 await assert.rejects(reviewProposal(f),/reviewed source/)
})
test('unresolved accounting/business decisions persist as draft and cannot receive blanket monetary approval',async t=>{
 const f=await proposalFixture(t)
 await f.db.query("update billable_costs set metadata=jsonb_set(metadata,'{billing_method}','\"cost_plus_markup\"') where id=$1",[id(86)])
 const plan=(await f.db.query('select lock_books_payroll_correction_context($1,$2) result',[org,id(700)])).rows[0].result;delete plan.locksHeldUntilTransactionEnd
 await prepareProposal(f,plan);assert.equal(plan.requiresConstructionReview,true)
 await assert.rejects(reviewProposal(f),/unresolved business or accounting decisions/)
 await f.db.query('select withdraw_books_payroll_correction_proposal($1,$2,$3,$4)',[org,id(750),id(2),'Withdraw draft requiring explicit cost-plus correction review'])
 const tables=(await capture(f.db)).tables;assert.equal(parsePayrollCorrectionProposal(tables.books_payroll_correction_proposals[0],tables).status,'withdrawn')
})
test('schema 15 preserves decimal evidence, reviewed proposal history and retry through populated restoration',async t=>{
 const {BOOKS_EXPORT_SCHEMA_VERSION,EXPORT_TABLES,verifyBooksExportBundle}=require('../lib/services/books/export-contract'),{booksDigest}=require('../lib/services/books/hash'),{historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive'),{createHash}=require('node:crypto')
 const f=await proposalFixture(t)
 await f.db.query("update billable_costs set markup_percent_resolved=11.1100 where id=$1",[id(86)])
 f.plan=(await f.db.query('select lock_books_payroll_correction_context($1,$2) result',[org,id(700)])).rows[0].result;delete f.plan.locksHeldUntilTransactionEnd
 await prepareProposal(f);await reviewProposal(f)
 const originalPlanHash=(await f.db.query('select plan_digest from books_payroll_correction_proposals where id=$1',[id(750)])).rows[0].plan_digest
 await f.db.query('update billable_costs set markup_percent_resolved=11.11 where id=$1',[id(86)])
 await reviewProposal(f);assert.equal((await f.db.query('select plan_digest from books_payroll_correction_proposals where id=$1',[id(750)])).rows[0].plan_digest,originalPlanHash,'equivalent numeric scale preserves approval')
 await f.db.query('update billable_costs set markup_percent_resolved=12.1200 where id=$1',[id(86)])
 const tables=(await capture(f.db)).tables,row=parsePayrollCorrectionProposal(tables.books_payroll_correction_proposals[0],tables)
 assert.match(row.context_text,/11\.11/);assert.equal(row.status,'reviewed')
 const bundle={tables,manifest:{schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:tables.files.map(file=>({id:file.id,storagePath:file.storage_path,sizeBytes:file.size_bytes,checksum:file.checksum})),supportingHistoricalFiles:historicalDocumentInventory(tables,org)},supportingObjects:[{fileId:id(8),dataBase64:f.registerBytes.toString('base64')},{fileId:id(702),dataBase64:f.bytes.toString('base64')}]}
 assert.equal(BOOKS_EXPORT_SCHEMA_VERSION,33);assert.equal(verifyBooksExportBundle(bundle).valid,true,JSON.stringify(verifyBooksExportBundle(bundle)))
 const bad=structuredClone(bundle),saved=bad.tables.books_payroll_correction_proposals[0];saved.plan.math.journalDraft.lines[0].debitCents++
 saved.plan_text=JSON.stringify(saved.plan);saved.plan_digest=createHash('sha256').update(saved.plan_text).digest('hex');bad.manifest.tables.books_payroll_correction_proposals.checksum=booksDigest(bad.tables.books_payroll_correction_proposals)
 assert.equal(verifyBooksExportBundle(bad).valid,false,'recomputed text, digest and table checksum cannot invent approved payroll money')
 const target=await proposalFixture(t);await target.db.exec('set session_replication_role=replica')
 for(const name of EXPORT_TABLES)await target.db.exec(`delete from ${name}`)
 for(const [name,rows]of Object.entries(tables))for(const row of rows){const keys=Object.keys(row);await target.db.query(`insert into ${name}(${keys.map(key=>'"'+key+'"').join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row).map(value=>value&&typeof value==='object'?JSON.stringify(value):value))}
 await target.db.exec('set session_replication_role=origin')
 assert.deepEqual((await capture(target.db)).tables,tables);assert.equal(parsePayrollCorrectionProposal((await capture(target.db)).tables.books_payroll_correction_proposals[0],tables).status,'reviewed')
 assert.equal((await prepareProposal(target,f.plan)).rows[0].id,id(750),'historical retry survives changed current customer markup')
 await assert.rejects(target.db.exec("update books_payroll_correction_proposals set plan_digest='"+'a'.repeat(64)+"'"),/immutable/)
 const old=structuredClone(bundle);old.manifest.schemaVersion=14;delete old.tables.books_payroll_correction_proposals;delete old.manifest.tables.books_payroll_correction_proposals
 assert.equal(verifyBooksExportBundle(old).valid,true,'schema 14 can omit the new proposal table')
})
test('actual service role prepares and independently reviews without public salary access or immutable-receipt update grants',async t=>{
 const f=await proposalFixture(t)
 await f.db.exec('grant select,insert,update on all tables in schema public to service_role;revoke update on books_payroll_postings,books_payroll_labor_ownership from service_role;alter role service_role bypassrls;set role service_role')
 await prepareProposal(f);await reviewProposal(f)
 const row=(await f.db.query('select status from books_payroll_correction_proposals where id=$1',[id(750)])).rows[0];assert.equal(row.status,'reviewed')
 assert.equal((await f.db.query("select has_table_privilege(current_user,'books_payroll_postings','update') permission")).rows[0].permission,false)
 await f.db.exec('reset role')
})
