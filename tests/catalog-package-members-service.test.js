const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test'),assert=require('node:assert/strict')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function harness(){
 const calls=[],scope={expectedOrgId:id(1),expectedActorId:id(2),communityId:null},member={id:id(10),name:'Cabinets',categoryId:id(20),categoryKey:id(20),categoryName:'Kitchen',available:true},page={orgId:id(1),actorId:id(2),communityId:null,query:'',selectedIds:null,items:[member],nextCursor:null};let data=page,denied=false;const compiled={exports:{}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/services/catalog-package-members.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,process:{env:{}},require(name){if(name==='zod')return require('zod');if(name.endsWith('/context'))return {requireOrgContext:async()=>({orgId:id(1),userId:id(2)})};if(name.endsWith('/permissions'))return {requirePermission:async()=>{if(denied)throw new Error('Denied')}};if(name.endsWith('/supabase/server'))return {createServiceSupabaseClient:()=>({rpc:async(name,args)=>{calls.push({name,args});return {data,error:null}}})};return {}}})
 return {scope,page,member,calls,data:v=>data=v,deny:()=>denied=true,discover:compiled.exports.discoverCatalogPackageMembers}
}
test('server member search validates scope, bounded ordering and continuation and returns no cost fields',async()=>{
 const h=harness();const result=await h.discover(h.scope);assert.equal(result.items.length,1);assert.equal(h.calls[0].name,'discover_catalog_package_members');assert.equal(h.calls[0].args.p_ids,null)
 for(const patch of [{actorId:id(99)},{communityId:id(99)},{items:[h.member,h.member]},{items:[{...h.member,available:false}]},{items:[{...h.member,cost_cents:999}]},{nextCursor:h.member.id}]){h.data({...h.page,...patch});await assert.rejects(h.discover(h.scope),/verified/)}
 const items=Array.from({length:20},(_,n)=>({...h.member,id:id(10+n)}));h.data({...h.page,items,nextCursor:items.at(-1).id});assert.equal((await h.discover(h.scope)).items.length,20)
 h.data({...h.page,items:items.reverse(),nextCursor:id(29)});await assert.rejects(h.discover(h.scope),/verified/)
})
test('selected lookup verifies every original UUID and permits explicit missing markers without substituting foreign metadata',async()=>{
 const h=harness(),missing={id:id(99),name:null,categoryId:null,categoryKey:null,categoryName:null,available:false};h.data({...h.page,selectedIds:[id(10),id(99)],items:[h.member,missing]});const result=await h.discover({...h.scope,selectedIds:[id(99),id(10)]});assert.equal(result.items.length,2);assert.equal(result.items[1].name,null)
 for(const patch of [{items:[h.member]},{selectedIds:[id(10),id(10)]},{nextCursor:id(99)},{items:[h.member,{...missing,id:id(98)}]}]){h.data({...h.page,selectedIds:[id(10),id(99)],items:[h.member,missing],...patch});await assert.rejects(h.discover({...h.scope,selectedIds:[id(10),id(99)]}),/verified/)}
 await assert.rejects(h.discover({...h.scope,selectedIds:[id(10),id(10)]}));await assert.rejects(h.discover({...h.scope,selectedIds:[id(10)],query:'search'}));await assert.rejects(h.discover({...h.scope,selectedIds:[id(10)],cursor:id(1)}))
})
test('context and permission reject before private discovery',async()=>{
 const h=harness();await assert.rejects(h.discover({...h.scope,expectedActorId:id(99)}),/context/);h.deny();await assert.rejects(h.discover(h.scope),/Denied/);assert.equal(h.calls.length,0)
})
