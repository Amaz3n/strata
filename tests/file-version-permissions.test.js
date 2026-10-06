const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript')
function fixture(allowed=false){
  const reads=[],writes=[],checks=[],signed=[]
  const supabase={from(table){
    reads.push(table)
    const chain={then:resolve=>resolve({data:table==='files'?{id:'file',project_id:'project',current_version_id:'version'}:{id:'version',file_id:'file',storage_path:'org/path',file_name:'x.pdf'},error:null,count:1})}
    for(const method of ['select','eq','single','maybeSingle','order'])chain[method]=()=>chain
    chain.update=data=>{writes.push(data);return chain}
    return chain
  }}
  const mocks={
    '@/lib/services/document-upload-object':{},
    '@/lib/services/context':{requireOrgContext:async()=>({orgId:'org',userId:'actor',supabase})},
    '@/lib/services/permissions':{requirePermission:async()=>{},requireProjectPermission:async(actor,project,permission)=>{checks.push(permission);if(!allowed)throw new Error('Project denied')}},
    '@/lib/supabase/server':{},
    '@/lib/services/audit':{recordAudit:async()=>{}},
    '@/lib/storage/files-storage':{ensureOrgScopedPath:(_,p)=>p,createFilesDownloadUrl:async args=>{signed.push(args);return {downloadUrl:'signed'}}},
  }
  const code=ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../lib/services/file-versions.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const loadedModule={exports:{}}
  Function('exports','require','module',code)(loadedModule.exports,name=>name in mocks?mocks[name]:require(name),loadedModule)
  return {api:loadedModule.exports,reads,writes,checks,signed}
}
test('version list and existence checks authorize the owning project before loading history',async()=>{
  for(const method of ['listVersions','hasVersions']){
    const f=fixture()
    await assert.rejects(f.api[method]('file'),/Project denied/)
    assert.deepEqual(f.reads,['files'])
    assert.deepEqual(f.checks,['docs.read'])
  }
})
test('version downloads and metadata updates cannot bypass project permissions',async()=>{
  const download=fixture()
  await assert.rejects(download.api.getVersionSignedUrl('version'),/Project denied/)
  assert.deepEqual(download.checks,['docs.download'])
  assert.equal(download.signed.length,0)
  const update=fixture()
  await assert.rejects(update.api.updateVersion('version',{label:'test'}),/Project denied/)
  assert.deepEqual(update.checks,['docs.upload'])
  assert.equal(update.writes.length,0)
})
test('authorized version downloads sign attachment URLs with requested expiration',async()=>{
  const f=fixture(true)
  assert.equal(await f.api.getVersionSignedUrl('version',120),'signed')
  assert.equal(f.signed[0].expiresIn,120)
  assert.equal(f.signed[0].disposition,'attachment')
})
