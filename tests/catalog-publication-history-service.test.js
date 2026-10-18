require('../scripts/register-ts-node-test')
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test'),assert=require('node:assert/strict')
const schemas=require('../lib/validation/selections'),id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function compile(file,dependencies){const compiled={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,process:{env:dependencies.env??{}},require:name=>dependencies[name]??(name==='zod'?require('zod'):name==='@/lib/validation/selections'?schemas:{})});return compiled.exports}
function harness(){
 const context={orgId:id(1),userId:id(2)},scope={expectedOrgId:context.orgId,expectedActorId:context.userId,communityId:null},calls=[]
 let data,error=null,denied=false
 const pack=compile('lib/services/catalog-package-publication.ts',{}),price=compile('lib/services/catalog-price-publication.ts',{'@/lib/services/catalog-package-publication':pack})
 const groupService=compile('lib/services/catalog-group-publication.ts',{'@/lib/services/catalog-package-publication':pack})
 const service=compile('lib/services/catalog-publication-history.ts',{env:{},'@/lib/services/context':{requireOrgContext:async()=>context},'@/lib/services/permissions':{requirePermission:async()=>{if(denied)throw new Error('Denied')}},'@/lib/services/catalog-group-publication':groupService,'@/lib/services/catalog-package-publication':pack,'@/lib/services/catalog-price-publication':price,'@/lib/supabase/server':{createServiceSupabaseClient:()=>({rpc:async(name,args)=>{calls.push({name,args});return {data,error}}})}})
 const entry={id:id(100),requestKey:id(80),kind:'prices',type:'prices',status:'committed',occurredAt:'2026-10-03T10:00:00Z',sequence:'1',itemCount:1}
 const page={orgId:context.orgId,actorId:context.userId,communityId:null,entries:[entry],nextCursor:null,pendingRequests:[]}
 const request={communityId:null,items:[{optionId:id(50),packageId:null,housePlanVersionId:id(31),priceCents:123,isAvailable:true,expectedPrice:null}]}
 const recovered={orgId:context.orgId,actorId:context.userId,communityId:null,outcomeId:entry.id,requestKey:entry.requestKey,kind:'prices',type:'prices',status:'committed',request}
 data=page
 return {context,scope,service,entry,page,recovered,calls,data:v=>data=v,error:v=>error=v,deny:()=>denied=true,pack}
}
test('history reads are scoped and bounded; cursor and outcome metadata are validated without returning costs or requests',async()=>{
 const h=harness();h.data({...h.page,cost_cents:999,request:{costCents:999}});const page=await h.service.listCatalogPublicationHistory(h.scope)
 assert.equal(page.entries.length,1);assert.ok(!Object.hasOwn(page,'request'));assert.ok(!Object.hasOwn(page,'cost_cents'))
 assert.equal(h.calls[0].name,'list_catalog_publication_history');assert.equal(h.calls[0].args.p_actor_id,h.context.userId);assert.equal(h.calls[0].args.p_community_id,null)
 for(const patch of [{orgId:id(99)},{actorId:id(99)},{communityId:id(99)},{entries:[{...h.entry,status:'cancelled'}]},{entries:[{...h.entry,type:'package'}]},{entries:[h.entry,h.entry]},{entries:[{...h.entry,sequence:'0'}]},{entries:[{...h.entry,kind:'package',type:'package',itemCount:2}]}]){h.data({...h.page,...patch});await assert.rejects(h.service.listCatalogPublicationHistory(h.scope),/verified/)}
})
test('history cursor preserves exact integer precision and rejects unordered, out-of-window and mismatched continuations',async()=>{
 const h=harness(),top=9007199254741099n,entries=Array.from({length:25},(_,n)=>({...h.entry,id:id(100+n),sequence:String(top-BigInt(n))})),cursor={throughSequence:String(top),beforeSequence:entries.at(-1).sequence}
 h.data({...h.page,entries,nextCursor:cursor});assert.equal((await h.service.listCatalogPublicationHistory(h.scope)).nextCursor.beforeSequence,cursor.beforeSequence)
 for(const patch of [{entries:[...entries].reverse()},{nextCursor:{...cursor,beforeSequence:'1'}},{nextCursor:{...cursor,throughSequence:'1'}},{entries:entries.slice(1)}]){h.data({...h.page,entries,nextCursor:cursor,...patch});await assert.rejects(h.service.listCatalogPublicationHistory(h.scope),/verified/)}
 h.data({...h.page,entries:[{...h.entry,sequence:cursor.beforeSequence}]});await assert.rejects(h.service.listCatalogPublicationHistory({...h.scope,cursor}),/order/)
 h.data({...h.page,entries:[{...h.entry,sequence:'1'}]});assert.equal((await h.service.listCatalogPublicationHistory({...h.scope,cursor})).entries[0].sequence,'1')
 for(const bad of [{throughSequence:'1',beforeSequence:'2'},{throughSequence:'9223372036854775808',beforeSequence:'1'},{throughSequence:1,beforeSequence:'1'}])await assert.rejects(h.service.listCatalogPublicationHistory({...h.scope,cursor:bad}))
})
test('recovery reconstructs the original canonical price and package input including omitted cost and stable actor/key',async()=>{
 const h=harness();h.data(h.recovered);const result=await h.service.recoverCatalogPublicationRequest({...h.scope,id:h.entry.id,type:h.entry.type})
 assert.equal(result.kind,'prices');assert.equal(result.attempt.publicationKey,h.entry.requestKey);assert.equal(result.attempt.expectedActorId,h.context.userId);assert.equal(Object.hasOwn(result.attempt.items[0],'costCents'),false)
 const attempt=schemas.packageSchema.parse({publicationKey:id(90),expectedOrgId:h.context.orgId,expectedActorId:h.context.userId,requireAtomicPublication:true,name:'Bundle',priceCents:100,optionIds:[id(50)]}),body=h.pack.catalogPackageRequest(attempt)
 // PostgreSQL JSONB returns object keys in its own order.
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reorder(v)])):value
 h.data({...h.recovered,kind:'package',type:'cancellation',status:'cancelled',requestKey:id(90),request:reorder(body)})
 const packageRecovery=await h.service.recoverCatalogPublicationRequest({...h.scope,id:h.entry.id,type:'cancellation'});assert.equal(packageRecovery.kind,'package');assert.equal(packageRecovery.attempt.requireAtomicPublication,true);assert.equal(Object.hasOwn(packageRecovery.attempt,'costCents'),false)
 assert.deepEqual(h.calls.map(call=>call.name),['read_catalog_publication_request','read_catalog_publication_request'])
})
test('recovery rejects mismatched scope/identity, mixed outcomes, invalid or noncanonical request bodies and read errors',async()=>{
 const h=harness(),input={...h.scope,id:h.entry.id,type:h.entry.type}
 for(const patch of [{orgId:id(99)},{actorId:id(99)},{communityId:id(99)},{outcomeId:id(99)},{type:'package'},{status:'cancelled'},{request:{...h.recovered.request,communityId:id(13)}},{request:{...h.recovered.request,ignored:true}},{request:{...h.recovered.request,items:[]}}]){h.data({...h.recovered,...patch});await assert.rejects(h.service.recoverCatalogPublicationRequest(input))}
 h.data(h.recovered);h.error({message:'Margin permission required'});await assert.rejects(h.service.recoverCatalogPublicationRequest(input),/Margin permission/)
})
test('context and permission reject history and body recovery before any backend read',async()=>{
 const h=harness();await assert.rejects(h.service.listCatalogPublicationHistory({...h.scope,expectedActorId:id(99)}),/context/)
 h.deny();await assert.rejects(h.service.recoverCatalogPublicationRequest({...h.scope,id:h.entry.id,type:h.entry.type}),/Denied/);assert.equal(h.calls.length,0)
})

