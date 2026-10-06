require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),{createHash}=require('node:crypto')
const {taxAttachmentFromFile}=require('../lib/services/books/tax-attachment-rules')
const {org,fixture}=require('./support/books-cash-profit-loss-fixture')
const {cashProfitAndLossFromSnapshot}=require('../lib/services/books/cash-profit-loss')
const {cashTaxWorkpaperBasis}=require('../lib/services/books/tax-adjustment-rules')
const id=n=>'99400000-0000-4000-8000-'+String(n).padStart(12,'0')
const bytes=Buffer.from('Reviewed tax calculation'),checksum=createHash('sha256').update(bytes).digest('hex')
const file={id:id(1),org_id:org,current_version_id:id(2),storage_path:org+'/tax/original.txt',file_name:'Tax calculation.txt',mime_type:'text/plain',size_bytes:bytes.length,checksum}
let streamed=bytes,denied=false,calls=[],batch,preparedLines,liveFile=file
const original=Module._load
let verifier,api
try{
 Module._load=function(name,...args){
  if(name==='@/lib/storage/files-storage')return {getFilesObjectStream:async input=>{calls.push(['bytes',input.path]);return {body:new ReadableStream({start(controller){controller.enqueue(streamed);controller.close()}})}}}
  if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>client}
  if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:id(9),supabase:client})}
  if(name==='@/lib/services/books/access')return {requireBooksAuthorization:async()=>{if(denied)throw new Error('Denied')}}
  return original.call(this,name,...args)
 }
 verifier=require('../lib/services/books/tax-attachments').verifyTaxAttachmentBytes
 api=require('../lib/services/books/tax-adjustments')
}finally{Module._load=original}
const client={async rpc(name,args){calls.push([name]);if(name==='capture_books_tax_workpaper_context'){const snapshot=fixture();snapshot.tables.files=[liveFile];snapshot.tables.books_tax_adjustment_workpapers=batch?[batch]:[];return {data:{...snapshot,taxSourceRevision:'a'.repeat(64)},error:null}}if(name==='prepare_books_tax_workpaper'){preparedLines=args.p_lines;return {data:id(3),error:null}}if(name==='review_books_tax_workpaper')return {data:id(3),error:null};throw new Error(name)},from(){const query={select(){return query},eq(){return query},single:async()=>({data:batch,error:null})};return query}}
const proof=taxAttachmentFromFile(org,file)
test('frozen attachment identity rejects unknown bytes, wrong scope and unsafe metadata',()=>{
 assert.equal(proof.document_version_id,id(2));assert.equal(proof.storage_path,file.storage_path)
 for(const patch of [{org_id:id(99)},{checksum:null},{size_bytes:null},{size_bytes:0.5},{storage_path:id(99)+'/tax.txt'},{storage_path:org+'/../outside'},{storage_path:org+'//empty'}])assert.throws(()=>taxAttachmentFromFile(org,{...file,...patch}))
})
test('original attachment bytes are verified by streaming size and digest',async()=>{
 calls=[];streamed=bytes;await verifier(client,org,proof);assert.deepEqual(calls,[['bytes',file.storage_path]])
 for(const content of [Buffer.from('wrong but exact length!!'),bytes.subarray(1),Buffer.concat([bytes,Buffer.from('extra')])]){streamed=content;await assert.rejects(verifier(client,org,proof),/differs|differ/)}
 streamed=bytes;await assert.rejects(verifier(client,id(99),proof),/outside organization/)
})
test('preparation freezes server metadata and checks bytes before an immutable draft is written',async()=>{
 calls=[];denied=true;await assert.rejects(api.prepareTaxWorkpaper({startDate:'2026-09-01',endDate:'2026-09-30',lines:[],idempotencyKey:'attachment-test-key'}),/Denied/);assert.deepEqual(calls,[])
 denied=false;streamed=bytes;const line={id:id(4),kind:'permanent',amount_cents:500,description:'Reviewed permanent difference',evidence_reference:'Tax calculation',evidence_file_id:file.id,project_id:null,evidence_snapshot:{...proof,checksum:'b'.repeat(64)}}
 await api.prepareTaxWorkpaper({startDate:'2026-09-01',endDate:'2026-09-30',lines:[line],idempotencyKey:'attachment-test-key'});assert.deepEqual(preparedLines[0].evidence_snapshot,proof);assert.deepEqual(calls.map(row=>row[0]),['capture_books_tax_workpaper_context','bytes','prepare_books_tax_workpaper'])
 calls=[];streamed=Buffer.from('corrupt');await assert.rejects(api.prepareTaxWorkpaper({startDate:'2026-09-01',endDate:'2026-09-30',lines:[line],idempotencyKey:'attachment-failed-key'}),/differ/);assert.ok(!calls.some(row=>row[0]==='prepare_books_tax_workpaper'))
})
test('review and report verify saved original bytes after the live file advances, and reject corrupt or missing frozen evidence',async()=>{
 const basis=cashTaxWorkpaperBasis(cashProfitAndLossFromSnapshot(org,'2026-09-01','2026-09-30',fixture()),'a'.repeat(64))
 batch={id:id(3),org_id:org,period_start:'2026-09-01',period_end:'2026-09-30',status:'approved',base_snapshot:basis.snapshot,base_digest:basis.digest,lines:preparedLines,prepared_by:id(8),reviewed_by:id(9),reviewed_at:'2026-10-01T12:00:00Z',review_notes:'Reviewed original tax calculation bytes'}
 liveFile={...file,current_version_id:id(5),storage_path:org+'/tax/new.txt',checksum:'b'.repeat(64)};streamed=bytes;calls=[]
 await api.reviewTaxWorkpaper({id:batch.id,notes:'Reviewed original tax calculation bytes'});assert.equal(calls.find(row=>row[0]==='bytes')[1],file.storage_path)
 assert.equal((await api.buildTaxWorkpaperReport('2026-09-01','2026-09-30')).adjustedIncomeCents,497)
 streamed=Buffer.from('corrupt');await assert.rejects(api.buildTaxWorkpaperReport('2026-09-01','2026-09-30'),/differ/)
 delete batch.lines[0].evidence_snapshot;streamed=bytes;await assert.rejects(api.reviewTaxWorkpaper({id:batch.id,notes:'Reviewed original tax calculation bytes'}),/lacks frozen evidence/)
})

