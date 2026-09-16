require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { projectUploadRequestSchema } = require('../lib/validation/files')
let calls = [], denied = false
const projectId = '00000000-0000-0000-0000-000000000001'
const supabase = { from(table) {
  calls.push(['from',table])
  const query = {}
  for (const method of ['select','eq','is','or','not','order','range','lte']) {
    query[method]=(...args)=>{calls.push([method,...args]);return query}
  }
  query.maybeSingle=async()=>({data:{id:projectId},error:null})
  query.then=(resolve,reject)=>Promise.resolve({data:[],count:0,error:null}).then(resolve,reject)
  return query
}, rpc: async(name,args)=> {calls.push(['rpc',name,args]);return {data:[{category:'all',file_count:4}],error:null}} }
const original=Module._load
Module._load=function(request,...args) {
  const mocks = {
    '@/lib/services/context': {requireOrgContext:async()=>({supabase,orgId:'org',userId:'actor'})},
    '@/lib/services/permissions': {
      requirePermission:async(permission)=>{calls.push(['permission',permission]);if(denied)throw new Error('Forbidden')},
      requireProjectPermission:async(user,project,permission)=>{calls.push(['projectPermission',project,permission]);if(denied)throw new Error('Forbidden')},
    },
    '@/lib/storage/files-storage': {}, '@/lib/services/audit':{}, '@/lib/services/events':{},
    './file-versions':{}, './files-indexing':{},
    './file-source-contexts':{findFileIdsBySourceSearch:async()=>[]},
  }
  return mocks[request] ?? original.call(this,request,...args)
}
const {listFiles, getFileCounts, prepareProjectDocumentUpload}=require('../lib/services/files')
Module._load=original
function reset(){calls=[];denied=false}

test('office filtering excludes both project and prospect files during search and pagination',async()=>{
  reset()
  await listFiles({org_only:true,search:'handbook',offset:100,limit:100})
  for(const filter of [['eq','org_id','org'],['is','project_id',null],['is','prospect_id',null],['range',100,199]]) {
    assert.ok(calls.some(call=>JSON.stringify(call)===JSON.stringify(filter)),JSON.stringify(filter))
  }
})
test('project lists retain their project scope',async()=>{
  reset()
  await listFiles({project_id:projectId})
  assert.ok(calls.some(call=>call[0]==='eq' && call[1]==='project_id' && call[2]===projectId))
  assert.ok(!calls.some(call=>call[0]==='is' && call[1]==='project_id'))
})
test('office counts use the office-only aggregate',async()=>{
  reset()
  assert.deepEqual(await getFileCounts(undefined,undefined,true),{all:4})
  assert.ok(calls.some(call=>call[0]==='rpc' && call[1]==='office_document_counts' && call[2].p_org_id==='org'))
})
test('office uploads use organization permission and general storage, without querying a project',async()=>{
  reset()
  const input=projectUploadRequestSchema.parse({fileName:'Handbook.pdf',contentType:'application/pdf',fileSize:100})
  const result=await prepareProjectDocumentUpload(input)
  assert.match(result.storagePath,/^org\/general\/documents\/uploads\//)
  assert.ok(calls.some(call=>call[0]==='permission' && call[1]==='docs.upload'))
  assert.ok(!calls.some(call=>call[0]==='projectPermission' || call[0]==='from'))
})
test('project uploads still require project authorization and org ownership',async()=>{
  reset()
  const result=await prepareProjectDocumentUpload({projectId,fileName:'Plans.pdf',fileSize:100,contentType:'application/pdf'})
  assert.ok(result.storagePath.startsWith(`org/${projectId}/documents/uploads/`))
  assert.ok(calls.some(call=>call[0]==='projectPermission' && call[1]===projectId))
  assert.ok(calls.some(call=>call[0]==='eq' && call[1]==='org_id' && call[2]==='org'))
})
test('office upload permission failures are forbidden and malformed project IDs are rejected',async()=>{
  reset();denied=true
  await assert.rejects(prepareProjectDocumentUpload({fileName:'Handbook.pdf',fileSize:100,contentType:'application/pdf'}),error=>error.status===403)
  assert.equal(projectUploadRequestSchema.safeParse({projectId:'bad',fileName:'Handbook.pdf'}).success,false)
})

test('multipart office uploads remain bound to the current organization and upload namespace',()=>{
  const {projectIdFromDocumentStoragePath}=require('../lib/files/content-policy')
  assert.equal(projectIdFromDocumentStoragePath('org','org/general/documents/uploads/handbook.pdf'),'general')
  for(const path of ['other/general/documents/uploads/handbook.pdf','org/general/documents/handbook.pdf','org/general/documents/uploads/../private.pdf','org/general/documents/uploads/']) {
    assert.equal(projectIdFromDocumentStoragePath('org',path),null)
  }
})
