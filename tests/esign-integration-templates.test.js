require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript')
function load({allow=true}={}){
 const calls=[],exports={},db={rpc:async(name,args)=>{calls.push({name,args});return {data:{id:'existing-document',status:'sent'},error:null}}}
 const deps={zod:require('zod'),'@/lib/validation/documents':require('../lib/validation/documents'),'@/lib/supabase/server':{createServiceSupabaseClient:()=>db},'@/lib/services/authorization':{requireAuthorization:async()=>{if(!allow)throw Error('Forbidden')}}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/services/esign-templates.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:n=>deps[n]??{},Set,Date,Error})
 return {api:exports,calls}
}
const field={page_index:0,field_type:'signature',signer_role:'buyer',x:.1,y:.2,w:.3,h:.1}
test('bulk template maps a sole role and rejects multi-role templates',()=>{
 const {api}=load();assert.equal(api.normalizeSingleSignerTemplate([field],[{role:'signer',signer_role:'buyer'}])[0].signer_role,'signer_1')
 assert.throws(()=>api.normalizeSingleSignerTemplate([field,{...field,signer_role:'builder'}],[]),/one signer/)
 assert.throws(()=>api.normalizeSingleSignerTemplate([field],[{role:'signer',signer_role:'other'}]),/one signer/)
 assert.throws(()=>api.normalizeSingleSignerTemplate([],[]),/signing fields/)
})
const id='00000000-0000-4000-8000-000000000001',input={orgId:id,userId:id,projectId:id,templateId:id,batchId:id,recipient:{email:'  Person@Example.com '}}
test('reservation passes a stable batch and normalized email to atomic RPC and returns existing document',async()=>{
 const h=load();const result=await h.api.reserveBulkTemplateDocument(input)
 assert.equal(result.id,'existing-document');assert.equal(result.status,'sent')
 assert.equal(h.calls[0].name,'reserve_esign_bulk_document');assert.equal(h.calls[0].args.p_recipient.email,'person@example.com');assert.equal(h.calls[0].args.p_batch_id,id)
})
test('bulk authorization failure never reaches privileged document creation',async()=>{
 const h=load({allow:false});await assert.rejects(h.api.reserveBulkTemplateDocument(input),/Forbidden/);assert.equal(h.calls.length,0)
})