test('schema 7 refuses recovery claims when the frozen tax attachment differs from its archived current file',()=>{
 const {verifyBooksExportBundle}=require('../lib/services/books/export-contract'),{booksDigest}=require('../lib/services/books/hash')
 const snapshot=fixture();snapshot.tables.projects=[];snapshot.tables.files=[file];snapshot.tables.books_tax_adjustment_workpapers=[{id:id(3),org_id:org,status:'approved',prepared_by:id(8),reviewed_by:id(9),base_snapshot:{basis:'cash'},base_digest:booksDigest({basis:'cash'}),lines:[{id:id(4),kind:'permanent',amount_cents:100,description:'Reviewed permanent difference',evidence_reference:'Original document reference',evidence_file_id:file.id,project_id:null,evidence_snapshot:proof}]}]
 // Only assert the tax-evidence guard: this compact fixture deliberately has
 // no embedded object inventory and is not a complete recovery bundle.
 const bundle={tables:snapshot.tables,manifest:{schemaVersion:7,orgId:org,tables:Object.fromEntries(Object.entries(snapshot.tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:[]},supportingObjects:[]}
 assert.ok(!verifyBooksExportBundle(bundle).integrityErrors.some(error=>error.includes('Frozen tax attachment bytes')))
 snapshot.tables.files[0]={...file,storage_path:org+'/tax/new.txt',checksum:'b'.repeat(64)}
 bundle.manifest.tables.files.checksum=booksDigest(snapshot.tables.files)
 assert.ok(verifyBooksExportBundle(bundle).integrityErrors.some(error=>error.includes('Frozen tax attachment bytes are missing')))
})
