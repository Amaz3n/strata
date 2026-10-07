require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto'),{gzipSync}=require('node:zlib')
const {BOOKS_EXPORT_SCHEMA_VERSION,EXPORT_TABLES,verifyBooksExportBundle}=require('../lib/services/books/export-contract')
const {historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive')
const {booksDigest}=require('../lib/services/books/hash')
const {taxAttachmentFromFile}=require('../lib/services/books/tax-attachment-rules')
const {extractSupportingFiles,verifyFileCopy}=require('../scripts/verify-books-export.cjs')
const org='99500000-0000-4000-8000-000000000001',id=n=>'99500000-0000-4000-8000-'+String(n).padStart(12,'0')
const original=Buffer.from('Original reviewed tax calculation'),revised=Buffer.from('Revised document after accounting review')
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
function fixture(){
 const source={id:id(2),org_id:org,current_version_id:id(3),file_name:'Original.txt',storage_path:org+'/tax/original.txt',mime_type:'text/plain',size_bytes:original.length,checksum:digest(original)}
 const current={...source,current_version_id:id(4),file_name:'Revised.txt',storage_path:org+'/tax/revised.txt',size_bytes:revised.length,checksum:digest(revised)}
 const tables=Object.fromEntries(EXPORT_TABLES.map(name=>[name,[]]));tables.files=[current]
 tables.doc_versions=[{...source,id:id(3),file_id:source.id,version_number:1},{...current,id:id(4),file_id:source.id,version_number:2}]
 const basis={version:1,basis:'cash',net_income_cents:0}
 tables.books_tax_adjustment_workpapers=[{id:id(5),org_id:org,status:'approved',prepared_by:id(6),reviewed_by:id(7),base_snapshot:basis,base_digest:booksDigest(basis),lines:[{id:id(8),kind:'permanent',amount_cents:100,description:'Reviewed permanent difference',evidence_reference:'Original calculation',evidence_file_id:source.id,project_id:null,evidence_snapshot:taxAttachmentFromFile(org,source)}]}]
 const inventory=historicalDocumentInventory(tables,org)
 const bundle={tables,manifest:{schemaVersion:8,orgId:org,tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:[{id:source.id,storagePath:current.storage_path,sizeBytes:current.size_bytes,checksum:current.checksum}],supportingHistoricalFiles:inventory},supportingObjects:[{fileId:source.id,dataBase64:revised.toString('base64')}],supportingHistoricalObjects:inventory.filter(item=>!item.currentFileId).map(item=>({attachmentId:item.id,dataBase64:original.toString('base64')}))}
 return bundle
}
test('schema 8 keeps original version identity and bytes after current file advances, without copying shared objects twice',()=>{
 const bundle=fixture();assert.equal(verifyBooksExportBundle(bundle).valid,true)
 assert.equal(bundle.manifest.supportingHistoricalFiles.length,2);assert.equal(bundle.supportingHistoricalObjects.length,1)
 assert.equal(bundle.manifest.supportingHistoricalFiles.find(item=>item.currentFileId).currentFileId,id(2))
 const extra=structuredClone(bundle.tables.books_tax_adjustment_workpapers[0]);extra.id=id(9);extra.status='superseded';bundle.tables.books_tax_adjustment_workpapers.push(extra)
 assert.equal(historicalDocumentInventory(bundle.tables,org).length,2,'shared historical object deduplicates across workpaper versions')
})
test('historical inventory, version linkage, bytes and object counts cannot be forged by updating table checksums',()=>{
 for(const corrupt of [b=>b.supportingHistoricalObjects[0].dataBase64=Buffer.from('corrupt').toString('base64'),b=>b.manifest.supportingHistoricalFiles.pop(),b=>b.supportingHistoricalObjects=[],b=>b.supportingHistoricalObjects.push({...b.supportingHistoricalObjects[0]}),b=>b.tables.books_tax_adjustment_workpapers[0].lines[0].evidence_snapshot.document_version_id=id(99),b=>b.tables.files[0].current_version_id=id(3)]){
  const bundle=fixture();corrupt(bundle);bundle.manifest.tables=Object.fromEntries(Object.entries(bundle.tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}]));assert.equal(verifyBooksExportBundle(bundle).valid,false)
 }
 const conflict=fixture();conflict.tables.files[0].storage_path=org+'/tax/original.txt';assert.throws(()=>historicalDocumentInventory(conflict.tables,org),/conflict/)
})
test('offline gzip verification and extraction recover original and current objects into original paths',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'books-historical-documents-'))
 try{
  const bundle=fixture(),archive=path.join(root,'archive.json.gz'),destination=path.join(root,'objects')
  fs.writeFileSync(archive,gzipSync(JSON.stringify(bundle)))
  assert.equal((await verifyFileCopy(archive)).verifiedFiles,2)
  assert.equal((await extractSupportingFiles(archive,destination)).verifiedFiles,2)
  assert.deepEqual(fs.readFileSync(path.join(destination,org,'tax/original.txt')),original)
  assert.deepEqual(fs.readFileSync(path.join(destination,org,'tax/revised.txt')),revised)
  fs.writeFileSync(path.join(destination,org,'tax/original.txt'),'changed');await assert.rejects(verifyFileCopy(archive,destination),/changed/)
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
test('schema 8 requires document-version inventory while existing schema 7 current-file archives remain verifiable',()=>{
 const bundle=fixture();bundle.tables.books_tax_adjustment_workpapers=[];delete bundle.tables.doc_versions;delete bundle.manifest.tables.doc_versions
 assert.equal(verifyBooksExportBundle(bundle).valid,false)
 bundle.manifest.schemaVersion=7;bundle.manifest.tables.books_tax_adjustment_workpapers={rows:0,checksum:booksDigest([])}
 assert.equal(verifyBooksExportBundle(bundle).valid,true)
})
test('actual export service streams retained originals, reuses current objects, and refuses corrupt historical bytes',async()=>{
 const Module=require('node:module'),{gunzipSync}=require('node:zlib')
 const bundle=fixture(),downloads=[],updates=[];let upload,corrupt=false
 const service={rpc:async(name,args)=>{
  assert.equal(name,'capture_books_export_snapshot');assert.equal(args.p_org_id,org)
  return {data:{orgId:org,capturedAt:'2026-10-03T00:00:00Z',databaseSnapshot:'1:2:',tables:bundle.tables},error:null}
 },from(table){
  assert.equal(table,'books_exports')
  const query={insert(row){assert.equal(row.schema_version,BOOKS_EXPORT_SCHEMA_VERSION);return query},select(){return query},single:async()=>({data:{id:id(20)},error:null}),update(row){updates.push(row);return query},eq(){return query},then(resolve){return Promise.resolve({error:null}).then(resolve)}}
  return query
 }}
 const originalLoad=Module._load;let createExport
 try{
  Module._load=function(name,...args){
   if(name==='server-only')return {}
   if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>service}
   if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:id(6),supabase:service})}
   if(name==='@/lib/services/books/access')return {requireBooksAuthorization:async()=>{}}
   if(name==='@/lib/services/events')return {recordEvent:async()=>{}}
   if(name==='@/lib/storage/files-storage')return {
    getFilesObjectStream:async input=>{
     assert.equal(input.orgId,org);downloads.push(input.path)
     const bytes=input.path.endsWith('/original.txt')?(corrupt?Buffer.from('corrupt retained object'):original):revised
     return {body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close()}})}
    },uploadFilesObject:async input=>{upload=input;return {storagePath:input.path}}
   }
   return originalLoad.call(this,name,...args)
  }
  createExport=require('../lib/services/books/exports').createCompleteBooksExport
 }finally{Module._load=originalLoad}
 const result=await createExport({});assert.equal(result.verification.valid,true)
 const archived=JSON.parse(gunzipSync(upload.bytes));assert.equal(verifyBooksExportBundle(archived).valid,true)
 assert.deepEqual(downloads.sort(),[org+'/tax/original.txt',org+'/tax/revised.txt'].sort())
 assert.equal(archived.supportingHistoricalObjects.length,1)
 assert.deepEqual(Buffer.from(archived.supportingHistoricalObjects[0].dataBase64,'base64'),original)
 corrupt=true;upload=null
 await assert.rejects(createExport({}),/bytes differ|size differs/)
 assert.equal(upload,null);assert.equal(updates.at(-1).status,'failed')
})
