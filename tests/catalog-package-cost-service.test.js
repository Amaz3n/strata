require('../scripts/register-ts-node-test')
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test'),assert=require('node:assert/strict')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function harness(margin=false){
 const calls=[],permissions=[],compiled={exports:{}}
 const context={orgId:id(1),userId:id(2),supabase:{from(table){
  const entry={table,payload:null,select:null};calls.push(entry)
  const query={eq(){return query},in(){return query},select(value){entry.select=value;return query},update(value){entry.payload=value;return query},insert(value){entry.payload=value;return query},delete(){return query},async single(){return {data:{id:id(10),community_id:null,name:'Bundle',description:null,image_url:null,price_cents:123,cost_cents:entry.payload.cost_cents??7777,is_available:true,is_archived:false,sort_order:0},error:null}},then(resolve,reject){return Promise.resolve({data:table==='selection_options'?[{id:id(50),category_id:id(40)}]:[],error:null}).then(resolve,reject)}}
  return query
 }}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/services/option-catalog.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,process:{env:{}},require(name){
  if(name==='zod')return require('zod')
  if(name==='@/lib/validation/selections')return require('../lib/validation/selections')
  if(name==='@/lib/services/context')return {requireOrgContext:async()=>context}
  if(name==='@/lib/services/permissions')return {hasPermission:async()=>margin,requirePermission:async permission=>{permissions.push(permission);if(permission==='financials.margin.read'&&!margin)throw Error('Margin denied')}}
  if(name==='@/lib/services/audit')return {recordAudit:async()=>{}}
  return {}
 }})
 const request={id:id(10),expectedOrgId:context.orgId,expectedActorId:context.userId,name:'Bundle',priceCents:123,optionIds:[id(50)]}
 return {calls,permissions,request,save:input=>compiled.exports.upsertPackage(input)}
}
test('legacy price/member edit preserves omitted cost and strips cost even from an overbroad provider response',async()=>{
 const h=harness(),result=await h.save(h.request),write=h.calls.find(call=>call.table==='selection_packages')
 assert.equal(Object.hasOwn(write.payload,'cost_cents'),false);assert.ok(!write.select.includes('cost_cents'));assert.equal(Object.hasOwn(result,'cost_cents'),false)
 assert.deepEqual(h.permissions,['selections.catalog.manage'])
 const privileged=harness(true),visible=await privileged.save(privileged.request);assert.equal(visible.cost_cents,7777)
 assert.ok(privileged.calls.find(call=>call.table==='selection_packages').select.includes('cost_cents'))
})
test('legacy explicit cost assignment/clear is permission-fenced before provider reads or writes',async()=>{
 for(const costCents of [null,0,100]){
  const h=harness();await assert.rejects(h.save({...h.request,costCents}),/Margin denied/);assert.equal(h.calls.length,0)
 }
 const h=harness(true);await h.save({...h.request,costCents:null});assert.equal(h.calls.find(call=>call.table==='selection_packages').payload.cost_cents,null)
})