test('package recovery preserves original community UUID casing while verifying the same actual scope',async()=>{
 const h=harness(),community='abcdefab-1234-4000-8000-aaaaaaaaaaaa',attempt=schemas.packageSchema.parse({publicationKey:id(90),expectedOrgId:h.context.orgId,expectedActorId:h.context.userId,requireAtomicPublication:true,communityId:community.toUpperCase(),name:'Bundle',priceCents:100,optionIds:[id(50)]})
 h.data({...h.recovered,communityId:community,kind:'package',type:'package',requestKey:id(90),request:h.pack.catalogPackageRequest(attempt)})
 const recovered=await h.service.recoverCatalogPublicationRequest({...h.scope,communityId:community.toUpperCase(),id:h.entry.id,type:'package'});assert.equal(recovered.attempt.communityId,community.toUpperCase())
})

test('pending intent metadata is bounded to three distinct kinds and exact registered bodies recover through the same verified path',async()=>{
 const h=harness(),pending={...h.entry,type:'intent',status:'registered',outcomeRecorded:false}
 h.data({...h.page,entries:[pending],pendingRequests:[pending]});assert.equal((await h.service.listCatalogPublicationHistory(h.scope)).pendingRequests.length,1)
 for(const patch of [{pendingRequests:[pending,pending]},{pendingRequests:[{...pending,outcomeRecorded:true}]},{pendingRequests:[{...pending,type:'prices'}]},{entries:[{...pending,outcomeRecorded:undefined}]}]){h.data({...h.page,entries:[pending],pendingRequests:[pending],...patch});await assert.rejects(h.service.listCatalogPublicationHistory(h.scope),/verified/)}
 h.data({...h.recovered,type:'intent',status:'registered'});const restored=await h.service.recoverCatalogPublicationRequest({...h.scope,id:h.entry.id,type:'intent'});assert.equal(restored.attempt.publicationKey,h.entry.requestKey)
})

