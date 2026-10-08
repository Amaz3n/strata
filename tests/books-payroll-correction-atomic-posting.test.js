require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {correctionPostingFixture,postCorrection}=require('./helpers/books-payroll-correction-posting-fixture'),{capture}=require('./helpers/books-payroll-workflow-fixture'),{id,org}=require('./helpers/books-payroll-register-fixture')
const {verifyPayrollCorrectionPosting}=require('../lib/services/books/payroll-correction-posting'),{BOOKS_EXPORT_SCHEMA_VERSION,EXPORT_TABLES,verifyBooksExportBundle}=require('../lib/services/books/export-contract'),{booksDigest}=require('../lib/services/books/hash'),{historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive')
const money=['journal_entries','journal_lines','accounting_facts','job_cost_entries','books_payroll_correction_postings']
const frozen=['time_entries','billable_costs','books_payroll_postings','books_payroll_labor_ownership','books_payroll_imports','books_payroll_correction_sources','books_payroll_correction_proposals']
async function receipt(f){const tables=(await capture(f.db)).tables;return {tables,row:verifyPayrollCorrectionPosting(tables.books_payroll_correction_postings[0],tables)}}
function bundle(f,tables){const historical=historicalDocumentInventory(tables,org);return {tables,manifest:{schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,tables:Object.fromEntries(EXPORT_TABLES.map(name=>[name,{rows:tables[name].length,checksum:booksDigest(tables[name])}])),supportingFiles:tables.files.map(file=>({id:file.id,storagePath:file.storage_path,sizeBytes:Number(file.size_bytes),checksum:file.checksum})),supportingHistoricalFiles:historical},supportingObjects:tables.files.map(file=>({fileId:file.id,dataBase64:(file.id===id(702)?f.bytes:f.registerBytes).toString('base64')})),supportingHistoricalObjects:[]}}
test('atomic correction commits one balanced journal/fact and exact signed project costs without replaying native labor or billing',async t=>{
 const f=await correctionPostingFixture(t),before=(await capture(f.db)).tables,result=(await postCorrection(f)).rows[0].result,{tables,row}=await receipt(f)
 assert.deepEqual(row.result,result);assert.equal(result.jobCosts.length,1);assert.equal(result.jobCosts[0].costCents,2000)
 assert.equal(tables.job_cost_entries.filter(j=>j.source_type==='payroll_correction')[0].budget_line_id,id(84));assert.equal(tables.job_cost_entries.filter(j=>j.source_type==='payroll_correction')[0].gmp_classification,'outside_gmp')
 for(const name of frozen)assert.deepEqual(tables[name],before[name],name)
 const lines=tables.journal_lines.filter(l=>l.entry_id===result.journalId);assert.equal(lines.reduce((n,l)=>n+Number(l.debit_cents)-Number(l.credit_cents),0),0)
 assert.deepEqual([...new Set(lines.map(l=>l.dimensions.payroll_run_id))],[id(6)]);assert.equal(lines.find(l=>l.dimensions.books_account_classification.code==='2200').credit_cents,2000)
 assert.equal(tables.journal_entries.length,before.journal_entries.length+1);assert.equal(tables.accounting_facts.length,before.accounting_facts.length+1)
})
test('failure at project-cost insertion rolls journal, fact and receipt back; same intent succeeds after repair',async t=>{
 const f=await correctionPostingFixture(t),before=(await capture(f.db)).tables
 await f.db.exec("create function fail_corrective_cost() returns trigger language plpgsql as $$begin if new.source_type='payroll_correction' then raise exception 'Injected project cost failure';end if;return new;end$$;create trigger inject_corrective_cost before insert on job_cost_entries for each row execute function fail_corrective_cost()")
 await assert.rejects(postCorrection(f),/Injected project cost failure/)
 const after=(await capture(f.db)).tables;for(const name of [...money,...frozen])assert.deepEqual(after[name],before[name],name)
 await f.db.exec('drop trigger inject_corrective_cost on job_cost_entries');await postCorrection(f);await receipt(f)
})
test('exact committed retry survives later close/budget change and rejects another actor, digest, notes or posting identity',async t=>{
 const f=await correctionPostingFixture(t),posted=(await postCorrection(f)).rows[0].result
 await f.db.query("update accounting_periods set status='closed' where id=$1",[id(250)]);await f.db.query('update budget_lines set cost_code_id=null where id=$1',[id(84)])
 await f.db.query("update gl_accounts set code='2299',active=false where id=$1",[id(30)])
 assert.deepEqual((await postCorrection(f)).rows[0].result,posted)
 for(const overrides of [{id:id(761)},{actor:id(51)},{digest:'a'.repeat(64)},{notes:'Different explanation from the committed intent'}])await assert.rejects(postCorrection(f,overrides),/different intent/)
 await assert.rejects(postCorrection(f,{key:'different-corrective-posting-key'}),/latest actually posted register baseline/)
 await f.db.query("update memberships set status='inactive' where org_id=$1 and user_id=$2",[org,id(2)]);await assert.rejects(postCorrection(f),/active actor/)
 await receipt(f)
})
test('fresh posting rejects changed calendar, construction, review identity and foreign actors without money',async t=>{
 const f=await correctionPostingFixture(t),before=(await capture(f.db)).tables
 for(const overrides of [{org:id(99)},{actor:id(52)},{digest:'a'.repeat(64)},{proposalId:id(999)}])await assert.rejects(postCorrection(f,overrides))
 await f.db.query("update accounting_periods set status='closed' where id=$1",[id(250)]);await assert.rejects(postCorrection(f),/evidence changed/)
 await f.db.query("update accounting_periods set status='open' where id=$1",[id(250)]);await f.db.query('update budget_lines set cost_code_id=null where id=$1',[id(84)]);await assert.rejects(postCorrection(f),/evidence changed/)
 const after=(await capture(f.db)).tables;for(const name of money)assert.deepEqual(after[name],before[name])
})
test('posted source/proposal, receipt, signed cost and GL cannot be independently withdrawn, altered or reversed',async t=>{
 const f=await correctionPostingFixture(t),result=(await postCorrection(f)).rows[0].result
 for(const sql of [
  `update books_payroll_correction_postings set posting_notes='Alter committed posting explanation' where id='${id(760)}'`,
  `delete from books_payroll_correction_postings where id='${id(760)}'`,
  `select withdraw_books_payroll_correction_source('${org}','${id(700)}','${id(50)}','Withdraw posted corrected provider register')`,
  `select withdraw_books_payroll_correction_proposal('${org}','${id(750)}','${id(2)}','Withdraw posted corrected monetary proposal')`,
  `update job_cost_entries set cost_cents=cost_cents+1 where id='${result.jobCosts[0].jobCostId}'`,
  `delete from job_cost_entries where id='${result.jobCosts[0].jobCostId}'`,
  `update journal_entries set status='reversed' where id='${result.journalId}'`,
 ])await assert.rejects(f.db.exec(sql),/immutable|coordinated|Posted journal/)
 await receipt(f)
 // Raw GL/fact paths cannot commit payroll-correction money without a receipt.
 await f.db.exec('begin')
 await f.db.query("insert into accounting_facts(org_id,source_type,source_id,source_version,fact_kind,occurred_at,accounting_date,payload,payload_hash,policy_version,idempotency_key,created_by) values($1,'payroll_correction',$2,1,'payroll_correction',now(),'2026-09-20','{}',$3,1,'raw-correction-fact',$4)",[org,id(799),'a'.repeat(64),id(2)])
 await assert.rejects(f.db.exec('commit'),/lacks atomic posting receipt/);await f.db.exec('rollback')
 await f.db.exec('begin')
 await f.db.query('select post_books_journal_entry($1,$2::jsonb,$3::jsonb)',[org,JSON.stringify({entry_date:'2026-09-20',entry_kind:'adjusting',memo:'Unowned raw corrective journal',posting_key:'raw-correction-journal',projection_version:1,policy_version:1,source_type:'payroll_correction',source_id:id(798),created_by:id(2)}),JSON.stringify([{line_no:1,account_id:id(32),project_id:id(4),description:'Raw cost',debit_cents:100,credit_cents:0,dimensions:{}},{line_no:2,account_id:id(30),project_id:id(4),description:'Raw liability',debit_cents:0,credit_cents:100,dimensions:{}}])])
 await assert.rejects(f.db.exec('commit'),/lacks atomic posting receipt/);await f.db.exec('rollback')
 await f.db.exec('begin')
 await f.db.query("insert into job_cost_entries(org_id,project_id,cost_code_id,source_type,source_id,incurred_on,cost_cents,status,is_billable,metadata) values($1,$2,$3,'payroll_correction',$4,'2026-09-20',100,'posted',false,'{}')",[org,id(4),id(5),id(797)])
 await assert.rejects(f.db.exec('commit'),/lacks atomic posting receipt/);await f.db.exec('rollback')
})
test('export schema 16 independently verifies actual corrective money and populated restore preserves exact retry and guards',async t=>{
 const f=await correctionPostingFixture(t);await postCorrection(f);const {tables}=await receipt(f),archive=bundle(f,tables)
 assert.equal(BOOKS_EXPORT_SCHEMA_VERSION,34);assert.equal(verifyBooksExportBundle(archive).valid,true,JSON.stringify(verifyBooksExportBundle(archive)))
 for(const mutate of [
  b=>b.tables.job_cost_entries.find(j=>j.source_type==='payroll_correction').cost_cents++,
  b=>b.tables.journal_lines.find(l=>l.entry_id===tables.books_payroll_correction_postings[0].result.journalId).dimensions.payroll_run_id=id(999),
  b=>b.tables.books_payroll_correction_postings[0].result.jobCosts=[],
  b=>b.tables.books_payroll_correction_sources[0].status='withdrawn',
  b=>b.tables.books_payroll_correction_postings=[],
 ]){const bad=structuredClone(archive);mutate(bad);for(const name of EXPORT_TABLES)bad.manifest.tables[name]={rows:bad.tables[name].length,checksum:booksDigest(bad.tables[name])};assert.equal(verifyBooksExportBundle(bad).valid,false)}
 const target=await correctionPostingFixture(t)
 await target.db.exec('set session_replication_role=replica')
 for(const name of [...EXPORT_TABLES].reverse())await target.db.exec(`delete from ${name}`)
 for(const name of EXPORT_TABLES)for(const row of tables[name]){const keys=Object.keys(row);await target.db.query(`insert into ${name}(${keys.map(k=>'"'+k+'"').join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row).map(v=>v&&typeof v==='object'?JSON.stringify(v):v))}
 await target.db.exec('set session_replication_role=origin');assert.deepEqual((await capture(target.db)).tables,tables)
 assert.deepEqual((await postCorrection(target,{digest:f.proposal.plan_digest})).rows[0].result,tables.books_payroll_correction_postings[0].result);await receipt(target)
 await assert.rejects(target.db.exec('delete from books_payroll_correction_postings'),/immutable/)
 const prior=structuredClone(archive);prior.manifest.schemaVersion=15;delete prior.tables.books_payroll_correction_postings;delete prior.manifest.tables.books_payroll_correction_postings
 assert.equal(verifyBooksExportBundle(prior).valid,false,'old version cannot hide new corrective money')
})
test('service role posts with private invoker RPCs and no mutation grants on immutable receipts',async t=>{
 const f=await correctionPostingFixture(t)
 await f.db.exec('grant select,insert,update on all tables in schema public to service_role;revoke update on books_payroll_postings,books_payroll_labor_ownership,books_payroll_correction_postings from service_role;alter role service_role bypassrls;set role service_role')
 await postCorrection(f);await receipt(f)
 assert.deepEqual((await f.db.query("select has_function_privilege('authenticated','post_books_payroll_correction_proposal(uuid,uuid,uuid,uuid,text,text,text)','execute') exposed,has_table_privilege('authenticated','books_payroll_correction_postings','select') salary,has_table_privilege(current_user,'books_payroll_correction_postings','update') mutation,(select prosecdef from pg_proc where proname='post_books_payroll_correction_proposal') definer")).rows[0],{exposed:false,salary:false,mutation:false,definer:false})
 await f.db.exec('reset role')
})

test('a reviewed reduction writes signed negative project cost and reverses the matching unpaid liability only',async t=>{
 const f=await correctionPostingFixture(t,{correctedGrossCents:22000}),before=(await capture(f.db)).tables,result=(await postCorrection(f)).rows[0].result,{tables}=await receipt(f)
 assert.equal(result.jobCosts[0].costCents,-2000)
 const lines=tables.journal_lines.filter(l=>l.entry_id===result.journalId);assert.equal(lines.find(l=>l.dimensions.books_account_classification.code==='2200').debit_cents,2000)
 assert.equal(lines.find(l=>l.dimensions.books_account_classification.code==='5030').credit_cents,2000)
 for(const name of frozen)assert.deepEqual(tables[name],before[name])
})
test('receipt insertion revalidates current controls even if an internal trigger changes evidence after journal/cost writes',async t=>{
 const f=await correctionPostingFixture(t),before=(await capture(f.db)).tables
 await f.db.exec("create function change_corrective_budget() returns trigger language plpgsql as $$begin if new.source_type='payroll_correction' then update budget_lines set cost_code_id=null where id=new.budget_line_id;end if;return new;end$$;create trigger mutate_corrective_budget after insert on job_cost_entries for each row execute function change_corrective_budget()")
 await assert.rejects(postCorrection(f),/evidence changed inside monetary transaction/)
 const after=(await capture(f.db)).tables;for(const name of [...money,...frozen,'budget_lines'])assert.deepEqual(after[name],before[name],name)
})
