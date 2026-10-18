const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function fixture({ rows = [{ id:id(1), project_id:id(2) }], denyProject = false, receipt = {kind:'move',project_ids:[id(2)]} } = {}) {
  const calls = [], checks = [], filters = []
  const query = data => {
    const chain = { then: resolve => resolve({data,error:null}) }
    for(const method of ['select','eq','in','maybeSingle']) chain[method] = (...args) => { filters.push([method,...args]); return chain }
    return chain
  }
  const service = {
    from: () => query(receipt),
    rpc: async (name,args) => { calls.push({name,args}); return {data:{receiptId:id(9),projectIds:[id(2)],files:[]},error:null} },
  }
  const mocks = {
    'server-only': {},
    '@/lib/services/context': {requireOrgContext: async () => ({orgId:id(3),userId:id(4),supabase:{from:()=>query(rows)}})},
    '@/lib/services/permissions': {
      requirePermission: async name => checks.push(name),
      requireProjectPermission: async (actor,project,permission) => { checks.push([actor,project,permission]); if(denyProject) throw new Error('Denied') },
    },
    '@/lib/supabase/server': {createServiceSupabaseClient:()=>service},
    '@/lib/services/files': {MAX_BULK_FILE_OPERATION:500,normalizeFolderPath:p=>p},
  }
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../lib/services/document-mutations.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const loadedModule={exports:{}}
  Function('exports','require','module',code)(loadedModule.exports,name=>name in mocks?mocks[name]:require(name),loadedModule)
  return {api:loadedModule.exports,calls,checks,filters}
}
test('bulk mutation checks org and every project permission before issuing one scoped transaction',async()=>{
  const f=fixture({rows:[{id:id(1),project_id:id(2)},{id:id(5),project_id:id(6)}]})
  await f.api.mutateDocuments({fileIds:[id(1),id(5)],kind:'move',folderPath:'/Target'})
  assert.deepEqual(f.checks,['docs.upload',[id(4),id(2),'docs.upload'],[id(4),id(6),'docs.upload']])
  assert.equal(f.calls.length,1)
  assert.deepEqual(f.calls[0].args.p_scopes,{[id(1)]:id(2),[id(5)]:id(6)})
  assert.equal(f.calls[0].args.p_actor_id,id(4))
  assert.ok(f.filters.some(x=>x[0]==='eq' && x[1]==='org_id' && x[2]===id(3)))
})
test('a denied project or missing selection prevents any mutation RPC',async()=>{
  const denied=fixture({denyProject:true})
  await assert.rejects(denied.api.mutateDocuments({fileIds:[id(1)],kind:'archive'}),/Denied/)
  assert.equal(denied.calls.length,0)
  const missing=fixture({rows:[]})
  await assert.rejects(missing.api.mutateDocuments({fileIds:[id(1)],kind:'restore'}),/unavailable/)
  assert.equal(missing.calls.length,0)
})
test('undo derives permission from an actor-scoped server receipt and never accepts client snapshots',async()=>{
  const f=fixture({receipt:{kind:'archive',project_ids:[id(2)]}})
  await f.api.undoDocumentMutation(id(9))
  assert.deepEqual(f.checks,['docs.delete',[id(4),id(2),'docs.delete']])
  assert.ok(f.filters.some(x=>x[0]==='eq' && x[1]==='actor_id' && x[2]===id(4)))
  assert.deepEqual(f.calls,[{name:'undo_document_mutation',args:{p_org_id:id(3),p_actor_id:id(4),p_receipt_id:id(9)}}])
  const denied=fixture({denyProject:true})
  await assert.rejects(denied.api.undoDocumentMutation(id(9)),/Denied/)
  assert.equal(denied.calls.length,0)
})
test('invalid mutation arguments are rejected before database access',async()=>{
  const f=fixture()
  await assert.rejects(f.api.mutateDocuments({fileIds:['invalid'],kind:'move'}))
  await assert.rejects(f.api.mutateDocuments({fileIds:Array(501).fill(id(1)),kind:'move'}))
  assert.equal(f.calls.length,0)
  assert.equal(f.checks.length,0)
})