test('cross-scope pending metadata validates actor, bounded live pagination and exact order without leaking request data',async()=>{
 const h=harness(),entry={id:id(120),requestKey:id(80),kind:'prices',communityId:id(13),communityName:'Alpha community',occurredAt:'2026-10-04T10:00:00.000001Z',itemCount:1},page={orgId:h.context.orgId,actorId:h.context.userId,entries:[entry],nextCursor:null}
 h.data({...page,request:{costCents:999}});const result=await h.service.listPendingCatalogPublications({expectedOrgId:h.context.orgId,expectedActorId:h.context.userId});assert.equal(result.entries[0].communityId,id(13));assert.ok(!Object.hasOwn(result,'request'));assert.equal(h.calls[0].name,'list_pending_catalog_publications');assert.equal(h.calls[0].args.p_before,null)
 for(const patch of [{actorId:id(999)},{orgId:id(999)},{entries:[entry,entry]},{entries:[{...entry,kind:'package',itemCount:2}]},{entries:[{...entry,occurredAt:'2026-10-04T10:00:00Z'}]},{nextCursor:entry.id}]){h.data({...page,...patch});await assert.rejects(h.service.listPendingCatalogPublications({expectedOrgId:h.context.orgId,expectedActorId:h.context.userId}),/verified/)}
 const entries=Array.from({length:25},(_,n)=>({...entry,id:id(200-n),requestKey:id(300+n),communityId:id(100+n)}));h.data({...page,entries,nextCursor:entries.at(-1).id});assert.equal((await h.service.listPendingCatalogPublications({expectedOrgId:h.context.orgId,expectedActorId:h.context.userId})).entries.length,25)
 h.data({...page,entries:[...entries].reverse(),nextCursor:entries.at(-1).id});await assert.rejects(h.service.listPendingCatalogPublications({expectedOrgId:h.context.orgId,expectedActorId:h.context.userId}),/order/)
 h.data(page);await assert.rejects(h.service.listPendingCatalogPublications({expectedOrgId:h.context.orgId,expectedActorId:h.context.userId,cursor:entry.id}),/order/)
 h.deny();await assert.rejects(h.service.listPendingCatalogPublications({expectedOrgId:h.context.orgId,expectedActorId:h.context.userId}),/Denied/)
})

