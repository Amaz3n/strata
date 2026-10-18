require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {preflightBooksRestore:preflight}=require('../lib/services/books/restore-preflight')
const {EXPORT_TABLES}=require('../lib/services/books/export-contract')
const {booksDigest}=require('../lib/services/books/hash')
function fixture(){
 const tables=Object.fromEntries(EXPORT_TABLES.map(table=>[table,[]]))
 tables.org_funding_sources=[{id:'funding',org_id:'org',provider:'provider'}]
 const manifest={schemaVersion:6,orgId:'org',tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:[]}
 const columns=EXPORT_TABLES.flatMap(table=>[{table,name:'id',notNull:true,hasDefault:true,generated:false},{table,name:'org_id',notNull:true,hasDefault:false,generated:false}])
 columns.push(...['provider','provider_customer_id','created_by'].map(name=>({table:'org_funding_sources',name,notNull:true,hasDefault:false,generated:false})))
 const foreignKeys=[{table:'org_funding_sources',columns:['org_id'],targetSchema:'public',targetTable:'orgs',targetColumns:['id']},{table:'org_funding_sources',columns:['created_by'],targetSchema:'public',targetTable:'app_users',targetColumns:['id']}]
 return {bundle:{tables,manifest},catalog:{columns,foreignKeys}}
}
function refresh(bundle){bundle.manifest.tables=Object.fromEntries(Object.entries(bundle.tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}]))}
test('restore preflight surfaces redacted required values and external organization/user identities',()=>{
 const {bundle,catalog}=fixture();const result=preflight(bundle,catalog)
 assert.equal(result.readyForRestoreAttempt,false)
 assert.ok(result.blockers.some(blocker=>blocker.column==='provider_customer_id'))
 assert.ok(result.blockers.some(blocker=>blocker.column==='created_by'))
 assert.equal(result.externalDependencies[0].targetTable,'orgs')
 bundle.tables.org_funding_sources[0].created_by='actor';refresh(bundle)
 assert.ok(preflight(bundle,catalog).externalDependencies.some(dependency=>dependency.targetTable==='app_users'&&dependency.values[0]==='actor'))
})
test('defaults apply only to absent values while explicit null still violates required columns',()=>{
 const {bundle,catalog}=fixture();catalog.foreignKeys=[]
 for(const column of catalog.columns)if(column.name==='provider_customer_id'||column.name==='created_by')column.hasDefault=true
 assert.equal(preflight(bundle,catalog).readyForRestoreAttempt,true)
 bundle.tables.org_funding_sources[0].provider_customer_id=null;refresh(bundle)
 assert.equal(preflight(bundle,catalog).readyForRestoreAttempt,false)
})
test('all actual composite foreign-key columns participate in restored relationship matching',()=>{
 const {bundle,catalog}=fixture();catalog.foreignKeys=[{table:'org_funding_sources',columns:['id','org_id'],targetSchema:'public',targetTable:'companies',targetColumns:['id','org_id']}]
 bundle.tables.companies=[{id:'funding',org_id:'org'}];refresh(bundle)
 assert.ok(!preflight(bundle,catalog).blockers.some(blocker=>blocker.reason.includes('relationship')))
 bundle.tables.org_funding_sources[0].id='missing';refresh(bundle)
 assert.ok(preflight(bundle,catalog).blockers.some(blocker=>blocker.reason.includes('Missing restored relationship')))
})
test('generated and unknown target columns require explicit schema-aware restoration handling',()=>{
 const {bundle,catalog}=fixture();bundle.tables.org_funding_sources[0].computed='value';bundle.tables.org_funding_sources[0].old_column='old';refresh(bundle)
 catalog.columns.push({table:'org_funding_sources',name:'computed',notNull:false,hasDefault:false,generated:true})
 const reasons=preflight(bundle,catalog).blockers.map(blocker=>blocker.reason)
 assert.ok(reasons.includes('Generated columns require explicit target-schema restoration handling'))
 assert.ok(reasons.includes('Column is absent from the target schema'))
})
test('preflight never accepts invalid archives, missing manifests or absent target catalog evidence',()=>{
 const {bundle,catalog}=fixture();assert.throws(()=>preflight({...bundle,manifest:undefined},catalog),/manifest/)
 const invalid=structuredClone(bundle);invalid.tables.org_funding_sources[0].provider='changed';assert.throws(()=>preflight(invalid,catalog),/integrity/)
 assert.throws(()=>preflight(bundle,{columns:[],foreignKeys:[]}),/catalog evidence/)
 assert.throws(()=>preflight(bundle,{...catalog,foreignKeys:[{table:'org_funding_sources',columns:['id'],targetSchema:'public',targetTable:'companies',targetColumns:[]}]}),/foreign-key catalog/)
})
test('MATCH FULL composite relationships reject partial nulls while MATCH SIMPLE skips them',()=>{
 const {bundle,catalog}=fixture();catalog.foreignKeys=[{table:'org_funding_sources',columns:['created_by','org_id'],targetSchema:'public',targetTable:'app_users',targetColumns:['id','org_id'],match:'full'}]
 assert.ok(preflight(bundle,catalog).blockers.some(blocker=>blocker.reason.includes('MATCH FULL')))
 catalog.foreignKeys[0].match='simple';assert.ok(!preflight(bundle,catalog).blockers.some(blocker=>blocker.reason.includes('MATCH FULL')))
})
test('offline CLI writes a new mapping report without overwriting evidence or modifying the archive',()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{gzipSync}=require('node:zlib'),{spawnSync}=require('node:child_process')
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'arc-books-restore-preflight-'))
 try{
  const {bundle,catalog}=fixture(),archive=path.join(root,'archive.json.gz'),target=path.join(root,'catalog.json'),report=path.join(root,'report.json')
  const bytes=gzipSync(JSON.stringify(bundle));fs.writeFileSync(archive,bytes);fs.writeFileSync(target,JSON.stringify(catalog))
  const command=[path.join(__dirname,'../scripts/preflight-books-restore.cjs'),archive,target,report]
  const checked=spawnSync(process.execPath,command,{encoding:'utf8'});assert.equal(checked.status,2,checked.stderr)
  const output=fs.readFileSync(report);assert.equal(JSON.parse(output).readyForRestoreAttempt,false);assert.deepEqual(fs.readFileSync(archive),bytes)
  assert.equal(spawnSync(process.execPath,command,{encoding:'utf8'}).status,1);assert.deepEqual(fs.readFileSync(report),output)
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
