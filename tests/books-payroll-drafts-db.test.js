require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {EXPORT_TABLES}=require('../lib/services/books/export-contract'),{parsePayrollDraftEvidence}=require('../lib/services/books/payroll-draft-evidence'),{booksDigest}=require('../lib/services/books/hash')
const {fixture,id,org}=require('./helpers/books-payroll-register-fixture')
const {database,prepare,review,withdraw}=require('./helpers/books-payroll-database')
test('real migration persists immutable preparation, separate review, retry identity and retained withdrawal history',async t=>{
 const {db,evidence}=await database(t)
 assert.equal((await prepare(db,evidence)).rows[0].id,id(6));assert.equal((await prepare(db,evidence)).rows[0].id,id(6))
 await assert.rejects(review(db,evidence,id(50)),/separate/);await assert.rejects(review(db,evidence,id(52)),/separate/)
 const changed=structuredClone(evidence);changed.reconciliation.costVarianceCents++
 await assert.rejects(prepare(db,changed),/different evidence/);await assert.rejects(review(db,changed),/changed/)
 await assert.rejects(db.query("update books_payroll_imports set preparation_notes='Rewritten evidence explanation'"),/immutable/)
 assert.equal((await review(db,evidence)).rows[0].id,id(6));assert.equal((await review(db,evidence)).rows[0].id,id(6))
 await assert.rejects(db.exec('delete from books_payroll_imports'),/cannot be deleted/)
 await withdraw(db);await withdraw(db)
 const row=(await db.query('select status,reviewed_by,withdrawn_by,run from books_payroll_imports')).rows[0]
 assert.equal(row.status,'withdrawn');assert.equal(row.reviewed_by,id(51));assert.equal(row.withdrawn_by,id(50));assert.deepEqual(row.run,evidence.run)
})
test('active worker periods cannot be imported twice and withdrawal releases reservations without deleting evidence',async t=>{
 const {db,evidence}=await database(t);await prepare(db,evidence)
 const second=structuredClone(evidence);second.run.id=id(60);second.run.provider_run_id='RUN-2'
 await assert.rejects(prepare(db,second,'payroll-retry-two'),/already reserved/)
 await withdraw(db);await prepare(db,second,'payroll-retry-two')
 assert.equal(Number((await db.query('select count(*) count from books_payroll_imports')).rows[0].count),2)
})
test('source revisions exclude unrelated billing but new/moved time makes a prepared review stale',async t=>{
 const {db,evidence}=await database(t);await prepare(db,evidence)
 const revision=async()=> (await db.query('select books_payroll_source_revision(capture_books_export_snapshot($1),$2::jsonb) revision',[org,JSON.stringify(evidence.run)])).rows[0].revision
 await db.query('insert into invoices values($1,$2)',[id(61),org]);assert.equal(await revision(),evidence.source_revision)
 await db.query("insert into time_entries(id,org_id,worker_user_id,work_date) values($1,$2,$3,'2026-09-10')",[id(62),org,id(2)])
 assert.notEqual(await revision(),evidence.source_revision);await assert.rejects(review(db,evidence),/revision changed/)
 await withdraw(db)
 assert.equal((await db.query('select status from books_payroll_imports')).rows[0].status,'withdrawn','stale draft can be withdrawn')
})
test('a payroll payment committed after preparation makes independent review stale, including legacy payments outside the work period',async t=>{
 const {db,evidence}=await database(t);await prepare(db,evidence)
 await db.exec('alter table journal_lines add entry_id uuid,add account_id uuid,add project_id uuid,add debit_cents bigint,add credit_cents bigint,add dimensions jsonb')
 await db.query("insert into journal_entries(id,org_id,fact_id,status,source_type,source_id,entry_date) values($1,$2,null,'posted','payroll_settlement',null,'2026-09-18')",[id(91),org])
 await db.query('insert into journal_lines(id,org_id,entry_id,account_id,debit_cents,credit_cents,dimensions) values($1,$2,$3,$4,24000,0,$5::jsonb)',[id(92),org,id(91),id(30),JSON.stringify({payment_reference:'Legacy provider payment'})])
 await db.query('insert into journal_lines(id,org_id,entry_id,account_id,debit_cents,credit_cents,dimensions) values($1,$2,$3,$4,0,6000,$5::jsonb)',[id(93),org,id(91),id(31),JSON.stringify({payment_reference:'Legacy withholding'})])
 await db.query('insert into journal_lines(id,org_id,entry_id,account_id,debit_cents,credit_cents,dimensions) values($1,$2,$3,$4,0,18000,$5::jsonb)',[id(94),org,id(91),id(95),'{}'])
 const revision=(await db.query('select books_payroll_source_revision(capture_books_export_snapshot($1),$2::jsonb) revision',[org,JSON.stringify(evidence.run)])).rows[0].revision
 assert.notEqual(revision,evidence.source_revision)
 await assert.rejects(review(db,evidence),/revision changed/)
 assert.equal((await db.query('select status from books_payroll_imports')).rows[0].status,'draft','stale review cannot approve a potentially already-paid run')
 await withdraw(db)
 assert.equal((await db.query('select status from books_payroll_imports')).rows[0].status,'withdrawn')
})
test('all statuses preserve original source/version while current pointers and harmless annotations can advance',async t=>{
 const {db,evidence}=await database(t);await prepare(db,evidence)
 await assert.rejects(db.exec('delete from files'),/history cannot/)
 await assert.rejects(db.exec("update files set checksum=repeat('f',64)"),/metadata is immutable/)
 await assert.rejects(db.exec('delete from doc_versions'),/version evidence is immutable/)
 await assert.rejects(db.exec("update doc_versions set checksum=repeat('f',64)"),/version evidence is immutable/)
 await db.exec("update doc_versions set notes='Helpful annotation'" )
 await db.query('insert into doc_versions(id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum) values($1,$2,$3,$4,$5,$6,4,$7)',[id(70),org,id(8),org+'/payroll/new.csv','New.csv','text/csv','f'.repeat(64)])
 await db.query('update files set current_version_id=$1,storage_path=$2,checksum=$3,size_bytes=4 where id=$4',[id(70),org+'/payroll/new.csv','f'.repeat(64),id(8)])
 await review(db,evidence);await withdraw(db)
 await assert.rejects(db.query('delete from doc_versions where id=$1',[id(7)]),/immutable/)
})
test('browser roles cannot read payroll registers or execute preparation/review, even with active member identity',async t=>{
 const {db,evidence}=await database(t)
 const flags=(await db.query("select has_table_privilege('authenticated','books_payroll_imports','select') browser,has_function_privilege('authenticated','prepare_books_payroll_import(uuid,uuid,jsonb,text,text)','execute') prepare,has_function_privilege('anon','review_books_payroll_import(uuid,uuid,uuid,jsonb,text)','execute') review,has_function_privilege('service_role','prepare_books_payroll_import(uuid,uuid,jsonb,text,text)','execute') service")).rows[0]
 assert.deepEqual(flags,{browser:false,prepare:false,review:false,service:true})
 await db.exec('set role authenticated');await assert.rejects(prepare(db,evidence),/permission denied/);await assert.rejects(db.exec('select * from books_payroll_imports'),/permission denied/);await db.exec('reset role')
})
test('standalone draft evidence rebuilds the accounting plan, rejecting rehashed invented journal amounts',()=>{
 const {evidence}=fixture();assert.deepEqual(parsePayrollDraftEvidence(evidence),evidence)
 for(const mutate of [e=>e.run.employees[0].gross_cents++,e=>e.source_proof.checksum='0'.repeat(64),e=>e.reconciliation.costVarianceCents++]){const copy=structuredClone(evidence);mutate(copy);assert.throws(()=>parsePayrollDraftEvidence(copy),/digest|identity/)}
 const forged=structuredClone(evidence);forged.reconciliation.draft.lines[0].debitCents++;forged.reconciliation_digest=booksDigest(forged.reconciliation)
 assert.throws(()=>parsePayrollDraftEvidence(forged),/accounting plan differs/)
})
test('native job-cost evidence is claimed once and exact frozen wages/receipt linkage are required',async t=>{
 const {db,evidence}=await database(t),timestamp='2026-09-10T12:00:00.000001Z'
 const basis={version:1,org_id:org,job_cost_id:id(80),time_entry_id:id(81),worker_id:id(2),project_id:id(4),cost_code_id:id(5),incurred_on:'2026-09-10',source_revision:timestamp,gross_cents:24000,estimated_burden_cents:12000,cost_cents:36000,cost_policy_version:1,is_overtime:false,is_double_time:false}
 await db.query("insert into time_entries(id,org_id,worker_user_id,work_date) values($1,$2,$3,'2026-09-10')",[id(81),org,id(2)])
 await db.query("insert into job_cost_entries(id,org_id,project_id,status,source_type,source_id,incurred_on,cost_cents,updated_at,metadata) values($1,$2,$3,'posted','time_entry',$4,'2026-09-10',36000,$5,$6::jsonb)",[id(80),org,id(4),id(81),timestamp,JSON.stringify({worker_user_id:id(2)})])
 await db.query("insert into accounting_facts values($1,$2,'labor_cost',$3,$4::jsonb,'2026-09-10')",[id(82),org,id(80),JSON.stringify({amount_cents:36000,project_id:id(4),dimensions:{cost_code_id:id(5)},labor_basis:basis})])
 await db.query("insert into journal_entries(id,org_id,fact_id,status,source_type,source_id,entry_date) values($1,$2,$3,'posted','labor_cost',$4,'2026-09-10')",[id(83),org,id(82),id(80)])
 await db.query("insert into books_projection_receipts values($1,$2,'labor_cost',$3,$4,$5,$6)",[id(84),org,id(80),id(82),id(83),timestamp])
 await db.exec('alter table journal_lines add entry_id uuid,add account_id uuid,add project_id uuid,add debit_cents bigint,add credit_cents bigint,add dimensions jsonb')
 for(const [index,code,debit,credit] of [[0,'5030',36000,0],[1,'2200',0,36000]]){
  const account=fixture().postingAccounts.find(row=>row.code===code),dimensions={cost_code_id:id(5),labor_job_cost_id:id(80),labor_time_entry_id:id(81),labor_worker_id:id(2),labor_basis_hash:booksDigest(basis),books_account_classification:{version:1,account_id:account.id,code,account_type:account.account_type,subtype:account.subtype}}
  await db.query('insert into journal_lines values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[id(86+index),org,id(83),account.id,id(4),debit,credit,JSON.stringify(dimensions)])
 }

 evidence.run.employees[0].allocations[0].labor_evidence_ids=[id(80)]
 evidence.labor_evidence=[{id:id(80),org_id:org,worker_id:id(2),project_id:id(4),cost_code_id:id(5),account_code:'5030',incurred_on:'2026-09-10',fact_id:id(82),journal_id:id(83),source_revision:timestamp,gross_cents:24000,estimated_burden_cents:12000,cost_cents:36000,clearing_cents:36000}]
 const {reconcilePayrollImport}=require('../lib/services/books/payroll-import-rules'),{payrollDraftEvidence}=require('../lib/services/books/payroll-draft-evidence')
 const accounts=fixture().postingAccounts,plan=reconcilePayrollImport(evidence.run,evidence.labor_evidence,accounts)
 const rebuilt=payrollDraftEvidence({...plan,postingAccounts:accounts,laborEvidence:evidence.labor_evidence,sourceProof:evidence.source_proof,columnMapping:evidence.column_mapping,sourceMappingDigest:booksDigest({source:evidence.source_proof,columns:evidence.column_mapping,workers:plan.run.employees.map(worker=>({worker_id:worker.worker_id,employee_reference:worker.employee_reference,allocations:worker.allocations}))})},evidence.source_revision)
 Object.assign(evidence,rebuilt)
 evidence.source_revision=(await db.query('select books_payroll_source_revision(capture_books_export_snapshot($1),$2::jsonb) revision',[org,JSON.stringify(evidence.run)])).rows[0].revision
 const wrong=structuredClone(evidence);wrong.labor_evidence[0].gross_cents++
 await assert.rejects(prepare(db,wrong),/original labor evidence differs/)
 await prepare(db,evidence)
 const other=structuredClone(evidence);other.run.id=id(85)
 await assert.rejects(prepare(db,other,'another-labor-claim'),/already reserved/)
 assert.equal(Number((await db.query('select count(*) count from books_payroll_imports')).rows[0].count),1)
 const {verifyBooksExportBundle,BOOKS_EXPORT_SCHEMA_VERSION}=require('../lib/services/books/export-contract'),{historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive')
 const tables=(await db.query('select capture_books_export_snapshot($1) snapshot',[org])).rows[0].snapshot.tables
 const bundle={tables,manifest:{schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:[{id:id(8),storagePath:evidence.source_proof.storage_path,sizeBytes:3,checksum:evidence.source_proof.checksum}],supportingHistoricalFiles:historicalDocumentInventory(tables,org)},supportingObjects:[{fileId:id(8),dataBase64:Buffer.from('abc').toString('base64')}],supportingHistoricalObjects:[]}
 assert.equal(verifyBooksExportBundle(bundle).valid,true,JSON.stringify(verifyBooksExportBundle(bundle)))
 for(const row of bundle.tables.journal_lines){if(row.debit_cents)row.debit_cents++;if(row.credit_cents)row.credit_cents++}
 bundle.manifest.tables.journal_lines.checksum=booksDigest(bundle.tables.journal_lines)
 const invalid=verifyBooksExportBundle(bundle);assert.equal(invalid.valid,false);assert.equal(invalid.unbalancedEntryIds.length,0,'balanced but incorrect original wage journals still fail payroll evidence verification')
})
test('schema 9 archive verifies and extracts original payroll sources and restores retained review history',async t=>{
 const {db,evidence}=await database(t);await prepare(db,evidence);await review(db,evidence);await withdraw(db)
 const {BOOKS_EXPORT_SCHEMA_VERSION,verifyBooksExportBundle}=require('../lib/services/books/export-contract'),{historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive')
 const snapshot=(await db.query('select capture_books_export_snapshot($1) snapshot',[org])).rows[0].snapshot,tables=snapshot.tables
 const manifest={schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:[{id:id(8),storagePath:evidence.source_proof.storage_path,sizeBytes:3,checksum:evidence.source_proof.checksum}],supportingHistoricalFiles:historicalDocumentInventory(tables,org)}
 const bundle={tables,manifest,supportingObjects:[{fileId:id(8),dataBase64:Buffer.from('abc').toString('base64')}],supportingHistoricalObjects:[]}
 assert.equal(verifyBooksExportBundle(bundle).valid,true,JSON.stringify(verifyBooksExportBundle(bundle)))
 const bad=structuredClone(bundle);bad.tables.books_payroll_imports[0].reconciliation.costVarianceCents++;bad.manifest.tables.books_payroll_imports.checksum=booksDigest(bad.tables.books_payroll_imports)
 assert.equal(verifyBooksExportBundle(bad).valid,false)
 const missing=structuredClone(bundle);delete missing.tables.books_payroll_imports;delete missing.manifest.tables.books_payroll_imports;assert.equal(verifyBooksExportBundle(missing).valid,false)
 const {mkdtempSync,writeFileSync,readFileSync,rmSync}=fs,{tmpdir}=require('node:os'),{gzipSync}=require('node:zlib')
 const directory=mkdtempSync(path.join(tmpdir(),'books-payroll-recovery-'));t.after(()=>rmSync(directory,{recursive:true,force:true}))
 const archive=path.join(directory,'archive.json.gz');writeFileSync(archive,gzipSync(JSON.stringify(bundle)))
 const {extractSupportingFiles}=require('../scripts/verify-books-export.cjs'),root=path.join(directory,'objects')
 assert.equal((await extractSupportingFiles(archive,root)).verifiedFiles,1);assert.equal(readFileSync(path.join(root,evidence.source_proof.storage_path),'utf8'),'abc')
 const target=(await database(t)).db
 await target.exec('set session_replication_role=replica')
 for(const name of EXPORT_TABLES)await target.exec(`delete from ${name}`)
 for(const [name,rows] of Object.entries(tables))for(const row of rows){const keys=Object.keys(row),values=Object.values(row).map(value=>value&&typeof value==='object'?JSON.stringify(value):value);await target.query(`insert into ${name}(${keys.map(key=>'"'+key+'"').join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,values)}
 await target.exec('set session_replication_role=origin')
 const restored=(await target.query('select capture_books_export_snapshot($1) snapshot',[org])).rows[0].snapshot
 assert.deepEqual(restored.tables,tables,'every archived table row, actor, digest and transition timestamp survives scoped recovery')
 await assert.rejects(target.query("update books_payroll_imports set preparation_notes='Changed after restore'"),/immutable/)
 await assert.rejects(target.query('delete from doc_versions where id=$1',[id(7)]),/immutable/)
})
