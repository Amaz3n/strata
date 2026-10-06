require('../scripts/register-ts-node-test')
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict'),test=require('node:test')
const {packageSchema}=require('../lib/validation/selections')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const context={orgId:id(1),userId:id(2)}
const input=()=>packageSchema.parse({publicationKey:id(3),name:'Package',priceCents:123,costCents:45,optionIds:[id(11),id(10)]})
function harness(){
 const calls=[],intentCalls=[],allCalls=[],compiled={exports:{}};let error=null,alter=null,reject=false,intentError=null,intentAlter=null,intentReject=false
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/services/catalog-package-publication.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,require(name){
  if(name==='server-only')return {}
  if(name==='zod')return require('zod')
  if(name==='@/lib/validation/selections')return require('../lib/validation/selections')
  if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>({rpc:(name,args)=>{const execute=async()=>{
   allCalls.push({name,args})
   if(name==='register_catalog_publication'){
    intentCalls.push({name,args});if(intentReject)throw new Error('Registration response lost')
    const result={orgId:context.orgId,actorId:context.userId,kind:args.p_kind,requestKey:args.p_key,intentId:id(6),status:'prepared'}
    if(intentAlter)intentAlter(result);return {data:result,error:intentError}
   }
   calls.push({name,args});if(reject)throw new Error("Network response lost");const r=args.p_request
   const result={orgId:context.orgId,receiptId:id(4),created:true,canReadMargin:true,package:{id:r.id??id(5),community_id:r.communityId,name:r.name,description:r.description,image_url:r.imageUrl,price_cents:r.priceCents,cost_cents:r.costCents??null,is_available:r.isAvailable,is_archived:false,sort_order:r.sortOrder,option_ids:r.optionIds}}
   if(alter)alter(result)
   return {data:result,error}
  };return {then:(...handlers)=>execute().then(...handlers)} }})}
  return {}
 }})
 return {request:compiled.exports.catalogPackageRequest,calls,intentCalls,allCalls,intentFail:e=>intentError=e,intentAlter:fn=>intentAlter=fn,intentReject:()=>intentReject=true,publish:request=>compiled.exports.publishCatalogPackage(context,request),fail:(value={message:'Connection lost'})=>{error=value},alter:fn=>{alter=fn},reject:()=>{reject=true}}
}
test('atomic publisher retains stable key, tenant, actor and canonical reviewed inputs across uncertain retry',async()=>{
 const h=harness(),request=input();const saved=await h.publish(request);await h.publish(request)
 assert.equal(h.calls.length,2)
 await assert.rejects(h.publish({...request,expectedPackage:saved}),/original package identity/)
 assert.equal(h.calls.length,2)
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])),JSON.parse(JSON.stringify(h.calls[1])))
 const args=h.calls[0].args;assert.equal(args.p_org_id,context.orgId);assert.equal(args.p_actor_id,context.userId);assert.equal(args.p_key,request.publicationKey)
 assert.deepEqual([...args.p_request.optionIds],[id(10),id(11)])
 h.fail();await assert.rejects(h.publish(request),/Retry the same save/);assert.equal(h.calls.length,3)
})
test('publisher rejects missing identity, unreviewed replacement and malformed/mismatched replies without alternate writes',async()=>{
 const h=harness(),request=input()
 await assert.rejects(h.publish({...request,publicationKey:null}),/stable/)
 await assert.rejects(h.publish({...request,id:id(5)}),/Review/);assert.equal(h.calls.length,0)
 for(const alter of [r=>r.orgId=id(99),r=>r.package.option_ids=[],r=>r.package.id='foreign',r=>r.package.community_id=id(99),r=>r.package.price_cents++,r=>r.package.option_ids=[id(99)],r=>r.receiptId=null]){
  h.alter(alter);await assert.rejects(h.publish(request),/reply/)
 }
 assert.equal(h.calls.length,7)
})
test('package input rejects duplicate options and values unsupported by the actual PostgreSQL integer fields',()=>{
 assert.throws(()=>packageSchema.parse({...input(),optionIds:[id(10),id(10)]}),/only once/)
 const option='abcdefab-1234-4000-8000-bbbbbbbbbbbb';assert.throws(()=>packageSchema.parse({...input(),optionIds:[option,option.toUpperCase()]}),/only once/)
 for(const key of ['priceCents','costCents'])assert.throws(()=>packageSchema.parse({...input(),[key]:2147483648}))
})

