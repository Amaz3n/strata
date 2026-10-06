require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {prepareBooksRestorePlan:prepare}=require('../lib/services/books/restore-plan')
const {EXPORT_TABLES}=require('../lib/services/books/export-contract')
const {booksDigest}=require('../lib/services/books/hash')
function fixture(){
 const tables=Object.fromEntries(EXPORT_TABLES.map(table=>[table,[]]))
 tables.org_funding_sources=[{id:'funding',org_id:'org',provider:'test',status:'ready'}]
 tables.vendor_bills=[{id:'bill',org_id:'org',invoice_number_normalized:'invoice'}]
 const manifest={schemaVersion:6,orgId:'org',tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:[]}
 const columns=EXPORT_TABLES.flatMap(table=>['id','org_id'].map(name=>({table,name,notNull:true,hasDefault:false,generated:false})))
 columns.push({table:'vendor_bills',name:'invoice_number_normalized',notNull:false,hasDefault:false,generated:true})
 for(const name of ['provider','status','provider_customer_id','provider_payment_method_id','provider_mandate_id','created_by','mandate_status','verification_status','is_default','usable_after'])columns.push({table:'org_funding_sources',name,notNull:['provider','status','provider_customer_id','provider_payment_method_id','created_by'].includes(name),hasDefault:false,generated:false})
 for(const [schema,table,names]of [['public','orgs',['id']],['public','app_users',['id']],['auth','users',['id','banned_until','encrypted_password','recovery_token','email_change_token_current','reauthentication_token']]])for(const name of names)columns.push({schema,table,name,notNull:name==='id',hasDefault:false,generated:false})
 const foreignKeys=[{table:'org_funding_sources',columns:['org_id'],targetSchema:'public',targetTable:'orgs',targetColumns:['id']},{table:'org_funding_sources',columns:['created_by'],targetSchema:'public',targetTable:'app_users',targetColumns:['id']},{table:'app_users',columns:['id'],targetSchema:'auth',targetTable:'users',targetColumns:['id']}]
 return {bundle:{tables,manifest},catalog:{columns,foreignKeys},dependencies:[{schema:'public',table:'orgs',rows:[{id:'org'}]},{schema:'public',table:'app_users',rows:[{id:'actor'}]},{schema:'auth',table:'users',rows:[{id:'actor',banned_until:'infinity'}]}],fundingActors:{funding:{actorId:'actor',explanation:'Reviewed source owner; provider remains disconnected'}}}
}
test('older time archives retain their original generated-cost policy instead of taking the new double-time default',()=>{
 const input=fixture();input.bundle.tables.time_entries=[{id:'time',org_id:'org',cost_cents:36000}]
 input.bundle.manifest.tables.time_entries={rows:1,checksum:booksDigest(input.bundle.tables.time_entries)}
 input.catalog.columns.push({table:'time_entries',name:'cost_cents',notNull:false,hasDefault:false,generated:true},{table:'time_entries',name:'labor_cost_policy_version',notNull:true,hasDefault:true,generated:false})
 const plan=prepare(input)
 assert.equal(plan.tables.time_entries[0].labor_cost_policy_version,0);assert.equal('cost_cents' in plan.tables.time_entries[0],false)
 assert.equal(input.bundle.tables.time_entries[0].labor_cost_policy_version,undefined)
 assert.ok(plan.changes.some(change=>change.table==='time_entries'&&change.fields.includes('labor_cost_policy_version')))
 input.bundle.tables.time_entries[0].labor_cost_policy_version=1;input.bundle.manifest.tables.time_entries.checksum=booksDigest(input.bundle.tables.time_entries)
 assert.equal(prepare(input).tables.time_entries[0].labor_cost_policy_version,1)
})
test('payroll document restrictions record recovery changes without rewriting the archive',()=>{
 const input=fixture()
 const payroll=require('./helpers/books-payroll-register-fixture').fixture(),proof=payroll.sourceProof
 input.bundle.manifest.orgId=payroll.org;input.dependencies[0].rows[0].id=payroll.org
 for(const rows of Object.values(input.bundle.tables))for(const row of rows)row.org_id=payroll.org
 input.bundle.tables.books_payroll_imports=[{...payroll.evidence,id:payroll.run.id,org_id:payroll.org,source_checksum:proof.checksum,provider:payroll.run.provider,provider_run_id:payroll.run.provider_run_id,period_start:payroll.run.period_start,period_end:payroll.run.period_end,status:'draft',prepared_by:'actor',prepared_at:'2026-10-04T00:00:00Z',preparation_notes:'Reviewed source evidence'}]
 input.bundle.tables.files=[{id:proof.file_id,org_id:payroll.org,storage_path:proof.storage_path,size_bytes:3,checksum:proof.checksum,metadata:{provider:'original'},visibility:'public',share_with_subs:true,share_with_clients:true},{id:'general',org_id:payroll.org,storage_path:'original/general.csv',size_bytes:3,checksum:proof.checksum,metadata:{provider:'general'},visibility:'public'}]
 input.bundle.tables.doc_versions=[{id:proof.document_version_id,org_id:payroll.org,file_id:proof.file_id,storage_path:proof.storage_path,size_bytes:3,checksum:proof.checksum,file_name:proof.file_name,mime_type:proof.mime_type}]
 input.bundle.tables.projects=[{id:payroll.id(4),org_id:payroll.org}];input.bundle.tables.cost_codes=[{id:payroll.id(5),org_id:payroll.org}];input.bundle.tables.gl_accounts=payroll.postingAccounts
 for(const [table,rows]of Object.entries(input.bundle.tables))input.bundle.manifest.tables[table]={rows:rows.length,checksum:booksDigest(rows)}
 input.bundle.manifest.supportingFiles=input.bundle.tables.files.map(file=>({id:file.id,storagePath:file.storage_path,sizeBytes:file.size_bytes,checksum:file.checksum}))
 input.bundle.supportingObjects=input.bundle.tables.files.map(file=>({fileId:file.id,dataBase64:Buffer.from('abc').toString('base64')}))
 for(const name of ['metadata','visibility','share_with_subs','share_with_clients'])input.catalog.columns.push({table:'files',name,notNull:false,hasDefault:false,generated:false})
 const before=structuredClone(input),plan=prepare(input)
 assert.deepEqual(input,before)
 assert.equal(plan.tables.files[0].storage_path,proof.storage_path)
 assert.deepEqual(plan.tables.files[0].metadata,{provider:'original',books_private_kind:'payroll_register'})
 assert.equal(plan.tables.files[0].visibility,'private')
 assert.equal(plan.tables.files[0].share_with_subs,false)
 assert.equal(plan.tables.files[0].share_with_clients,false)
 assert.deepEqual(plan.tables.files[1],before.bundle.tables.files[1])
 const change=plan.changes.find(row=>row.table==='files'&&row.rowId===proof.file_id)
 assert.deepEqual(change.fields,['metadata','visibility','share_with_subs','share_with_clients'])
})
test('mapped recovery reproduces required identities, leaves funding disabled and preserves source evidence',()=>{
 const input=fixture(),before=structuredClone(input),plan=prepare(input)
 assert.deepEqual(input,before)
 assert.equal(plan.preflight.readyForRestoreAttempt,true)
 const funding=plan.tables.org_funding_sources[0]
 assert.equal(funding.status,'disabled');assert.equal(funding.mandate_status,'revoked');assert.equal(funding.is_default,false);assert.equal(funding.created_by,'actor')
 assert.equal(funding.provider_customer_id,'restore-disconnected:funding');assert.equal(funding.provider_mandate_id,null)
 assert.equal('invoice_number_normalized' in plan.tables.vendor_bills[0],false)
 assert.ok(plan.changes.some(change=>change.fields.includes('invoice_number_normalized')))
 assert.equal(plan.sourceManifestDigest,booksDigest(before.bundle.manifest))
 const {planDigest,...body}=plan;assert.equal(planDigest,booksDigest(body));assert.equal(prepare(input).planDigest,planDigest)
})
test('new generated target columns without historical values remain computed by the target',()=>{
 const input=fixture();input.catalog.columns.push({table:'vendor_bills',name:'new_generated_column',notNull:true,hasDefault:false,generated:true})
 const plan=prepare(input);assert.equal(plan.preflight.readyForRestoreAttempt,true);assert.equal('new_generated_column' in plan.tables.vendor_bills[0],false)
})
test('funding never guesses actor ownership and requires an explicit reviewed explanation',()=>{
 for(const mapping of [{},{funding:{actorId:'missing',explanation:'reviewed'}},{funding:{actorId:'actor',explanation:' '}}]){const input=fixture();input.fundingActors=mapping;assert.throws(()=>prepare(input),/explicit actor mapping/)}
})
test('identity restoration rejects active authentication and all credential/token fields',()=>{
 for(const field of ['encrypted_password','recovery_token','email_change_token_current','reauthentication_token']){const input=fixture();input.dependencies[2].rows[0][field]='secret';assert.throws(()=>prepare(input),/disabled without credentials or tokens/)}
 const input=fixture();input.dependencies[2].rows[0].banned_until=null;assert.throws(()=>prepare(input),/disabled/)
})
test('identity inputs reject unsupported, duplicate, absent and foreign organization identities',()=>{
 for(const dependency of [{schema:'public',table:'payments',rows:[]},{schema:'public',table:'orgs',rows:[]},{schema:'auth',table:'users',rows:[]}]){const input=fixture();input.dependencies.push(dependency);assert.throws(()=>prepare(input),/unsupported or duplicate/)}
 const wrong=fixture();wrong.dependencies[0].rows[0].id='other-org';assert.throws(()=>prepare(wrong),/does not match/)
 const missing=fixture();delete missing.dependencies[1].rows[0].id;assert.throws(()=>prepare(missing),/explicit nonempty IDs/)
 const duplicate=fixture();duplicate.dependencies[1].rows.push({id:'actor'});assert.throws(()=>prepare(duplicate),/duplicate IDs/)
})
test('missing auth evidence remains a relationship blocker and damaged archives cannot be mapped',()=>{
 const input=fixture();input.dependencies.pop();assert.equal(prepare(input).preflight.readyForRestoreAttempt,false)
 input.bundle.tables.org_funding_sources[0].provider='tampered';assert.throws(()=>prepare(input),/verified versioned archive/)
})
test('offline preparation writes a private new plan without overwriting files or changing input archive',()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{gzipSync}=require('node:zlib'),{spawnSync}=require('node:child_process')
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'arc-books-restore-plan-'))
 try{
  const input=fixture(),archive=path.join(root,'archive.gz'),catalog=path.join(root,'catalog.json'),mapping=path.join(root,'mapping.json'),target=path.join(root,'plan.json')
  const bytes=gzipSync(JSON.stringify(input.bundle));fs.writeFileSync(archive,bytes);fs.writeFileSync(catalog,JSON.stringify(input.catalog));fs.writeFileSync(mapping,JSON.stringify({dependencies:input.dependencies,fundingActors:input.fundingActors}))
  const args=[path.join(__dirname,'../scripts/prepare-books-restore.cjs'),archive,catalog,mapping,target]
  const run=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(run.status,0,run.stderr)
  const saved=fs.readFileSync(target);assert.equal(JSON.parse(saved).preflight.readyForRestoreAttempt,true);assert.equal(fs.statSync(target).mode&0o777,0o600);assert.deepEqual(fs.readFileSync(archive),bytes)
  assert.equal(spawnSync(process.execPath,args,{encoding:'utf8'}).status,1);assert.deepEqual(fs.readFileSync(target),saved)
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
test('schema22 restores add empty project ownership families without inventing historical assignments',()=>{
 const input=fixture();input.bundle.manifest.schemaVersion=22;input.bundle.manifest.supportingHistoricalFiles=[];input.bundle.supportingHistoricalObjects=[]
 for(const table of ['books_project_entity_proposals','books_project_entity_reviews']){delete input.bundle.tables[table];delete input.bundle.manifest.tables[table]}
 assert.equal(require('../lib/services/books/export-contract').verifyBooksExportBundle(input.bundle).valid,true,JSON.stringify(require('../lib/services/books/export-contract').verifyBooksExportBundle(input.bundle)))
 const before=structuredClone(input),plan=prepare(input)
 assert.deepEqual(plan.tables.books_project_entity_proposals,[])
 assert.deepEqual(plan.tables.books_project_entity_reviews,[])
 assert.deepEqual(input,before)
 input.bundle.tables.books_project_entity_proposals=[{id:'invented',org_id:'org'}]
 input.bundle.manifest.tables.books_project_entity_proposals={rows:1,checksum:booksDigest(input.bundle.tables.books_project_entity_proposals)}
 assert.throws(()=>prepare(input),/verified versioned archive/)
})

test('schema23 restore adds empty cancellation history and rejects invented cancellation rows',()=>{
 const input=fixture();input.bundle.manifest.schemaVersion=23;input.bundle.manifest.supportingHistoricalFiles=[];input.bundle.supportingHistoricalObjects=[];
 const table='books_project_owner_request_resolutions';delete input.bundle.tables[table];delete input.bundle.manifest.tables[table];
 assert.equal(require('../lib/services/books/export-contract').verifyBooksExportBundle(input.bundle).valid,true);
 const before=structuredClone(input),plan=prepare(input);assert.deepEqual(plan.tables[table],[]);assert.deepEqual(input,before);
 input.bundle.tables[table]=[{id:'invented',org_id:'org'}];input.bundle.manifest.tables[table]={rows:1,checksum:booksDigest(input.bundle.tables[table])};
 assert.throws(()=>prepare(input),/verified versioned archive/);
});
