require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {sources,prepareProposal,reviewProposal,withdrawProposal}=require('./helpers/books-payroll-posting-proposal-fixture')
const {capture,scenario}=require('./helpers/books-payroll-workflow-fixture')
const {prepare,review,withdraw}=require('./helpers/books-payroll-database')
const {id,org}=require('./helpers/books-payroll-register-fixture')
const {parsePayrollPostingProposal}=require('../lib/services/books/payroll-posting-proposal-evidence')
const {booksDigest}=require('../lib/services/books/hash')
function archive(f,tables){
 const {BOOKS_EXPORT_SCHEMA_VERSION}=require('../lib/services/books/export-contract'),{historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive')
 return {tables,manifest:{schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:tables.files.map(file=>({id:file.id,storagePath:file.storage_path,sizeBytes:file.size_bytes,checksum:file.checksum})),supportingHistoricalFiles:historicalDocumentInventory(tables,org)},supportingObjects:[{fileId:id(8),dataBase64:f.registerBytes.toString('base64')},{fileId:id(70),dataBase64:f.paymentBytes.toString('base64')}],supportingHistoricalObjects:[]}
}
test('full dated proposal is immutable, independently reviewed and replayable without money/source writes',async t=>{
 const f=await sources(t),before=(await capture(f.db)).tables;await prepareProposal(f)
 for(const actor of [id(2),id(50),id(52)])await assert.rejects(reviewProposal(f,actor),/separate active/)
 await reviewProposal(f);await reviewProposal(f)
 const after=(await capture(f.db)).tables,row=after.books_payroll_posting_proposals[0]
 assert.equal(row.status,'reviewed');assert.deepEqual(parsePayrollPostingProposal(row,f.parent,f.paymentRecord).plan,f.plan)
 for(const name of ['journal_entries','journal_lines','job_cost_entries','billable_costs','books_payroll_imports','books_payroll_payment_reviews'])assert.deepEqual(after[name],before[name])
 await assert.rejects(f.db.exec("update books_payroll_posting_proposals set plan=jsonb_set(plan,'{outstanding,netPayCents}','1')"),/immutable/)
 await assert.rejects(f.db.exec('delete from books_payroll_posting_proposals'),/history cannot/)
 await withdrawProposal(f);await withdrawProposal(f)
 const retired=(await capture(f.db)).tables.books_payroll_posting_proposals[0];assert.equal(retired.reviewed_by,id(51));assert.deepEqual(retired.plan,f.plan)
})
test('fresh hashes cannot persist fabricated proposal; active duplicate and mismatched retries fail',async t=>{
 const f=await sources(t),forged=structuredClone(f.plan);forged.outstanding.netPayCents++;delete forged.digest;forged.digest=booksDigest(forged)
 await assert.rejects(prepareProposal(f,forged),/independently reconstructed/)
 await prepareProposal(f);await prepareProposal(f)
 await assert.rejects(prepareProposal(f,f.plan,id(231),'other-proposal-retry-key'),/unique constraint/)
 await assert.rejects(prepareProposal(f,f.plan,id(231)),/different intent/)
 await withdrawProposal(f);assert.equal((await prepareProposal(f)).rows[0].id,id(230))
})
test('stale source blocks review while withdrawal preserves original proof',async t=>{
 const f=await sources(t);await prepareProposal(f)
 await f.db.exec('update billable_costs set markup_cents=4001,billable_cents=40001')
 await assert.rejects(reviewProposal(f),/source revision changed/)
 await withdrawProposal(f)
 const row=(await capture(f.db)).tables.books_payroll_posting_proposals[0]
 assert.deepEqual(parsePayrollPostingProposal(row,f.parent,f.paymentRecord).plan,f.plan)
})
test('withdrawing either original parent or payment ownership cascades proposal retirement and preserves review history',async t=>{
 for(const source of ['parent','payment']){
  const f=await sources(t);await prepareProposal(f);await reviewProposal(f)
  if(source==='parent')await f.db.query('select withdraw_books_payroll_import($1,$2,$3,$4)',[org,f.run.id,id(50),'Replaced incorrect provider withholding evidence. '.repeat(84).slice(0,4000)])
  else await f.db.query('select withdraw_books_payroll_payment_review($1,$2,$3,$4)',[org,f.payment.request.id,id(50),'Original payment ownership superseded'])
  const tables=(await capture(f.db)).tables,row=tables.books_payroll_posting_proposals[0]
  assert.equal(row.status,'withdrawn');assert.equal(row.reviewed_by,id(51));assert.match(row.withdrawal_reason,/withdrawn/)
  assert.deepEqual(parsePayrollPostingProposal(row,tables.books_payroll_imports[0],tables.books_payroll_payment_reviews[0]).plan,f.plan)
  if(source==='parent')assert.ok(row.withdrawal_reason.length>4000,'cascade preserves full original reason plus source context')
  const {verifyBooksExportBundle}=require('../lib/services/books/export-contract');assert.equal(verifyBooksExportBundle(archive(f,tables)).valid,true,JSON.stringify(verifyBooksExportBundle(archive(f,tables))))
  assert.equal((await prepareProposal(f)).rows[0].id,id(230),'exact retry resolves historical original resource')
 }
})
test('proposal table and callable workflows remain private service-only invoker operations',async t=>{
 const f=await sources(t)
 const flags=(await f.db.query("select has_table_privilege('authenticated','books_payroll_posting_proposals','select') browser,has_function_privilege('anon','prepare_books_payroll_posting_proposal(uuid,uuid,uuid,uuid,jsonb,text,text,text)','execute') anon,has_function_privilege('service_role','review_books_payroll_posting_proposal(uuid,uuid,uuid,jsonb,text,text)','execute') service")).rows[0]
 assert.deepEqual(flags,{browser:false,anon:false,service:true})
})
test('proposal reviewer cannot be the original payment preparer even when distinct from both other preparers',async t=>{
 const f=await sources(t,{paymentActor:id(2)})
 await prepareProposal(f,f.plan,id(230),'full-proposal-retry-key',id(50))
 await assert.rejects(reviewProposal(f,id(2)),/separate active reviewer/)
 await reviewProposal(f,id(51))
 const row=(await capture(f.db)).tables.books_payroll_posting_proposals[0]
 assert.equal(row.prepared_by,id(50));assert.equal(f.paymentRecord.prepared_by,id(2));assert.equal(row.reviewed_by,id(51))
})
test('first payroll with no historical payment ownership persists and reviews a nullable payment reference',async t=>{
 const f=await scenario(t,true);await prepare(f.db,f.evidence);await review(f.db,f.evidence)
 f.parent=(await capture(f.db)).tables.books_payroll_imports[0]
 const {payrollPostingPlan}=require('../lib/services/books/payroll-posting-plan');f.plan=payrollPostingPlan(f.parent,null)
 await prepareProposal(f);await reviewProposal(f)
 const row=(await capture(f.db)).tables.books_payroll_posting_proposals[0]
 assert.equal(row.payment_review_id,null);assert.equal(row.status,'reviewed');assert.deepEqual(parsePayrollPostingProposal(row,f.parent,null).plan,f.plan)
 await withdrawProposal(f)
})
test('schema 11 replays and restores proposal history and rejects fabricated journals and orphan active approval',async t=>{
 const f=await sources(t);await prepareProposal(f);await reviewProposal(f);await withdraw(f.db)
 const {verifyBooksExportBundle,BOOKS_EXPORT_SCHEMA_VERSION,EXPORT_TABLES}=require('../lib/services/books/export-contract')
 const tables=(await capture(f.db)).tables,bundle=archive(f,tables)
 assert.equal(BOOKS_EXPORT_SCHEMA_VERSION,32);assert.equal(verifyBooksExportBundle(bundle).valid,true,JSON.stringify(verifyBooksExportBundle(bundle)))
 const fs=require('node:fs'),path=require('node:path'),{tmpdir}=require('node:os'),{gzipSync}=require('node:zlib'),{verifyFileCopy,extractSupportingFiles}=require('../scripts/verify-books-export.cjs')
 const directory=fs.mkdtempSync(path.join(tmpdir(),'payroll-proposal-recovery-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const archivePath=path.join(directory,'archive.gz');fs.writeFileSync(archivePath,gzipSync(JSON.stringify(bundle)))
 assert.equal((await verifyFileCopy(archivePath)).verifiedFiles,2);assert.equal((await extractSupportingFiles(archivePath,path.join(directory,'objects'))).verifiedFiles,2)
 for(const mutate of [r=>r.reviewed_by=id(50),r=>r.status='reviewed',r=>{r.plan.outstanding.netPayCents++;delete r.plan.digest;r.plan.digest=booksDigest(r.plan);r.plan_digest=r.plan.digest}]){const b=structuredClone(bundle);mutate(b.tables.books_payroll_posting_proposals[0]);b.manifest.tables.books_payroll_posting_proposals.checksum=booksDigest(b.tables.books_payroll_posting_proposals);assert.equal(verifyBooksExportBundle(b).valid,false)}
 const target=(await scenario(t)).db;await target.exec('set session_replication_role=replica')
 for(const name of EXPORT_TABLES)await target.exec(`delete from ${name}`)
 for(const [name,rows] of Object.entries(tables))for(const row of rows){const keys=Object.keys(row);await target.query(`insert into ${name}(${keys.map(k=>'"'+k+'"').join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row).map(v=>v&&typeof v==='object'?JSON.stringify(v):v))}
 await target.exec('set session_replication_role=origin');assert.deepEqual((await capture(target)).tables,tables)
 await assert.rejects(target.exec('delete from books_payroll_posting_proposals'),/history cannot/)
})
