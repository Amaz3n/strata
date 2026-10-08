require('../scripts/register-ts-node-test');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { BOOKS_EXPORT_SCHEMA_VERSION, EXPORT_TABLES, verifyBooksExportBundle } = require('../lib/services/books/export-contract');
const { booksDigest } = require('../lib/services/books/hash');
const { verifyFileCopy } = require('../scripts/verify-books-export.cjs');
function fixture() {
 const tables=Object.fromEntries(EXPORT_TABLES.map(name=>[name,[]]));
 tables.gl_accounts=[{id:'cash',org_id:'org'},{id:'clearing',org_id:'org'}];
 tables.journal_entries=[{id:'entry',org_id:'org',status:'posted'}];
 tables.journal_lines=[{id:'debit',org_id:'org',entry_id:'entry',account_id:'cash',debit_cents:10000,credit_cents:0},{id:'credit',org_id:'org',entry_id:'entry',account_id:'clearing',debit_cents:0,credit_cents:10000}];
 tables.bank_accounts=[{id:'bank',org_id:'org'}];
 tables.bank_transactions=[{id:'transaction',org_id:'org',bank_account_id:'bank'}];
 tables.payments=[{id:'receipt',org_id:'org'}];
 tables.books_deposit_batches=[{id:'batch',org_id:'org',journal_entry_id:'entry',bank_transaction_id:'transaction'}];
 tables.books_deposit_batch_items=[{id:'member',org_id:'org',batch_id:'batch',payment_id:'receipt'}];
 return { tables, manifest:{schemaVersion:2,orgId:'org',tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:[]} };
}
test('export roundtrip retains operational relationships and verifies copied file bytes',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'arc-books-export-'));
 try {
  const bundle=fixture(); const file=Buffer.from('Bank statement fixture\n');
  bundle.manifest.supportingFiles=[{id:'file',storagePath:'org/statement.pdf',checksum:createHash('sha256').update(file).digest('hex'),sizeBytes:file.length}];
  mkdirSync(path.join(root,'org'));writeFileSync(path.join(root,'org/statement.pdf'),file);
  const archive=path.join(root,'books.json.gz');writeFileSync(archive,gzipSync(JSON.stringify(bundle)));
  assert.equal((await verifyFileCopy(archive,root)).verifiedFiles,1);
  writeFileSync(path.join(root,'org/statement.pdf'),'changed');
  await assert.rejects(verifyFileCopy(archive,root),/changed/);
 } finally { rmSync(root,{recursive:true,force:true}); }
});
test('balanced journals cannot hide a missing deposit membership relationship',()=>{
 const bundle=fixture(); bundle.tables.payments=[];bundle.manifest.tables.payments={rows:0,checksum:booksDigest([])};
 const result=verifyBooksExportBundle(bundle);assert.equal(result.valid,false);assert.ok(result.integrityErrors.some(error=>error.includes('payment_id')));
});
test('table bytes and organization scope are independently verified',()=>{
 const bundle=fixture();bundle.tables.payments[0].org_id='another-org';
 assert.equal(verifyBooksExportBundle(bundle).valid,false);
 bundle.manifest.tables.payments.checksum=booksDigest(bundle.tables.payments);
 assert.ok(verifyBooksExportBundle(bundle).integrityErrors.some(error=>error.includes('Organization mismatch')));
});
function embeddedFixture(storagePath='org/statement.pdf') {
 const bundle=fixture(); const bytes=Buffer.from([0,255,1,2,10,13,200]);
 const checksum=createHash('sha256').update(bytes).digest('hex');
 bundle.tables.files=[{id:'file',org_id:'org',storage_path:storagePath,checksum,size_bytes:bytes.length}];
 bundle.manifest.tables.files={rows:1,checksum:booksDigest(bundle.tables.files)};
 bundle.manifest.schemaVersion=4;
 bundle.manifest.supportingFiles=[{id:'file',storagePath,checksum,sizeBytes:bytes.length}];
 bundle.supportingObjects=[{fileId:'file',dataBase64:bytes.toString('base64')}];
 return {bundle,bytes};
}
test('self-contained export restores exact binary document bytes without live storage',async()=>{
 const {extractSupportingFiles}=require('../scripts/verify-books-export.cjs');
 const {readFileSync}=require('node:fs');
 const root=mkdtempSync(path.join(os.tmpdir(),'arc-books-embedded-'));
 try {
  const {bundle,bytes}=embeddedFixture();const archive=path.join(root,'books.json.gz');
  writeFileSync(archive,gzipSync(JSON.stringify(bundle)));
  assert.equal((await verifyFileCopy(archive)).supportingFilesEmbedded,true);
  const destination=path.join(root,'restored');
  assert.equal((await extractSupportingFiles(archive,destination)).verifiedFiles,1);
  assert.deepEqual(readFileSync(path.join(destination,'org/statement.pdf')),bytes);
  await assert.rejects(extractSupportingFiles(archive,destination),/EEXIST/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('embedded file verification rejects missing, altered, duplicate and mismatched evidence',()=>{
 for (const change of [
  b=>{b.supportingObjects=[]},
  b=>{b.supportingObjects[0].dataBase64=Buffer.from('altered').toString('base64')},
  b=>{b.supportingObjects.push(b.supportingObjects[0])},
  b=>{b.manifest.supportingFiles[0].storagePath='different'},
  b=>{b.supportingObjects[0].dataBase64+='\n'},
  b=>{b.supportingObjects[0].fileId='wrong-file'},
 ]) {const {bundle}=embeddedFixture();change(bundle);assert.equal(verifyBooksExportBundle(bundle).valid,false);}
});
test('supporting file extraction rejects path traversal before creating output',async()=>{
 const {extractSupportingFiles}=require('../scripts/verify-books-export.cjs');const {existsSync}=require('node:fs');
 const root=mkdtempSync(path.join(os.tmpdir(),'arc-books-path-'));
 try {
  for (const name of ['../escape.pdf','/absolute.pdf','org/../escape.pdf','org\\escape.pdf']) {
   const {bundle}=embeddedFixture(name);const archive=path.join(root,'books.json');writeFileSync(archive,JSON.stringify(bundle));
   const destination=path.join(root,'restored');await assert.rejects(extractSupportingFiles(archive,destination),/Unsafe/);assert.equal(existsSync(destination),false);
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('export service uploads embedded documents and refuses a changed source file',async()=>{
 const Module=require('node:module');const {database}=require('./helpers/report-database');const {gunzipSync}=require('node:zlib');
 const {bundle,bytes}=embeddedFixture();const source=database(bundle.tables);let upload,changed=false,snapshotMode="valid";const updates=[];
 const service={rpc:async(name,args)=>{if(name==='start_books_export_attempt')return {data:1,error:null};if(name==='fail_books_export_attempt'){updates.push({status:'failed'});return {data:null,error:null}};assert.equal(name,"capture_books_export_snapshot");assert.equal(args.p_org_id,"org");if(snapshotMode==="error")return {data:null,error:{message:"snapshot unavailable"}};const tables={...bundle.tables};if(snapshotMode==="missing")delete tables.journal_lines;return {data:{orgId:snapshotMode==="wrong-org"?"other":"org",capturedAt:"2026-10-03T00:00:00Z",databaseSnapshot:"1:2:",tables},error:null}},from(table){
  if(table!=='books_exports')return source.from(table);
  const query={insert(row){assert.equal(row.schema_version,BOOKS_EXPORT_SCHEMA_VERSION);return query},select(){return query},single:async()=>({data:{id:'00000000-0000-4000-8000-000000000001',export_type:'complete'},error:null}),update(row){updates.push(row);return query},eq(){return query},then(resolve){return Promise.resolve({error:null}).then(resolve)}};return query;
 }};
 const original=Module._load;let createExport;
 try {
  Module._load=function(name,...args){
   if(name==='server-only')return {};
   if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>service};
   if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:'org',userId:'user',supabase:service})};
   if(name==='@/lib/services/books/access')return {requireBooksAuthorization:async()=>{}};
   if(name==='@/lib/services/events')return {recordEvent:async()=>{}};
   if(name==='@/lib/storage/files-storage')return {getFilesObjectStream:async()=>({body:new ReadableStream({start(controller){controller.enqueue(changed?Buffer.from('changed'):bytes);controller.close()}})}),uploadFilesObject:async input=>{upload=input;return {storagePath:input.path}}};
   return original.call(this,name,...args);
  };
  const {createBooksExportNow}=require('../lib/services/books/exports');createExport=input=>createBooksExportNow({exportType:'complete',...input});
 }finally{Module._load=original;}
 const result=await createExport({});assert.equal(result.verification.valid,true);
 const archive=JSON.parse(gunzipSync(upload.bytes));assert.equal(archive.manifest.schemaVersion,BOOKS_EXPORT_SCHEMA_VERSION);
 assert.deepEqual(Buffer.from(archive.supportingObjects[0].dataBase64,'base64'),bytes);
 assert.equal(verifyBooksExportBundle(archive).valid,true);
 assert.equal(archive.manifest.databaseSnapshot.visibility,'1:2:');
 for(const mode of ['error','missing','wrong-org']) {
  snapshotMode=mode;upload=null;await assert.rejects(createExport({}),/snapshot/);assert.equal(upload,null);assert.equal(updates.at(-1).status,'failed');
 }
 snapshotMode='valid';
 changed=true;upload=null;await assert.rejects(createExport({}),/checksum mismatch/);
 assert.equal(upload,null);assert.equal(updates.at(-1).status,'failed');
});
test('journal verification catches one-cent imbalances beyond JavaScript sum precision',()=>{
 const bundle=fixture();bundle.manifest=undefined;
 const line=(id,debit,credit)=>({id,entry_id:'entry',debit_cents:debit,credit_cents:credit});
 bundle.tables.journal_lines=[line('d1',Number.MAX_SAFE_INTEGER,0),line('d2',2,0),line('c1',0,Number.MAX_SAFE_INTEGER),line('c2',0,1)];
 assert.deepEqual(verifyBooksExportBundle(bundle).unbalancedEntryIds,['entry']);
 bundle.tables.journal_lines[3].credit_cents=2;assert.equal(verifyBooksExportBundle(bundle).valid,true);
 bundle.tables.journal_lines=[line('d','9007199254740993','0'),line('c','0','9007199254740993')];assert.equal(verifyBooksExportBundle(bundle).valid,true);
});
test('journal verification rejects malformed cents and violations of database line rules',()=>{
 for(const [debit,credit] of [[1,1],[0,0],[-1,0],[1.5,0],[Number.MAX_SAFE_INTEGER+1,0],['1e3',0],['01',0],[null,0],['9223372036854775808',0]]) {
  const bundle=fixture();bundle.manifest=undefined;bundle.tables.journal_lines[0].debit_cents=debit;bundle.tables.journal_lines[0].credit_cents=credit;
  const verification=verifyBooksExportBundle(bundle);assert.equal(verification.valid,false);assert.ok(verification.integrityErrors.some(error=>error.includes('Invalid journal line amounts')));
 }
});
test('offline recovery verification requires the manifest rather than accepting balanced fragments',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'arc-books-no-manifest-'));
 try{const bundle=fixture();delete bundle.manifest;const archive=path.join(root,'fragment.json');writeFileSync(archive,JSON.stringify(bundle));await assert.rejects(verifyFileCopy(archive),/versioned manifest/)}finally{rmSync(root,{recursive:true,force:true})}
});
test('checksum-correct export rows still require identities for restoration',()=>{
 const bundle=fixture();bundle.tables.companies=[{org_id:'org',name:'Missing ID'}];bundle.manifest.tables.companies={rows:1,checksum:booksDigest(bundle.tables.companies)};
 const result=verifyBooksExportBundle(bundle);assert.equal(result.valid,false);assert.ok(result.integrityErrors.includes('Missing row identity in companies'));
});
test('schema 5 requires projection receipts while older archives remain readable',()=>{
 const {bundle}=embeddedFixture();delete bundle.tables.books_projection_receipts;delete bundle.manifest.tables.books_projection_receipts;
 assert.equal(verifyBooksExportBundle(bundle).valid,true);
 bundle.manifest.schemaVersion=5;assert.equal(verifyBooksExportBundle(bundle).valid,false);
});

test('schema 6 requires Arc Pay fee history while schema 5 archives remain verifiable',()=>{
 const bundle=fixture();bundle.manifest.schemaVersion=6;
 assert.equal(verifyBooksExportBundle(bundle).valid,true);
 delete bundle.tables.payment_run_fee_charges;delete bundle.manifest.tables.payment_run_fee_charges;
 assert.equal(verifyBooksExportBundle(bundle).valid,false);
 bundle.manifest.schemaVersion=5;assert.equal(verifyBooksExportBundle(bundle).valid,true);
});
test('schema 6 validates fee ownership and keeps embedded recovery documents readable',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'arc-books-fee-archive-'));
 try {
  const {bundle}=embeddedFixture();bundle.manifest.schemaVersion=6;
  bundle.tables.payment_runs=[{id:'run',org_id:'org'}];bundle.tables.org_funding_sources=[{id:'funding',org_id:'org'}];
  bundle.tables.payment_run_fee_charges=[{id:'fee',org_id:'org',run_id:'run',funding_source_id:'funding',amount_cents:200}];
  for(const name of ['payment_runs','org_funding_sources','payment_run_fee_charges'])bundle.manifest.tables[name]={rows:bundle.tables[name].length,checksum:booksDigest(bundle.tables[name])};
  const archive=path.join(root,'schema6.json.gz');writeFileSync(archive,gzipSync(JSON.stringify(bundle)));
  assert.equal((await verifyFileCopy(archive)).supportingFilesEmbedded,true);
  const {extractSupportingFiles}=require('../scripts/verify-books-export.cjs');assert.equal((await extractSupportingFiles(archive,path.join(root,'documents'))).verifiedFiles,1);
  bundle.tables.payment_runs=[];bundle.manifest.tables.payment_runs={rows:0,checksum:booksDigest([])};
  assert.equal(verifyBooksExportBundle(bundle).valid,false);
 } finally {rmSync(root,{recursive:true,force:true})}
});
test('unknown archive schema versions cannot bypass table checksums and relationship validation',()=>{
 const bundle=fixture();bundle.manifest.schemaVersion=99;bundle.tables.payment_run_fee_charges=[{id:'unchecked',org_id:'foreign'}]
 assert.equal(verifyBooksExportBundle(bundle).valid,false)
 assert.ok(verifyBooksExportBundle(bundle).integrityErrors.includes('Unsupported Books export schema version'))
})

