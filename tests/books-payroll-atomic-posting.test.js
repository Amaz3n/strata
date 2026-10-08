require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {ready,post}=require('./helpers/books-payroll-atomic-fixture')
const {capture}=require('./helpers/books-payroll-workflow-fixture')
const {withdraw}=require('./helpers/books-payroll-database')
const {id,org}=require('./helpers/books-payroll-register-fixture')
test('atomic reviewed payroll posts exact GL and project cost delta while preserving original hourly billing',async t=>{
 const f=await ready(t),before=(await capture(f.db)).tables
 assert.equal((await f.db.query('select lock_books_payroll_posting_context($1,$2) controls',[org,id(230)])).rows[0].controls.postingImplemented,true)
 const result=(await post(f)).rows[0].result
 assert.equal(result.journals.length,1);assert.equal(result.jobCostCorrections.length,f.plan.allocations[0].construction.jobCostCorrections.length)
 const after=(await capture(f.db)).tables
 for(const name of ['time_entries','billable_costs','books_payroll_imports','books_payroll_posting_proposals'])assert.deepEqual(after[name],before[name])
 const cost=(await f.db.query("select sum(cost_cents)::bigint total from job_cost_entries where org_id=$1 and status='posted'",[org])).rows[0].total
 assert.equal(Number(cost),27000)
 assert.equal(Number((await f.db.query("select sum(l.debit_cents-l.credit_cents)::bigint total from journal_lines l join gl_accounts a on a.id=l.account_id where a.code='5030'")).rows[0].total),27000)
 assert.equal(Number((await f.db.query("select sum(l.credit_cents-l.debit_cents)::bigint total from journal_lines l join gl_accounts a on a.id=l.account_id where a.code='2200'")).rows[0].total),f.plan.outstanding.netPayCents)
 const receipt=(await f.db.query('select * from books_payroll_postings')).rows[0];assert.equal(receipt.proposal_id,id(230));assert.deepEqual(receipt.result,result)
 assert.equal((await f.db.query('select assert_books_payroll_posting_receipt($1::jsonb) valid',[JSON.stringify(receipt)])).rows[0].valid,true)
 assert.deepEqual((await post(f)).rows[0].result,result);assert.equal((await f.db.query('select count(*)::int n from books_payroll_postings')).rows[0].n,1)
 await assert.rejects(post(f,{key:'different-posting-key'}),/already posted/)
 await assert.rejects(post(f,{notes:'Changed notes for same retry identity'}),/different intent/)
})
test('unresolved cost-plus or closed period blocks the entire payroll commit',async t=>{
 const f=await ready(t,{billing:'cost_plus_markup'}),before=(await capture(f.db)).tables
 await assert.rejects(post(f),/unresolved accounting calendar or construction controls/)
 assert.deepEqual((await capture(f.db)).tables,before)
})
test('mid-transaction project correction failure rolls back journals, facts and receipt',async t=>{
 const f=await ready(t),before=(await capture(f.db)).tables
 await f.db.exec("create function fail_payroll_cost() returns trigger language plpgsql as $$begin if new.source_type='payroll_import' then raise exception 'Injected project correction failure';end if;return new;end $$;create trigger fail_payroll_cost before insert on job_cost_entries for each row execute function fail_payroll_cost()")
 await assert.rejects(post(f),/Injected project correction failure/);assert.deepEqual((await capture(f.db)).tables,before)
 await f.db.exec('drop trigger fail_payroll_cost on job_cost_entries');await post(f)
})
test('posted payroll source cannot be withdrawn, project corrections changed, or GL alone reversed',async t=>{
 const f=await ready(t),result=(await post(f)).rows[0].result
 await assert.rejects(withdraw(f.db),/coordinated correction/)
 await assert.rejects(f.db.query('select withdraw_books_payroll_posting_proposal($1,$2,$3,$4)',[org,id(230),id(2),'Withdraw source already posted payroll']),/coordinated correction/)
 await assert.rejects(f.db.query('update job_cost_entries set cost_cents=cost_cents+1 where id=$1',[result.jobCostCorrections[0].jobCostId]),/coordinated correction/)
 await assert.rejects(f.db.query('delete from books_payroll_postings'),/immutable/)
 const draft={entry_date:'2026-09-20',entry_kind:'reversal',memo:'GL only reversal',posting_key:'invalid-payroll-reversal',policy_version:1,reversal_of_entry_id:result.journals[0].journalId,created_by:id(2)}
 await assert.rejects(f.db.query('select reverse_books_journal_entry($1,$2,$3::jsonb,$4::jsonb)',[org,result.journals[0].journalId,JSON.stringify(draft),JSON.stringify([{account_id:id(30),line_no:1,debit_cents:10,credit_cents:0},{account_id:id(32),line_no:2,debit_cents:0,credit_cents:10}])]),/coordinated project cost/)
})
test('later-month original settlement produces two dated journals without paying cash twice; retry survives close',async t=>{
 const f=await ready(t,{paid:true,laterOriginal:true})
 const cash=async()=>Number((await f.db.query("select sum(l.credit_cents-l.debit_cents)::bigint amount from journal_lines l join gl_accounts a on a.id=l.account_id where a.code='1000'")).rows[0].amount)
 const originalCash=await cash(),result=(await post(f)).rows[0].result
 assert.deepEqual(result.journals.map(row=>row.entryDate),['2026-09-15','2026-10-02']);assert.equal(await cash(),originalCash);assert.equal(originalCash,18000)
 assert.equal(Number((await f.db.query("select sum(l.credit_cents-l.debit_cents)::bigint amount from journal_lines l join gl_accounts a on a.id=l.account_id where a.code='2200'")).rows[0].amount),0)
 await f.db.exec("update accounting_periods set status='closed'")
 assert.deepEqual((await post(f)).rows[0].result,result)
 await assert.rejects(f.db.query('select withdraw_books_payroll_payment_review($1,$2,$3,$4)',[org,id(72),id(50),'Withdraw original posted payment allocation']),/coordinated correction/)
})
test('closed calendar and stale reviewed source prevent every payroll write',async t=>{
 const f=await ready(t);await f.db.exec("update accounting_periods set status='closed'");let before=(await capture(f.db)).tables
 await assert.rejects(post(f),/unresolved accounting calendar/);assert.deepEqual((await capture(f.db)).tables,before)
 await f.db.exec("update accounting_periods set status='open';update billable_costs set markup_cents=4001,billable_cents=40001")
 before=(await capture(f.db)).tables;await assert.rejects(post(f),/source revision changed/);assert.deepEqual((await capture(f.db)).tables,before)
})
test('schema 13 archive proves actual posted payroll rows and rejects fabricated receipt/cost/GL evidence',async t=>{
 const f=await ready(t,{paid:true}),unposted=(await capture(f.db)).tables;await post(f)
 const {booksDigest}=require('../lib/services/books/hash'),{verifyBooksExportBundle,BOOKS_EXPORT_SCHEMA_VERSION}=require('../lib/services/books/export-contract'),{historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive')
 const tables=(await capture(f.db)).tables
 const bundle={tables,manifest:{schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:tables.files.map(file=>({id:file.id,storagePath:file.storage_path,sizeBytes:file.size_bytes,checksum:file.checksum})),supportingHistoricalFiles:historicalDocumentInventory(tables,org)},supportingObjects:[{fileId:id(8),dataBase64:f.registerBytes.toString('base64')},{fileId:id(70),dataBase64:f.paymentBytes.toString('base64')}],supportingHistoricalObjects:[]}
 require('../lib/services/books/payroll-posting-receipt').verifyPayrollPostingReceipt(tables.books_payroll_postings[0],tables,{requireNativeOwnership:true})
 assert.equal(BOOKS_EXPORT_SCHEMA_VERSION,34);assert.equal(verifyBooksExportBundle(bundle).valid,true,JSON.stringify(verifyBooksExportBundle(bundle)))
 const legacy=structuredClone(bundle);legacy.tables=unposted;delete legacy.tables.books_payroll_postings;legacy.manifest.schemaVersion=11;legacy.manifest.tables=Object.fromEntries(Object.entries(legacy.tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}]));assert.equal(verifyBooksExportBundle(legacy).valid,true,'schema 11 archives without posted ownership remain supported')
 const orphan=structuredClone(bundle);delete orphan.tables.books_payroll_postings;orphan.manifest.schemaVersion=11;delete orphan.manifest.tables.books_payroll_postings;assert.equal(verifyBooksExportBundle(orphan).valid,false,'legacy version cannot conceal new payroll money without ownership')
 const fs=require('node:fs'),path=require('node:path'),{tmpdir}=require('node:os'),{gzipSync}=require('node:zlib'),{verifyFileCopy,extractSupportingFiles}=require('../scripts/verify-books-export.cjs')
 const directory=fs.mkdtempSync(path.join(tmpdir(),'payroll-posted-recovery-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const archivePath=path.join(directory,'archive.gz');fs.writeFileSync(archivePath,gzipSync(JSON.stringify(bundle)))
 assert.equal((await verifyFileCopy(archivePath)).verifiedFiles,2);assert.equal((await extractSupportingFiles(archivePath,path.join(directory,'objects'))).verifiedFiles,2)
 const {EXPORT_TABLES}=require('../lib/services/books/export-contract'),target=await ready(t,{paid:true})
 await target.db.exec('set session_replication_role=replica')
 for(const name of EXPORT_TABLES)await target.db.exec(`delete from ${name}`)
 for(const [name,rows] of Object.entries(tables))for(const row of rows){const keys=Object.keys(row);await target.db.query(`insert into ${name}(${keys.map(k=>'"'+k+'"').join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row).map(v=>v&&typeof v==='object'?JSON.stringify(v):v))}
 await target.db.exec('set session_replication_role=origin');assert.deepEqual((await capture(target.db)).tables,tables)
 assert.deepEqual((await post(target,{digest:f.plan.digest})).rows[0].result,tables.books_payroll_postings[0].result)
 await assert.rejects(target.db.exec('delete from books_payroll_postings'),/immutable/)
 await assert.rejects(withdraw(target.db),/coordinated correction/)
 const privileges=(await f.db.query("select has_table_privilege('authenticated','books_payroll_postings','select') browser_read,has_function_privilege('authenticated','post_books_payroll_proposal(uuid,uuid,uuid,uuid,text,text,text)','execute') browser_post,has_function_privilege('service_role','post_books_payroll_proposal(uuid,uuid,uuid,uuid,text,text,text)','execute') service_post")).rows[0]
 assert.deepEqual(privileges,{browser_read:false,browser_post:false,service_post:true})

 for(const mutate of [b=>b.tables.books_payroll_postings[0].result.journals=[],b=>b.tables.books_payroll_postings[0].result.planDigest='a'.repeat(64),b=>b.tables.job_cost_entries.find(row=>row.source_type==='payroll_import').cost_cents++,b=>b.tables.journal_lines.find(row=>row.dimensions.payroll_posting_id).dimensions.payroll_allocation_id=id(99),b=>b.tables.accounting_facts.find(row=>row.source_type==='payroll_import').payload.draft.lines[0].debitCents++,b=>b.tables.accounting_facts.find(row=>row.source_type==='payroll_import').payload_hash='a'.repeat(64),b=>b.tables.books_payroll_postings[0].posted_at='2026-10-04T23:59:59Z']){
  const bad=structuredClone(bundle);mutate(bad);for(const [name,rows] of Object.entries(bad.tables))bad.manifest.tables[name].checksum=booksDigest(rows)
  assert.equal(verifyBooksExportBundle(bad).valid,false,'recomputed table checksum cannot hide fabricated actual payroll evidence')
 }
})
test('raw journal/fact inserts cannot bypass payroll atomic ownership or append lines to a posted payroll',async t=>{
 const f=await ready(t),result=(await post(f)).rows[0].result
 const entry={entry_date:'2026-09-20',entry_kind:'adjusting',memo:'Unowned payroll journal',posting_key:'stray-payroll-journal',policy_version:1,source_type:'payroll_import',source_id:id(6),created_by:id(2)}
 const lines=[{account_id:id(32),line_no:1,debit_cents:10,credit_cents:0},{account_id:id(30),line_no:2,debit_cents:0,credit_cents:10}]
 await assert.rejects(f.db.query('select post_books_journal_entry($1,$2::jsonb,$3::jsonb)',[org,JSON.stringify(entry),JSON.stringify(lines)]),/inventory differs/)
 await assert.rejects(f.db.query("insert into accounting_facts(org_id,source_type,source_id,source_version,fact_kind,occurred_at,accounting_date,payload,payload_hash,policy_version,idempotency_key) values($1,'payroll_import',$2,99,'payroll_reconciliation',now(),'2026-09-20','{}',$3,1,'stray-payroll-fact')",[org,id(6),'a'.repeat(64)]),/inventory differs/)
 await assert.rejects(f.db.query('insert into journal_lines(org_id,entry_id,line_no,account_id,debit_cents,credit_cents) values($1,$2,99,$3,10,0)',[org,result.journals[0].journalId,id(32)]),/immutable/)
 assert.deepEqual((await post(f)).rows[0].result,result)
})
test('project and cost-code ownership changes after review cannot create cross-organization payroll costs',async t=>{
 for(const [table,identifier] of [['projects',id(4)],['cost_codes',id(5)]]){
  const f=await ready(t);await f.db.query(`update ${table} set org_id=$1 where id=$2`,[id(99),identifier]);const before=(await capture(f.db)).tables
  await assert.rejects(post(f),/organization scope changed|organization.*project|organization.*cost/i)
  assert.deepEqual((await capture(f.db)).tables,before)
 }
})