test('cross-scope queue rejects changed actor and organization before requesting private metadata',async()=>{
 const h=harness(),input={expectedOrgId:h.context.orgId,expectedActorId:h.context.userId}
 await assert.rejects(h.service.listPendingCatalogPublications({...input,expectedOrgId:id(999)}),/context/)
 await assert.rejects(h.service.listPendingCatalogPublications({...input,expectedActorId:id(999)}),/context/)
 assert.equal(h.calls.length,0)
})

test('archived package pages validate original scope, ordering, archived status and cost visibility',async()=>{
 const h=harness(),row={id:id(200),community_id:null,name:'Retired',description:null,image_url:null,price_cents:100,is_available:true,is_archived:true,sort_order:0,option_ids:[id(50)]},page={orgId:h.context.orgId,actorId:h.context.userId,communityId:null,packages:[row],canReadMargin:false,nextCursor:null}
 h.data(page);const result=await h.service.listArchivedCatalogPackages(h.scope);assert.equal(result.packages.length,1);assert.equal(h.calls[0].name,'list_archived_catalog_packages');assert.equal(h.calls[0].args.p_community_id,null)
 for(const patch of [{actorId:id(999)},{communityId:id(999)},{packages:[{...row,is_archived:false}]},{packages:[{...row,cost_cents:900}]},{packages:[row,row]},{nextCursor:row.id}]){h.data({...page,...patch});await assert.rejects(h.service.listArchivedCatalogPackages(h.scope),/verified/)}
 const rows=Array.from({length:25},(_,n)=>({...row,id:id(200-n)}));h.data({...page,packages:rows,nextCursor:rows.at(-1).id});assert.equal((await h.service.listArchivedCatalogPackages(h.scope)).packages.length,25)
 h.data({...page,packages:rows.reverse(),nextCursor:id(176)});await assert.rejects(h.service.listArchivedCatalogPackages(h.scope),/order/)
})


test('group history, all three pending kinds and exact original group source/versions recover through the canonical path',async()=>{
 const h=harness(),{groupRequest}=require('./fixtures/catalog-group-request'),attempt=groupRequest()
 const group=compile('lib/services/catalog-group-publication.ts',{'@/lib/services/catalog-package-publication':h.pack}),body=group.catalogGroupRequest(attempt)
 const entries=['prices','package','group'].map((kind,n)=>({...h.entry,id:id(100+n),requestKey:id(180+n),kind,type:'intent',status:'registered',sequence:String(3-n),outcomeRecorded:false}))
 h.data({...h.page,entries,pendingRequests:entries});assert.equal((await h.service.listCatalogPublicationHistory(h.scope)).pendingRequests.length,3)
 h.data({...h.recovered,kind:'group',type:'group',requestKey:attempt.publicationKey,request:body})
 const recovered=await h.service.recoverCatalogPublicationRequest({...h.scope,id:h.entry.id,type:'group'});assert.equal(recovered.kind,'group');assert.equal(JSON.stringify(recovered.attempt.expectedCategoryVersions),JSON.stringify(attempt.expectedCategoryVersions));assert.equal(recovered.attempt.requireAtomicPublication,true)
 h.data({...h.recovered,kind:'group',type:'group',requestKey:attempt.publicationKey,request:{...body,expectedCategoryVersions:[]}});await assert.rejects(h.service.recoverCatalogPublicationRequest({...h.scope,id:h.entry.id,type:'group'}))
 h.data({...h.page,entries:[{...h.entry,kind:'group',type:'group',itemCount:2}]});await assert.rejects(h.service.listCatalogPublicationHistory(h.scope),/verified/)
})