test('transport rejection and malformed success retain an explicit unconfirmed result code',async()=>{
 const h=harness();h.reject();await assert.rejects(h.publish(input()),error=>error.code==='CATALOG_PUBLICATION_UNCONFIRMED')
 const malformed=harness();malformed.alter(r=>r.receiptId=null);await assert.rejects(malformed.publish(input()),error=>error.code==='CATALOG_PUBLICATION_UNCONFIRMED')
})
test('actual upsert service gates atomic publication by current permission, workspace identity and literal flag',async()=>{
 const h=harness(),permissions=[],compiled={exports:{}};let denied=false,flag='true',legacy=0
 const current={...context,supabase:{from(){legacy++;throw new Error('Legacy path reached')}}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/services/option-catalog.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,process:{env:{get ARC_CATALOG_ATOMIC_PUBLICATION_ENABLED(){return flag}}},require(name){
  if(name==='@/lib/validation/selections')return require('../lib/validation/selections')
  if(name==='zod')return require('zod')
  if(name==='@/lib/services/context')return {requireOrgContext:async()=>current}
  if(name==='@/lib/services/permissions')return {hasPermission:async()=>true,requirePermission:async permission=>{permissions.push(permission);if(denied)throw new Error('Denied')}}
  if(name==='@/lib/services/catalog-package-publication')return {publishCatalogPackage:async(ctx,input)=>{assert.equal(ctx,current);return h.publish(input)}}
  return {}
 }})
 await assert.rejects(compiled.exports.upsertPackage({...input(),expectedOrgId:id(99)}),/organization/)
 await assert.rejects(compiled.exports.upsertPackage({...input(),expectedActorId:id(99)}),/actor/)
 assert.equal(h.calls.length,0)
 denied=true;await assert.rejects(compiled.exports.upsertPackage(input()),/Denied/);assert.equal(h.calls.length,0)
 denied=false;await compiled.exports.upsertPackage(input());assert.equal(h.calls.length,1);assert.equal(legacy,0);assert.equal(permissions.at(-1),'selections.catalog.manage')
 for(const value of ['TRUE','1',undefined]){flag=value;await assert.rejects(compiled.exports.upsertPackage(input()),/Legacy path/)}
 assert.equal(legacy,3);assert.equal(h.calls.length,1)
 for(const value of ['false','TRUE','1',undefined]){flag=value;await assert.rejects(compiled.exports.upsertPackage({...input(),requireAtomicPublication:true}),/unavailable/)}
 assert.equal(legacy,3,'recovered atomic requests must never fall through to legacy creation');assert.equal(h.calls.length,1)
})

test('publisher preserves omitted costs and defensively strips costs from unprivileged replies',async()=>{
 const h=harness(),request={...input(),costCents:undefined};h.alter(result=>{result.package.cost_cents=5000})
 assert.equal((await h.publish(request)).cost_cents,5000);assert.equal(Object.hasOwn(h.calls[0].args.p_request,'costCents'),false)
 h.alter(result=>{result.canReadMargin=false;result.package.cost_cents=5000})
 const hidden=await h.publish(request);assert.equal(Object.hasOwn(hidden,'cost_cents'),false)
 await assert.rejects(h.publish(input()),error=>error.code==='CATALOG_PUBLICATION_UNCONFIRMED')
 h.alter(result=>{delete result.canReadMargin});await assert.rejects(h.publish(request),/reply/)
})

