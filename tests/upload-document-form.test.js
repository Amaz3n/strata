const test = require('node:test')
const assert = require('node:assert/strict')
const { stubModule, freshRequire } = require('./support/modules')

let uploads, legacy
stubModule('@/app/(app)/documents/actions', {
  uploadFileAction: async form => { legacy.push(form); return { success: true, data: { id: 'org-file' } } },
})
stubModule('lib/files/active-transfer-queue.ts', {
  getActiveDocumentTransferQueue: () => ({
    enqueue: async (file, options) => { uploads.push({ file, options }); return { id: 'project-file', file_name: file.name } },
  }),
})
const { uploadDocumentForm } = freshRequire('lib/files/upload-document-form.ts')

function fixture() {
  uploads = []
  legacy = []
  return { uploadDocumentForm, get uploads() { return uploads }, get legacy() { return legacy } }
}
function form(project=true){const value=new FormData();value.set('file',new File(['content'],'report.pdf',{type:'application/pdf'}));if(project)value.set('projectId','project');return value}
test('project forms preserve folder, category, visibility, description, tags and explicit share flags through the queue',async()=>{
  const f=fixture(),value=form()
  for(const [key,item]of Object.entries({folderPath:'/Contracts',category:'contracts',visibility:'private',description:'Signed copy',tags:' one, two , ,three',shareWithClients:'true',shareWithSubs:'false'}))value.set(key,item)
  const result=await f.uploadDocumentForm(value)
  assert.equal(result.success,true)
  assert.equal(result.data.id,'project-file')
  assert.deepEqual(f.uploads[0].options,{projectId:'project',folderPath:'/Contracts',category:'contracts',visibility:'private',description:'Signed copy',tags:['one','two','three'],shareWithClients:true,shareWithSubs:false})
  assert.equal(f.legacy.length,0)
})
test('absent folder keeps category defaults while an explicitly empty folder selects root',async()=>{
  const f=fixture(),defaultFolder=form(),root=form()
  root.set('folderPath','')
  await f.uploadDocumentForm(defaultFolder);await f.uploadDocumentForm(root)
  assert.equal(f.uploads[0].options.folderPath,undefined)
  assert.equal(f.uploads[1].options.folderPath,'')
  assert.equal(f.uploads[0].options.visibility,'public')
  assert.equal(f.uploads[0].options.shareWithClients,undefined)
  assert.deepEqual(f.uploads[0].options.tags,[])
})
test('organization-owned uploads retain the existing authenticated action contract',async()=>{
  const f=fixture(),value=form(false)
  assert.deepEqual(await f.uploadDocumentForm(value),{success:true,data:{id:'org-file'}})
  assert.equal(f.uploads.length,0)
  assert.equal(f.legacy[0],value)
})
test('invalid files and categories return action failures without enqueueing uploads',async()=>{
  const f=fixture(),value=new FormData()
  value.set('file','not a file')
  assert.deepEqual(await f.uploadDocumentForm(value),{success:false,error:'No file provided'})
  const badCategory=form();badCategory.set('category','invalid')
  assert.equal((await f.uploadDocumentForm(badCategory)).success,false)
  assert.equal(f.uploads.length,0)
  assert.equal(f.legacy.length,0)
})
