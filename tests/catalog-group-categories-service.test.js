const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test'),assert=require('node:assert/strict')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function harness(){
 const calls=[],scope={expectedOrgId:id(1),expectedActorId:id(2),communityId:null},member={id:id(10),name:'Kitchen',categoryId:id(10),categoryKey:id(10),categoryName:'Kitchen',available:true},page={orgId:id(1),actorId:id(2),communityId:null,query:'',selectedIds:null,items:[member],nextCursor:null};let data=page,denied=false;const compiled={exports:{}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/services/catalog-group-categories.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,process:{env:{}},require(name){if(name==='zod')return require('zod');if(name.endsWith('/context'))return {requireOrgContext:async()=>({orgId:id(1),userId:id(2)})};if(name.endsWith('/permissions'))return {requirePermission:async()=>{if(denied)throw new Error('Denied')}};if(name.endsWith('/supabase/server'))return {createServiceSupabaseClient:()=>({rpc:async(name,args)=>{calls.push({name,args});return {data,error:null}}})};return {}}})
 return {scope,page,member,calls,data:v=>data=v,deny:()=>denied=true,labels:compiled.exports.readCatalogGroupCategoryLabels,discover:compiled.exports.discoverCatalogGroupCategories}
}
test('bounded rule category search verifies self identity, original scope, canonical ordering and continuation without private fields',async()=>{
 const h=harness();assert.equal((await h.discover(h.scope)).items.length,1);assert.equal(h.calls[0].name,'discover_catalog_group_categories')
 for(const patch of [{actorId:id(99)},{communityId:id(99)},{items:[h.member,h.member]},{items:[{...h.member,available:false}]},{items:[{...h.member,categoryId:id(20)}]},{items:[{...h.member,categoryKey:id(20)}]},{items:[{...h.member,cost_cents:999}]},{nextCursor:h.member.id}]){h.data({...h.page,...patch});await assert.rejects(h.discover(h.scope),/verified/)}
 const items=Array.from({length:20},(_,n)=>({...h.member,id:id(10+n),categoryId:id(10+n),categoryKey:id(10+n)}));h.data({...h.page,items,nextCursor:items.at(-1).id});assert.equal((await h.discover(h.scope)).items.length,20)
 h.data({...h.page,items:items.reverse(),nextCursor:id(29)});await assert.rejects(h.discover(h.scope),/verified/)
})
test('selected category lookup preserves all references including unavailable markers and rejects partial, duplicate or mixed lookup replies',async()=>{
 const h=harness(),missing={id:id(99),name:null,categoryId:null,categoryKey:null,categoryName:null,available:false};h.data({...h.page,selectedIds:[id(10),id(99)],items:[h.member,missing]});assert.equal((await h.discover({...h.scope,selectedIds:[id(99),id(10)]})).items.length,2)
 for(const patch of [{items:[h.member]},{selectedIds:[id(10),id(10)]},{nextCursor:id(99)},{items:[h.member,{...missing,id:id(98)}]}]){h.data({...h.page,selectedIds:[id(10),id(99)],items:[h.member,missing],...patch});await assert.rejects(h.discover({...h.scope,selectedIds:[id(10),id(99)]}),/verified/)}
 for(const input of [{selectedIds:[id(10),id(10)]},{selectedIds:[id(10)],query:'x'},{selectedIds:[id(10)],cursor:id(1)}])await assert.rejects(h.discover({...h.scope,...input}))
})
test('actor/organization and permissions gate category discovery before any RPC',async()=>{
 const h=harness();await assert.rejects(h.discover({...h.scope,expectedActorId:id(99)}),/context/);h.deny();await assert.rejects(h.discover(h.scope),/Denied/);assert.equal(h.calls.length,0)
})

test('visible rule labels validate complete original reference coverage and reject private or foreign reply evidence',async()=>{
 const h=harness(),input={...h.scope,groupIds:[id(80)],categoryIds:[id(10),id(99),id(10)]},reply={orgId:id(1),actorId:id(2),communityId:null,labels:[{id:id(10),name:'Kitchen'},{id:id(99),name:null}]};h.data(reply)
 assert.deepEqual(JSON.parse(JSON.stringify(await h.labels(input))),reply.labels);assert.equal(h.calls[0].name,'read_catalog_group_category_labels');assert.deepEqual(h.calls[0].args.p_group_ids,[id(80)]);assert.equal(h.calls[0].args.p_category_ids,undefined)
 for(const patch of [{actorId:id(99)},{orgId:id(99)},{communityId:id(99)},{labels:[reply.labels[0]]},{labels:[reply.labels[0],reply.labels[0]]},{labels:[reply.labels[1],reply.labels[0]]},{labels:[reply.labels[0],{id:id(98),name:null}]},{labels:[{...reply.labels[0],cost_cents:99},reply.labels[1]]}]){h.data({...reply,...patch});await assert.rejects(h.labels(input),/verified/)}
})
test('rule label lookup rejects oversized/duplicate groups and reauthorizes current actor before transport',async()=>{
 const h=harness(),input={...h.scope,groupIds:[],categoryIds:[]};
 await assert.rejects(h.labels({...input,groupIds:Array.from({length:26},(_,n)=>id(80+n))}));await assert.rejects(h.labels({...input,groupIds:[id(80),id(80)]}));await assert.rejects(h.labels({...input,expectedActorId:id(99)}),/context/);h.deny();await assert.rejects(h.labels(input),/Denied/);assert.equal(h.calls.length,0)
})
