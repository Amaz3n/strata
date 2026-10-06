require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {sourceFixture,prepareSource,reviewSource}=require('./helpers/books-payroll-correction-source-fixture'),{capture}=require('./helpers/books-payroll-workflow-fixture'),{id,org}=require('./helpers/books-payroll-register-fixture')
const {parsePayrollCorrectionSource,verifyPayrollCorrectionSourceBytes}=require('../lib/services/books/payroll-correction-source')
test('actual corrected source preparation/review stores immutable documentary version and changes no accounting money',async t=>{
 const f=await sourceFixture(t),before=(await capture(f.db)).tables
 assert.equal((await prepareSource(f)).rows[0].id,id(700));assert.equal((await prepareSource(f)).rows[0].id,id(700))
 let tables=(await capture(f.db)).tables,row=parsePayrollCorrectionSource(tables.books_payroll_correction_sources[0],tables)
 assert.equal(row.revision,1);assert.equal(row.status,'draft');assert.equal(verifyPayrollCorrectionSourceBytes(row,tables,f.bytes.toString('base64')).id,id(700))
 await assert.rejects(reviewSource(f,id(50)),/separate from all preparers/);await assert.rejects(reviewSource(f,id(2)),/separate from all preparers/)
 await reviewSource(f);tables=(await capture(f.db)).tables;row=parsePayrollCorrectionSource(tables.books_payroll_correction_sources[0],tables);assert.equal(row.status,'reviewed');assert.equal(row.reviewed_by,id(51))
 for(const name of ['accounting_facts','journal_entries','journal_lines','job_cost_entries','books_payroll_postings','books_payroll_labor_ownership','time_entries','billable_costs'])assert.deepEqual(tables[name],before[name])
 await assert.rejects(f.db.query("update books_payroll_correction_sources set request=jsonb_set(request,'{reason}','\"Changed after source review\"')"),/immutable/)
 await assert.rejects(f.db.exec('delete from books_payroll_correction_sources'),/cannot be deleted/)
 const grants=(await f.db.query("select has_table_privilege('authenticated','books_payroll_correction_sources','select') browser_read,has_function_privilege('authenticated','prepare_books_payroll_correction_source(uuid,uuid,jsonb,text,text)','execute') browser_prepare")).rows[0];assert.deepEqual(grants,{browser_read:false,browser_prepare:false})
})
test('SQL independently rejects fabricated controls, allocations, original register/scope/source/actor and retry intent',async t=>{
 const f=await sourceFixture(t)
 for(const mutate of [e=>e.run.unapproved_cash=100,e=>e.account_snapshot=[],e=>e.run.controls.gross_cents++,e=>e.run.employees[0].allocations[0].gross_cents++,e=>e.run.provider_run_id='OTHER',e=>e.run.org_id=id(99),e=>e.run.employees[0].worker_id=id(52),e=>e.run.employees[0].allocations[0].project_id=id(999),e=>e.run.employees[0].allocations[0].labor_evidence_ids.push(id(80)),e=>e.source_proof.checksum='a'.repeat(64),e=>e.source_proof.document_version_id=id(999),e=>e.account_snapshot[0].code='OTHER',e=>e.request.accountingDate='2026-09-01']){
  const bad=structuredClone(f.evidence);mutate(bad);await assert.rejects(prepareSource(f,bad));assert.equal((await f.db.query('select count(*)::int n from books_payroll_correction_sources')).rows[0].n,0)
 }
 await assert.rejects(prepareSource(f,f.evidence,'corrected-register-retry-key',id(52)),/active preparer/)
 await prepareSource(f);const bad=structuredClone(f.evidence);bad.request.reason='Different original correction request';await assert.rejects(prepareSource(f,bad),/different intent/)
 await assert.rejects(reviewSource(f,id(51),bad),/changed or is not awaiting/)
})
test('withdrawn sources retain review and original document bytes; documentary revisions and retry remain stable',async t=>{
 const f=await sourceFixture(t);await prepareSource(f);await reviewSource(f)
 await f.db.query('select withdraw_books_payroll_correction_source($1,$2,$3,$4)',[org,id(700),id(50),'Superseded corrected register source evidence'])
 const tables=(await capture(f.db)).tables,row=parsePayrollCorrectionSource(tables.books_payroll_correction_sources[0],tables);assert.equal(row.status,'withdrawn');assert.equal(row.reviewed_by,id(51));assert.equal((await prepareSource(f)).rows[0].id,row.id)
 const next=structuredClone(f.evidence);next.request.id=id(710);next.run.id=id(710);await prepareSource(f,next,'corrected-register-next-retry-key')
 assert.equal((await f.db.query('select revision from books_payroll_correction_sources where id=$1',[id(710)])).rows[0].revision,2)
 await assert.rejects(f.db.query('delete from doc_versions where id=$1',[id(701)]),/immutable/)
 await assert.rejects(f.db.query('update doc_versions set checksum=$1 where id=$2',['a'.repeat(64),id(701)]),/immutable/)
 await f.db.query('update doc_versions set notes=$1 where id=$2',['Editorial original version note',id(701)])
 await assert.rejects(f.db.query('delete from files where id=$1',[id(702)]),/history cannot be deleted/)
})
test('schema 15 recovers reviewed/withdrawn correction sources and original bytes after file replacement and rejects checksummed invented money',async t=>{
 const {booksDigest}=require('../lib/services/books/hash'),{verifyBooksExportBundle,BOOKS_EXPORT_SCHEMA_VERSION,EXPORT_TABLES}=require('../lib/services/books/export-contract'),{historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive'),{createHash}=require('node:crypto')
 const f=await sourceFixture(t);await prepareSource(f);await reviewSource(f)
 const replacement=Buffer.from('Later file version, original provider register retained'),checksum=createHash('sha256').update(replacement).digest('hex'),newPath=org+'/payroll/later-file-version.csv'
 await f.db.query('insert into doc_versions(id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum) values($1,$2,$3,$4,$5,$6,$7,$8)',[id(703),org,id(702),newPath,'Later.csv','text/csv',replacement.length,checksum])
 await f.db.query('update files set current_version_id=$1,storage_path=$2,file_name=$3,size_bytes=$4,checksum=$5 where id=$6',[id(703),newPath,'Later.csv',replacement.length,checksum,id(702)])
 const tables=(await capture(f.db)).tables,history=historicalDocumentInventory(tables,org),original=history.find(row=>row.storagePath===f.proof.storage_path)
 assert.equal(original.currentFileId,null)
 const bundle={tables,manifest:{schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:tables.files.map(file=>({id:file.id,storagePath:file.storage_path,sizeBytes:file.size_bytes,checksum:file.checksum})),supportingHistoricalFiles:history},supportingObjects:[{fileId:id(8),dataBase64:f.registerBytes.toString('base64')},{fileId:id(702),dataBase64:replacement.toString('base64')}],supportingHistoricalObjects:[{attachmentId:original.id,dataBase64:f.bytes.toString('base64')}]}
 assert.equal(BOOKS_EXPORT_SCHEMA_VERSION,32);assert.equal(verifyBooksExportBundle(bundle).valid,true,JSON.stringify(verifyBooksExportBundle(bundle)))
 const target=await sourceFixture(t)
 await target.db.exec('set session_replication_role=replica')
 for(const name of EXPORT_TABLES)await target.db.exec(`delete from ${name}`)
 for(const [name,rows]of Object.entries(tables))for(const row of rows){const keys=Object.keys(row);await target.db.query(`insert into ${name}(${keys.map(key=>'"'+key+'"').join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row).map(value=>value&&typeof value==='object'?JSON.stringify(value):value))}
 await target.db.exec('set session_replication_role=origin')
 const restored=(await capture(target.db)).tables;assert.deepEqual(restored,tables)
 assert.equal(verifyPayrollCorrectionSourceBytes(restored.books_payroll_correction_sources[0],restored,f.bytes.toString('base64')).status,'reviewed')
 assert.equal((await prepareSource(target)).rows[0].id,id(700),'original preparation retry recovers reviewed history without writes')
 await assert.rejects(target.db.query('update books_payroll_correction_sources set revision=2 where id=$1',[id(700)]),/immutable/)
 await assert.rejects(target.db.query('delete from doc_versions where id=$1',[id(701)]),/immutable/)
 const corrupt=structuredClone(bundle),row=corrupt.tables.books_payroll_correction_sources[0]
 row.run.employees[0].gross_cents++;row.run.employees[0].net_cents++;row.run.employees[0].allocations[0].gross_cents++;row.run.controls.gross_cents++;row.run.controls.net_cents++;row.run.controls.funding_cents++
 row.source_mapping_digest=booksDigest({source:row.source_proof,columns:row.column_mapping,workers:row.run.employees.map(worker=>({worker_id:worker.worker_id,employee_reference:worker.employee_reference,allocations:worker.allocations}))})
 row.evidence_hash=(await f.db.query('select books_payroll_correction_source_hash($1::jsonb) hash',[JSON.stringify(row)])).rows[0].hash
 corrupt.manifest.tables.books_payroll_correction_sources.checksum=booksDigest(corrupt.tables.books_payroll_correction_sources)
 assert.equal(verifyBooksExportBundle(corrupt).valid,false,'recomputed controls/mapping/SQL hash/table checksum cannot substitute different wages for retained original CSV')
 const legacy=structuredClone(bundle);legacy.tables.books_payroll_correction_sources=[];legacy.manifest.schemaVersion=13;delete legacy.tables.books_payroll_correction_sources;delete legacy.manifest.tables.books_payroll_correction_sources
 legacy.manifest.supportingHistoricalFiles=historicalDocumentInventory(legacy.tables,org)
 assert.equal(verifyBooksExportBundle(legacy).valid,true,'legitimate prior archives can omit new source table')
})