test('schema 7 includes reviewed tax workpapers, retains version 6 compatibility and verifies their source basis and nested references',()=>{
 const bundle=fixture();bundle.manifest.schemaVersion=7
 const snapshot={version:1,basis:'cash',start_date:'2026-01-01',end_date:'2026-12-31',net_income_cents:0,source_revision:'a'.repeat(64),evidence:{}}
 bundle.tables.books_tax_adjustment_workpapers=[{id:'workpaper',org_id:'org',status:'approved',prepared_by:'preparer',reviewed_by:'reviewer',base_snapshot:snapshot,base_digest:booksDigest(snapshot),lines:[{id:'99300000-0000-4000-8000-000000000005',kind:'permanent',amount_cents:100,description:'Reviewed permanent difference',evidence_reference:'Source tax workpaper',evidence_file_id:null,project_id:null}]}]
 const refresh=()=>{bundle.manifest.tables=Object.fromEntries(Object.entries(bundle.tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}]))}
 refresh();assert.equal(verifyBooksExportBundle(bundle).valid,true)
 bundle.tables.books_tax_adjustment_workpapers[0].lines[0].evidence_file_id='99300000-0000-4000-8000-000000000099';refresh();assert.ok(verifyBooksExportBundle(bundle).integrityErrors.some(error=>error.includes('Missing files')))
 bundle.tables.books_tax_adjustment_workpapers[0].lines[0].evidence_file_id=null;bundle.tables.books_tax_adjustment_workpapers[0].base_snapshot.net_income_cents=1;refresh();assert.ok(verifyBooksExportBundle(bundle).integrityErrors.some(error=>error.includes('basis digest')))
 const workpaper=bundle.tables.books_tax_adjustment_workpapers[0];workpaper.base_snapshot.net_income_cents=0;workpaper.base_digest=booksDigest(workpaper.base_snapshot);workpaper.lines=[]
 refresh();assert.equal(verifyBooksExportBundle(bundle).valid,false)
 workpaper.preparation_notes='Reviewed all tax differences using TAX-2026 calculation; none remain';refresh();assert.equal(verifyBooksExportBundle(bundle).valid,true)
 workpaper.status='withdrawn';workpaper.reviewed_by=null;workpaper.close_reason='Duplicate draft entered in error';refresh();assert.equal(verifyBooksExportBundle(bundle).valid,true)
 delete bundle.tables.books_tax_adjustment_workpapers;delete bundle.manifest.tables.books_tax_adjustment_workpapers
 assert.equal(verifyBooksExportBundle(bundle).valid,false)
 bundle.manifest.schemaVersion=6;assert.equal(verifyBooksExportBundle(bundle).valid,true)
})
test('schema 7 embedded supporting document extraction preserves original bytes',async()=>{
 const {bundle,bytes}=embeddedFixture();bundle.manifest.schemaVersion=7
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{gzipSync}=require('node:zlib')
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'arc-books-schema-seven-'))
 try{
  const archive=path.join(root,'archive.gz'),destination=path.join(root,'files');fs.writeFileSync(archive,gzipSync(JSON.stringify(bundle)))
  const result=await require('../scripts/verify-books-export.cjs').extractSupportingFiles(archive,destination)
  assert.equal(result.verifiedFiles,1);assert.deepEqual(fs.readFileSync(path.join(destination,bundle.manifest.supportingFiles[0].storagePath)),bytes)
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