test('package registration is confirmed before publication and uncertain/malformed registration never dispatches a catalog write',async()=>{
 const h=harness(),request=input();await h.publish(request)
 assert.deepEqual(h.allCalls.map(c=>c.name),['register_catalog_publication','publish_catalog_package_atomic'])
 assert.equal(h.intentCalls[0].args.p_kind,'package');assert.deepEqual(JSON.parse(JSON.stringify(h.intentCalls[0].args.p_request)),JSON.parse(JSON.stringify(h.calls[0].args.p_request)))
 for(const alter of [r=>r.orgId=id(99),r=>r.actorId=id(99),r=>r.kind='prices',r=>r.requestKey=id(99),r=>r.intentId=null,r=>r.status='unknown']){const broken=harness();broken.intentAlter(alter);await assert.rejects(broken.publish(request),e=>e.code==='CATALOG_PUBLICATION_UNCONFIRMED');assert.equal(broken.calls.length,0)}
 const lost=harness();lost.intentReject();await assert.rejects(lost.publish(request),e=>e.code==='CATALOG_PUBLICATION_UNCONFIRMED');assert.equal(lost.calls.length,0)
 const cancelled=harness();cancelled.intentAlter(r=>r.status='cancelled');await assert.rejects(cancelled.publish(request),/cancelled/);assert.equal(cancelled.calls.length,0)
})
test('a definitive package publication rejection retains registered recovery rather than abandoning a durable unresolved intent',async()=>{
 const h=harness();h.intentFail({code:'P0001',message:'Resolve the previous registered request'});await assert.rejects(h.publish(input()),/registration was rejected/);assert.equal(h.calls.length,0)
 const rejected=harness();rejected.alter(()=>{});rejected.fail({code:'P0001',message:'Reviewed package changed'});await assert.rejects(rejected.publish(input()),e=>e.code==='CATALOG_PUBLICATION_UNCONFIRMED'&&/remains registered/.test(e.message));assert.equal(rejected.intentCalls.length,1)
})

test('verified package replies compare UUIDs by actual identity while durable request spelling stays exact',async()=>{
 const h=harness(),community='abcdefab-1234-4000-8000-aaaaaaaaaaaa',option='abcdefab-1234-4000-8000-bbbbbbbbbbbb',request=packageSchema.parse({...input(),communityId:community.toUpperCase(),optionIds:[option.toUpperCase(),id(10)]})
 h.alter(r=>{r.package.community_id=community;r.package.option_ids=r.package.option_ids.map(id=>id.toLowerCase()).sort()})
 const saved=await h.publish(request);assert.equal(saved.community_id,community);assert.equal(h.intentCalls[0].args.p_request.communityId,community.toUpperCase());assert.ok(h.intentCalls[0].args.p_request.optionIds.includes(option.toUpperCase()))
 assert.deepEqual(JSON.parse(JSON.stringify(h.intentCalls[0].args.p_request)),JSON.parse(JSON.stringify(h.calls[0].args.p_request)))
})

test('lifecycle request adds only explicit archived state while preserving legacy body shape and rejects mixed edits before registration',()=>{
 const h=harness(),plain=input()
 const source={id:id(5),community_id:null,name:'Package',description:null,image_url:null,price_cents:123,cost_cents:45,is_available:true,is_archived:false,sort_order:0,option_ids:[id(10),id(11)]}
 const original=h.request(plain);assert.equal(Object.hasOwn(original,'isArchived'),false)
 const archive={...plain,id:id(5),expectedPackage:source,costCents:undefined,isArchived:true};assert.equal(h.request(archive).isArchived,true)
 for(const patch of [{costCents:45},{name:'Different'},{optionIds:[id(10)]},{priceCents:124},{isAvailable:false},{communityId:id(99)},{id:null}])assert.throws(()=>h.request({...archive,...patch}),/preserve|identity/)
})

test('archived repair requires an original archived baseline and cannot also restore or change scope',()=>{
 const h=harness(),plain=input(),source={id:id(5),community_id:null,name:'Package',description:null,image_url:null,price_cents:123,cost_cents:45,is_available:true,is_archived:true,sort_order:0,option_ids:[id(10),id(11)]},repair={...plain,id:id(5),expectedPackage:source,editArchived:true,name:'Repaired'}
 assert.equal(h.request(repair).editArchived,true);assert.equal(Object.hasOwn(h.request(repair),'isArchived'),false)
 for(const patch of [{expectedPackage:{...source,is_archived:false}},{isArchived:false},{communityId:id(99)},{id:null}])assert.throws(()=>h.request({...repair,...patch}),/archived|identity/)
 assert.throws(()=>packageSchema.parse({...repair,editArchived:false}))
})
