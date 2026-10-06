require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {fixture,id,org}=require('./helpers/books-payroll-register-fixture')
const {database,prepare,review,withdraw}=require('./helpers/books-payroll-database')
const {payrollWorkflowSources,payrollWorkflowEvidence}=require('../lib/services/books/payroll-workflow-evidence')
const {payrollDraftEvidence,parsePayrollDraftEvidence}=require('../lib/services/books/payroll-draft-evidence')
const {reconcilePayrollImport}=require('../lib/services/books/payroll-import-rules')
const {booksDigest}=require('../lib/services/books/hash')
const {payrollReconciliationFromSnapshot}=require('../lib/services/books/payroll-labor-snapshot')
const {payrollRegisterFields}=require('../lib/services/books/payroll-register-csv')
const {createHash}=require('node:crypto')
const {scenario,capture,revision}=require('./helpers/books-payroll-workflow-fixture')
test('SQL and JS select the same minimal complete native job/budget/billing/account source witness',async t=>{
 const f=await scenario(t,true)
 const sql=(await f.db.query('select books_payroll_workflow_sources($1::jsonb,$2::jsonb) sources',[JSON.stringify(f.snapshot),JSON.stringify(f.run)])).rows[0].sources
 assert.deepEqual(sql,f.workflow.sourceTables)
 assert.equal(f.workflow.sourceTables.job_cost_entries.length,1);assert.equal(f.workflow.sourceTables.budget_lines.length,1)
 assert.equal(f.workflow.sourceTables.billable_costs.length,1);assert.equal(f.workflow.sourceTables.journal_entries.length,0,'native accrued labor is already retained in original evidence')
 assert.equal(f.workflow.constructionImpact.projectCostDeltaCents,-9000)
 assert.equal(f.workflow.constructionImpact.allocations[0].budgetLineId,id(84))
 assert.equal(f.workflow.constructionImpact.allocations[0].billing.action,'review_cost_plus_correction')
 const reordered=structuredClone(f.snapshot.tables);for(const rows of Object.values(reordered))rows.reverse()
 assert.deepEqual(payrollWorkflowSources(f.run,reordered),sql)
 reordered.budgets.push({id:id(91),org_id:org,project_id:id(92)});reordered.billable_costs.push({id:id(92),org_id:org,source_type:'project_expense',source_id:id(93)})
 assert.deepEqual(payrollWorkflowSources(f.run,reordered),sql,'unrelated project dependencies are not duplicated into every payroll run')
})
test('v2 preparation/review persists immutable replayable construction proof and stale withdrawal retains the original witness',async t=>{
 const f=await scenario(t,true);await prepare(f.db,f.evidence)
 let row=(await f.db.query('select * from books_payroll_imports')).rows[0]
 assert.equal(row.reconciliation.evidenceVersion,2);assert.deepEqual(parsePayrollDraftEvidence(Object.fromEntries(Object.keys(f.evidence).map(key=>[key,row[key]]))),f.evidence)
 await review(f.db,f.evidence)
 await assert.rejects(f.db.exec("update books_payroll_imports set reconciliation=jsonb_set(reconciliation,'{workflowEvidence,constructionImpact,projectCostDeltaCents}','1')"),/immutable/)
 await f.db.exec("update billable_costs set metadata=jsonb_set(metadata,'{billing_method}','\"time_and_materials_rate\"')")
 await assert.rejects(review(f.db,f.evidence),/revision changed/)
 await withdraw(f.db)
 row=(await f.db.query('select * from books_payroll_imports')).rows[0]
 assert.equal(row.status,'withdrawn');assert.deepEqual(row.reconciliation.workflowEvidence,f.workflow)
 assert.deepEqual(parsePayrollDraftEvidence(Object.fromEntries(Object.keys(f.evidence).map(key=>[key,row[key]]))),f.evidence,'offline replay uses original frozen records, not changed live billing')
})
test('independent SQL guard rejects fabricated construction components, budget attribution, missing sources and invented readiness',async t=>{
 const f=await scenario(t)
 for(const [mutate,pattern] of [
  [e=>e.reconciliation.workflowEvidence.sourceTables.gl_accounts[0].code='FAKE',/source records/],
  [e=>e.reconciliation.workflowEvidence.constructionImpact.allocations[0].components[0].costCents++,/signed components/],
  [e=>e.reconciliation.workflowEvidence.constructionImpact.allocations[0].costDeltaCents++,/costs differ/],
  [e=>e.reconciliation.workflowEvidence.constructionImpact.allocations[0].costDeltaCents=String(e.reconciliation.workflowEvidence.constructionImpact.allocations[0].costDeltaCents),/JSON integer/],
  [e=>e.reconciliation.workflowEvidence.constructionImpact.allocations[0].gmpClassification='inside_gmp',/budget or GMP/],
  [e=>e.reconciliation.workflowEvidence.constructionImpact.allocations[0].jobCostCorrections=[],/project corrections/],
  [e=>e.reconciliation.workflowEvidence.constructionImpact.postingImplemented=true,/advisory/],
  [e=>e.reconciliation.workflowEvidence.liabilityHistory.unpaidStatusProven=true,/advisory/],
  [e=>e.reconciliation.workflowEvidence.liabilityHistory.organizationWagesMovementCents=1,/liability history/],
  [e=>e.reconciliation.workflowEvidence.liabilityHistory.organizationWagesMovementCents='0',/JSON integer/],
  [e=>e.reconciliation.evidenceVersion=3,/Unsupported/],
 ]){
  const forged=structuredClone(f.evidence);mutate(forged);forged.reconciliation_digest=booksDigest(forged.reconciliation)
  await assert.rejects(prepare(f.db,forged),pattern)
 }
 await prepare(f.db,f.evidence)
 assert.equal(Number((await f.db.query('select count(*) count from books_payroll_imports')).rows[0].count),1,'rejected proofs leave no reserved worker period/draft')
})
test('rehashed invented ledger/construction/payment plans cannot pass offline replay; version downgrade cannot conceal witness fields',async t=>{
 const f=await scenario(t,true)
 for(const mutate of [e=>e.reconciliation.workflowEvidence.constructionImpact.allocations[0].components[0].costCents++,e=>e.reconciliation.workflowEvidence.liabilityHistory.unpaidStatusProven=true,
  e=>e.reconciliation.workflowEvidence.sourceTables.job_cost_entries[0].cost_cents++,e=>delete e.reconciliation.evidenceVersion]){
  const forged=structuredClone(f.evidence);mutate(forged);forged.reconciliation_digest=booksDigest(forged.reconciliation)
  assert.throws(()=>parsePayrollDraftEvidence(forged),/workflow|source|cost/i)
 }
 assert.doesNotThrow(()=>parsePayrollDraftEvidence(fixture().evidence),'old ledger-only witnesses remain readable')
 assert.throws(()=>payrollDraftEvidence(fixture().result,'b'.repeat(64),{requireWorkflow:true}),/complete construction/)
})
test('relevant budget/billing changes stale the widened SQL revision; unrelated project billing remains excluded',async t=>{
 const f=await scenario(t,true),base=await revision(f.db,f.run)
 await f.db.query('insert into budgets values($1,$2,$3)',[id(91),org,id(92)])
 assert.equal(await revision(f.db,f.run),base)
 await f.db.query('update budget_lines set cost_code_id=$1 where id=$2',[id(93),id(84)])
 assert.notEqual(await revision(f.db,f.run),base)
 await f.db.query('update budget_lines set cost_code_id=$1 where id=$2',[id(5),id(84)])
 assert.equal(await revision(f.db,f.run),base)
 await f.db.exec('update billable_costs set markup_cents=4001,billable_cents=40001')
 assert.notEqual(await revision(f.db,f.run),base)
})
test('workflow selector/helper functions and register witnesses remain private to service workflows',async t=>{
 const f=await scenario(t)
 const flags=(await f.db.query("select has_function_privilege('authenticated','books_payroll_workflow_sources(jsonb,jsonb)','execute') browser,has_function_privilege('anon','books_payroll_liability_source_revision(jsonb,jsonb)','execute') anon,has_function_privilege('service_role','books_payroll_workflow_sources(jsonb,jsonb)','execute') service")).rows[0]
 assert.deepEqual(flags,{browser:false,anon:false,service:true})
 const wrong=structuredClone(f.snapshot);wrong.tables.gl_accounts[0].org_id=id(99)
 assert.throws(()=>payrollWorkflowSources(f.run,wrong.tables),/Foreign/)
 await assert.rejects(f.db.query('select books_payroll_workflow_sources($1::jsonb,$2::jsonb)',[JSON.stringify(wrong),JSON.stringify(f.run)]),/Foreign/)
})
test('prior wage payment, cash leg and withholding evidence are frozen, replayed and independently enforced by SQL',async t=>{
 const f=await scenario(t,true)
 await f.db.query("insert into gl_accounts values($1,$2,'1000','asset','cash',true)",[id(60),org])
 await f.db.query("insert into journal_entries(id,org_id,fact_id,status,source_type,source_id,entry_date) values($1,$2,null,'posted','payroll_settlement',null,'2026-09-18')",[id(61),org])
 for(const [i,account,debit,credit] of [[0,id(30),24000,0],[1,id(60),0,18000],[2,id(31),0,6000]])await f.db.query('insert into journal_lines values($1,$2,$3,$4,null,$5,$6,$7::jsonb)',[id(62+i),org,id(61),account,debit,credit,JSON.stringify({payment_reference:'Original prior provider payment',evidence_url:'https://example.com/original-payment'})])
 const fresh=payrollReconciliationFromSnapshot(org,f.run,await capture(f.db))
 const evidence=payrollDraftEvidence({...f.result,...fresh,sourceMappingDigest:f.evidence.mapping_digest},await revision(f.db,f.run),{requireWorkflow:true})
 const witness=evidence.reconciliation.workflowEvidence
 assert.equal(witness.liabilityHistory.organizationWagesMovementCents,-24000)
 assert.equal(witness.liabilityHistory.organizationDeductionsMovementCents,6000)
 assert.equal(witness.sourceTables.journal_lines.length,3);assert.ok(witness.sourceTables.gl_accounts.some(row=>row.id===id(60)))
 assert.deepEqual((await f.db.query('select books_payroll_workflow_sources($1::jsonb,$2::jsonb) sources',[JSON.stringify(await capture(f.db)),JSON.stringify(f.run)])).rows[0].sources,witness.sourceTables)
 const bad=structuredClone(evidence);bad.reconciliation.workflowEvidence.liabilityHistory.organizationDeductionsMovementCents=0
 bad.reconciliation_digest=booksDigest(bad.reconciliation)
 await assert.rejects(prepare(f.db,bad),/liability history/)
 await prepare(f.db,evidence);await review(f.db,evidence)
 const stored=(await f.db.query('select * from books_payroll_imports')).rows[0]
 assert.equal(stored.reconciliation.workflowEvidence.liabilityHistory.requiresSettlementAttribution,true,'review retains attribution requirement and does not silently assign legacy cash to this run')
 assert.deepEqual(parsePayrollDraftEvidence(Object.fromEntries(Object.keys(evidence).map(key=>[key,stored[key]]))),evidence)
 await f.db.exec("update journal_lines set dimensions=jsonb_set(dimensions,'{payment_reference}','\"Changed later reference\"') where entry_id='99400000-0000-4000-8000-000000000061'")
 await assert.rejects(review(f.db,evidence),/revision changed/)
})
test('schema 9 recovery verifies original v2 workflow witnesses and restores all scoped rows with protection re-enabled',async t=>{
 const f=await scenario(t,true);await prepare(f.db,f.evidence);await review(f.db,f.evidence);await withdraw(f.db)
 const {verifyBooksExportBundle,BOOKS_EXPORT_SCHEMA_VERSION,EXPORT_TABLES}=require('../lib/services/books/export-contract'),{historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive')
 const replacement=Buffer.from('Later replacement is not the original payroll register'),replacementPath=org+'/payroll/current.csv',replacementHash=createHash('sha256').update(replacement).digest('hex')
 await f.db.query('insert into doc_versions(id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum) values($1,$2,$3,$4,$5,$6,$7,$8)',[id(91),org,id(8),replacementPath,'Current.csv','text/csv',replacement.length,replacementHash])
 await f.db.query('update files set current_version_id=$1,storage_path=$2,file_name=$3,size_bytes=$4,checksum=$5 where id=$6',[id(91),replacementPath,'Current.csv',replacement.length,replacementHash,id(8)])
 const tables=(await capture(f.db)).tables
 const originalObjectId=booksDigest({storagePath:f.sourceProof.storage_path,sizeBytes:f.sourceProof.size_bytes,checksum:f.sourceProof.checksum})
 const bundle={tables,manifest:{schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:[{id:id(8),storagePath:replacementPath,sizeBytes:replacement.length,checksum:replacementHash}],supportingHistoricalFiles:historicalDocumentInventory(tables,org)},supportingObjects:[{fileId:id(8),dataBase64:replacement.toString('base64')}],supportingHistoricalObjects:[{attachmentId:originalObjectId,dataBase64:f.registerBytes.toString('base64')}]}
 assert.equal(verifyBooksExportBundle(bundle).valid,true,JSON.stringify(verifyBooksExportBundle(bundle)))
 const missingOriginal=structuredClone(bundle);missingOriginal.supportingHistoricalObjects=[]
 assert.equal(verifyBooksExportBundle(missingOriginal).valid,false,'a current replacement cannot supply original payroll amounts')
 const forged=structuredClone(bundle),evidence=forged.tables.books_payroll_imports[0]
 evidence.reconciliation.workflowEvidence.constructionImpact.allocations[0].components[0].costCents++
 evidence.reconciliation_digest=booksDigest(evidence.reconciliation)
 forged.manifest.tables.books_payroll_imports.checksum=booksDigest(forged.tables.books_payroll_imports)
 assert.equal(verifyBooksExportBundle(forged).valid,false,'fresh archive/draft hashes cannot launder a fabricated job-cost correction')
 const fs=require('node:fs'),path=require('node:path'),{tmpdir}=require('node:os'),{gzipSync}=require('node:zlib')
 const directory=fs.mkdtempSync(path.join(tmpdir(),'payroll-workflow-recovery-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
 const archive=path.join(directory,'export.json.gz');fs.writeFileSync(archive,gzipSync(JSON.stringify(bundle)))
 const root=path.join(directory,'objects'),{extractSupportingFiles}=require('../scripts/verify-books-export.cjs')
 assert.equal((await extractSupportingFiles(archive,root)).verifiedFiles,2)
 assert.deepEqual(fs.readFileSync(path.join(root,f.sourceProof.storage_path)),f.registerBytes)
 assert.deepEqual(fs.readFileSync(path.join(root,replacementPath)),replacement)
 const target=(await scenario(t)).db
 await target.exec('set session_replication_role=replica')
 for(const name of EXPORT_TABLES)await target.exec(`delete from ${name}`)
 for(const [name,rows] of Object.entries(tables))for(const row of rows){const keys=Object.keys(row);await target.query(`insert into ${name}(${keys.map(key=>'"'+key+'"').join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row).map(value=>value&&typeof value==='object'?JSON.stringify(value):value))}
 await target.exec('set session_replication_role=origin')
 assert.deepEqual((await capture(target)).tables,tables)
 await assert.rejects(target.exec("update books_payroll_imports set reconciliation=jsonb_set(reconciliation,'{evidenceVersion}','1')"),/immutable/)
 await assert.rejects(target.exec('delete from books_payroll_imports'),/history cannot/)
 assert.deepEqual(parsePayrollDraftEvidence(Object.fromEntries(Object.keys(f.evidence).map(key=>[key,tables.books_payroll_imports[0][key]]))),f.evidence)
})
test('source recovery catches internally consistent but invented provider money or dates even with fresh accounting/workflow hashes',async t=>{
 const f=await scenario(t),{verifyPayrollArchiveSource}=require('../lib/services/books/payroll-archive-source')
 assert.equal(verifyPayrollArchiveSource(f.evidence,f.registerBytes.toString('base64')),true)
 for(const mutate of [run=>{run.employees[0].gross_cents+=1000;run.employees[0].net_cents+=1000;run.employees[0].allocations[0].gross_cents+=1000;run.controls.gross_cents+=1000;run.controls.net_cents+=1000;run.controls.funding_cents+=1000},run=>run.accrual_date='2026-09-14']){
  const run=structuredClone(f.run);mutate(run)
  const plan=reconcilePayrollImport(run,[],f.postingAccounts),workflowEvidence=payrollWorkflowEvidence(plan,[],f.snapshot.tables)
  const changed=payrollDraftEvidence({...f.result,...plan,laborEvidence:[],workflowEvidence,sourceMappingDigest:booksDigest({source:f.sourceProof,columns:f.columnMapping,workers:plan.run.employees.map(worker=>({worker_id:worker.worker_id,employee_reference:worker.employee_reference,allocations:worker.allocations}))})},f.evidence.source_revision,{requireWorkflow:true})
  assert.doesNotThrow(()=>parsePayrollDraftEvidence(changed),'internally coherent plans alone cannot prove provider source amounts/dates')
  assert.throws(()=>verifyPayrollArchiveSource(changed,f.registerBytes.toString('base64')),/allocation|register/i)
 }
 for(const encoded of ['!!!!',f.registerBytes.subarray(1).toString('base64'),f.registerBytes.toString('base64')+'===='])assert.throws(()=>verifyPayrollArchiveSource(f.evidence,encoded),/bytes|size/)
})
test('v3 migration updates compiled review callers and leaves original ledger-only evidence intact and withdrawable',async t=>{
 const {db,evidence}=await database(t,{workflow:false})
 await prepare(db,evidence);await review(db,evidence)
 const oid=(await db.query("select 'public.books_payroll_source_revision(jsonb,jsonb)'::regprocedure::oid oid")).rows[0].oid
 const fs=require('node:fs'),path=require('node:path')
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261003220020_books_payroll_workflow_evidence.sql'),'utf8'))
 assert.equal((await db.query("select 'public.books_payroll_source_revision(jsonb,jsonb)'::regprocedure::oid oid")).rows[0].oid,oid)
 assert.notEqual(await revision(db,evidence.run),evidence.source_revision)
 await assert.rejects(review(db,evidence),/revision changed/)
 assert.deepEqual((await db.query('select reconciliation from books_payroll_imports')).rows[0].reconciliation,evidence.reconciliation)
 await withdraw(db)
 assert.equal((await db.query('select status from books_payroll_imports')).rows[0].status,'withdrawn')
})
