require('../scripts/register-ts-node-test')
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test'),assert=require('node:assert/strict')
const schemas=require('../lib/validation/selections'),id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function compile(file,dependencies){const compiled={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,process:{env:dependencies.env??{}},require:name=>dependencies[name]??(name==='zod'?require('zod'):name==='@/lib/validation/selections'?schemas:{})});return compiled.exports}
function harness(){
 const context={orgId:id(1),userId:id(2)},calls=[];let denied=false,alter=null,error=null,fail=null
 const request={expectedOrgId:context.orgId,expectedActorId:context.userId,publicationKey:id(190),requireAtomicPublication:true,id:null,communityId:null,name:'Kitchen cutoff',scheduleTaskKey:'frame',cutoffOffsetDays:-14,cutoffAnchor:'start',sortOrder:0,categoryIds:[id(40),id(41)],expectedGroup:null,expectedCategoryVersions:[{id:id(40),definitionHash:'a'.repeat(64)},{id:id(41),definitionHash:'b'.repeat(64)}]}
 const categories=request.expectedCategoryVersions.map(row=>({...row,definition:{id:row.id,community_id:null,parent_category_id:null,name:'Original category',description:null,image_url:null,sort_order:0,is_archived:false}}))
 const deps={env:{},'@/lib/services/context':{requireOrgContext:async()=>context},'@/lib/services/permissions':{requirePermission:async()=>{if(denied)throw new Error('Denied')}},'@/lib/supabase/server':{createServiceSupabaseClient:()=>({rpc:async(name,args)=>{
  calls.push({name,args});if(fail===name)throw new Error('Lost response')
  let data=name==='register_catalog_publication'?{orgId:context.orgId,actorId:context.userId,kind:'group',requestKey:args.p_key,intentId:id(180),status:'prepared'}:name==='review_catalog_group_categories'?{orgId:context.orgId,actorId:context.userId,communityId:args.p_community_id,categories}: {orgId:context.orgId,actorId:context.userId,receiptId:id(200),historySequence:'2',created:true,group:{id:args.p_request.id??id(210),community_id:args.p_request.communityId,name:args.p_request.name,schedule_task_key:args.p_request.scheduleTaskKey,cutoff_offset_days:args.p_request.cutoffOffsetDays,cutoff_anchor:args.p_request.cutoffAnchor,sort_order:args.p_request.sortOrder,is_archived:false,category_ids:args.p_request.categoryIds}}
  if(alter)alter(data,name);return {data,error:error?.name===name?error.value:null}
 }})}}
 const packageService=compile('lib/services/catalog-package-publication.ts',deps);deps['@/lib/services/catalog-package-publication']=packageService
 return {context,request,categories,calls,service:compile('lib/services/catalog-group-publication.ts',deps),deny:()=>denied=true,alter:v=>alter=v,error:(name,value)=>error={name,value},fail:v=>fail=v}
}
test('group publication durably registers and dispatches the same original versioned body without a fresh review or legacy writes',async()=>{
 const h=harness(),saved=await h.service.publishCatalogGroup(h.context,{...h.request,categoryIds:[id(41),id(40)]})
 assert.equal(saved.name,h.request.name);assert.deepEqual(h.calls.map(c=>c.name),['register_catalog_publication','publish_catalog_group_atomic']);assert.equal(h.calls[0].args.p_kind,'group')
 assert.equal(JSON.stringify(h.calls[0].args.p_request),JSON.stringify(h.calls[1].args.p_request));assert.equal(h.calls[1].args.p_key,h.request.publicationKey);assert.equal(JSON.stringify(h.calls[1].args.p_request.expectedCategoryVersions),JSON.stringify(h.request.expectedCategoryVersions));assert.deepEqual([...h.calls[1].args.p_request.categoryIds],h.request.categoryIds)
})
test('publication requires original identity, active source scope, unique references and reviewed versions before any RPC',async()=>{
 const h=harness()
 for(const patch of [{expectedActorId:id(99)},{expectedOrgId:id(99)},{publicationKey:null},{requireAtomicPublication:undefined},{categoryIds:[id(40),id(40)]},{expectedCategoryVersions:[]},{expectedCategoryVersions:[...h.request.expectedCategoryVersions].reverse()},{id:id(210)},{unknown:true}])await assert.rejects(h.service.publishCatalogGroup(h.context,{...h.request,...patch}))
 assert.equal(h.calls.length,0)
})
test('registration failures never dispatch a publication; lost responses and rejected committed replies preserve uncertainty',async()=>{
 for(const mode of ['lost','invalid','cancelled','rejected']){
  const h=harness();if(mode==='lost')h.fail('register_catalog_publication');if(mode==='invalid')h.alter((r,n)=>{if(n==='register_catalog_publication')r.actorId=id(99)});if(mode==='cancelled')h.alter((r,n)=>{if(n==='register_catalog_publication')r.status='cancelled'});if(mode==='rejected')h.error('register_catalog_publication',{code:'42501',message:'Permission revoked'})
  await assert.rejects(h.service.publishCatalogGroup(h.context,h.request));assert.equal(h.calls.length,1)
 }
 for(const mode of ['lost','rejected']){const h=harness();if(mode==='lost')h.fail('publish_catalog_group_atomic');else h.error('publish_catalog_group_atomic',{code:'P0001',message:'Definition changed'});await assert.rejects(h.service.publishCatalogGroup(h.context,h.request),e=>e.code==='CATALOG_PUBLICATION_UNCONFIRMED');assert.equal(h.calls.length,2)}
})
test('receipt identity, complete rule fields, history precision and membership must match the exact reviewed save',async()=>{
 for(const alter of [r=>r.orgId=id(99),r=>r.actorId=id(99),r=>r.receiptId=null,r=>r.historySequence='bad',r=>r.historySequence='9223372036854775808',r=>r.group.name='Different',r=>r.group.community_id=id(13),r=>r.group.schedule_task_key='other',r=>r.group.cutoff_offset_days=1,r=>r.group.cutoff_anchor='end',r=>r.group.sort_order=1,r=>r.group.is_archived=true,r=>r.group.category_ids=[id(40)],r=>r.group.cost_cents=999]){
  const h=harness();h.alter((r,n)=>{if(n==='publish_catalog_group_atomic')alter(r)});await assert.rejects(h.service.publishCatalogGroup(h.context,h.request),e=>e.code==='CATALOG_PUBLICATION_UNCONFIRMED')
 }
 const h=harness(),source={id:id(210),community_id:null,name:'Old rule',schedule_task_key:'frame',cutoff_offset_days:-1,cutoff_anchor:'start',sort_order:0,is_archived:false,category_ids:[id(40)]}
 h.alter((r,n)=>{if(n==='publish_catalog_group_atomic')r.group.id=id(211)});await assert.rejects(h.service.publishCatalogGroup(h.context,{...h.request,id:source.id,expectedGroup:source}),e=>e.code==='CATALOG_PUBLICATION_UNCONFIRMED')
})
test('authorized original review verifies selected/root coverage and rejects hidden fields, malformed ancestry and mismatched scopes',async()=>{
 const input=h=>({expectedOrgId:h.context.orgId,expectedActorId:h.context.userId,communityId:null,categoryIds:h.request.categoryIds})
 const h=harness(),snapshot=await h.service.reviewCatalogGroupCategories(input(h));assert.equal(snapshot.categories.length,2);assert.equal(h.calls[0].name,'review_catalog_group_categories');assert.equal(h.calls[0].args.p_actor_id,h.context.userId)
 for(const alter of [r=>r.orgId=id(99),r=>r.actorId=id(99),r=>r.communityId=id(13),r=>r.categories.pop(),r=>r.categories.reverse(),r=>r.categories[0].definition.id=id(99),r=>r.categories[0].definition.cost_cents=999,r=>r.categories[0].definition.is_archived=true,r=>r.categories[0].definition.parent_category_id=id(41),r=>r.categories[0].definitionHash='bad']){
  const h=harness();h.alter(alter);await assert.rejects(h.service.reviewCatalogGroupCategories(input(h)))
 }
 const gated=harness();await assert.rejects(gated.service.reviewCatalogGroupCategories({...input(gated),expectedActorId:id(99)}));gated.deny();await assert.rejects(gated.service.reviewCatalogGroupCategories(input(gated)),/Denied/);assert.equal(gated.calls.length,0)
})
