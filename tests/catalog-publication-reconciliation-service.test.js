require('../scripts/register-ts-node-test')
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test'),assert=require('node:assert/strict')
const schemas=require('../lib/validation/selections'),id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const context={orgId:id(1),userId:id(2)}
function compile(file,dependencies){const compiled={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled.exports,process:{env:dependencies.env??{}},require:name=>dependencies[name]??(name==='zod'?require('zod'):name==='@/lib/validation/selections'?schemas:name==='@/lib/validation/catalog-publication-review'?require('../lib/validation/catalog-publication-review'):{})});return compiled.exports}
function harness(){
 const calls=[];let denied=false,alter=null,error=null
 const packageService=compile('lib/services/catalog-package-publication.ts',{})
 const priceService=compile('lib/services/catalog-price-publication.ts',{'@/lib/services/catalog-package-publication':packageService})
 const groupService=compile('lib/services/catalog-group-publication.ts',{'@/lib/services/catalog-package-publication':packageService})
 const service=compile('lib/services/catalog-publication-reconciliation.ts',{
  env:{},
  '@/lib/services/context':{requireOrgContext:async()=>context},
  '@/lib/services/permissions':{requirePermission:async()=>{if(denied)throw new Error('Denied')}},
  '@/lib/services/catalog-group-publication':groupService,'@/lib/services/catalog-package-publication':packageService,'@/lib/services/catalog-price-publication':priceService,
  '@/lib/supabase/server':{createServiceSupabaseClient:()=>({rpc:async(name,args)=>{
   calls.push({name,args});let result=name==='cancel_catalog_publication'?{orgId:args.p_org_id,kind:args.p_kind,requestKey:args.p_key,cancellationId:id(103),cancelledAt:'2026-10-03T10:00:00Z'}:name==='inspect_catalog_publication'?{orgId:args.p_org_id,kind:args.p_kind,requestKey:args.p_key,reviewLabels:null,canReadMargin:true,status:'committed',receiptId:id(100),committedAt:'2026-10-03T10:00:00Z',sourceState:'changed',entityIds:[id(101)]}:{orgId:args.p_org_id,kind:args.p_kind,requestKey:args.p_key,receiptId:args.p_receipt_id,ackKey:args.p_ack_key,reconciliationId:id(102)}
   if(alter)alter(result);return {data:result,error}
  }})},
 })
 const publication={kind:'prices',attempt:schemas.catalogPricePublicationSchema.parse({expectedOrgId:context.orgId,expectedActorId:context.userId,publicationKey:id(80),communityId:null,items:[{optionId:id(50),housePlanVersionId:id(31),priceCents:123,isAvailable:true,expectedPrice:null}]})}
 const acknowledgment={publication,receiptId:id(100),ackKey:id(100),reason:'Reviewed original committed receipt'}
 return {service,publication,acknowledgment,calls,deny:()=>denied=true,alter:fn=>alter=fn,error:value=>error=value}
}
test('receipt inspection and acknowledgment use exact publisher canonical inputs and never call publication writes',async()=>{
 const h=harness();const inspected=await h.service.inspectCatalogPublication(h.publication);assert.equal(inspected.sourceState,'changed')
 const ack=await h.service.acknowledgeCatalogPublication(h.acknowledgment);assert.equal(ack.reconciliationId,id(102))
 assert.deepEqual(h.calls.map(call=>call.name),['inspect_catalog_publication','acknowledge_catalog_publication'])
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].args.p_request)),JSON.parse(JSON.stringify(h.calls[1].args.p_request)))
 assert.equal(h.calls[0].args.p_actor_id,context.userId);assert.equal(h.calls[1].args.p_receipt_id,id(100));assert.equal(h.calls[1].args.p_ack_key,id(100))
 const packageInput=schemas.packageSchema.parse({requireAtomicPublication:true,publicationKey:id(90),expectedOrgId:context.orgId,expectedActorId:context.userId,name:'Bundle',priceCents:100,optionIds:[id(51),id(50)]})
 await h.service.inspectCatalogPublication({kind:'package',attempt:packageInput});assert.deepEqual([...h.calls[2].args.p_request.optionIds],[id(50),id(51)])
})
test('current context, permission and missing identity reject before any service RPC',async()=>{
 const h=harness();for(const patch of [{expectedOrgId:id(99)},{expectedActorId:id(99)},{expectedActorId:null},{publicationKey:null}])await assert.rejects(h.service.inspectCatalogPublication({...h.publication,attempt:{...h.publication.attempt,...patch}}))
 h.deny();await assert.rejects(h.service.acknowledgeCatalogPublication(h.acknowledgment),/Denied/);assert.equal(h.calls.length,0)
})
test('malformed, mismatched and incomplete inspection replies fail closed; only metadata is returned',async()=>{
 const h=harness();for(const alter of [r=>r.orgId=id(99),r=>r.kind='package',r=>r.requestKey=id(99),r=>r.receiptId=null,r=>r.entityIds=[],r=>r.entityIds=[id(101),id(101)],r=>r.sourceState=null,r=>r.committedAt='bad']){h.alter(alter);await assert.rejects(h.service.inspectCatalogPublication(h.publication),/verified|incomplete/)}
 h.alter(r=>{r.cost_cents=900;r.request={costCents:900}});const metadata=await h.service.inspectCatalogPublication(h.publication);assert.ok(!Object.hasOwn(metadata,'cost_cents'));assert.ok(!Object.hasOwn(metadata,'request'))
 h.alter(r=>Object.assign(r,{status:'not_found',receiptId:null,committedAt:null,sourceState:null,entityIds:[]}));assert.equal((await h.service.inspectCatalogPublication(h.publication)).status,'not_found')
})
test('acknowledgment errors and mismatched replies cannot confirm reconciliation',async()=>{
 const h=harness();for(const alter of [r=>r.orgId=id(99),r=>r.kind='package',r=>r.requestKey=id(99),r=>r.receiptId=id(99),r=>r.ackKey=id(99),r=>r.reconciliationId=null]){h.alter(alter);await assert.rejects(h.service.acknowledgeCatalogPublication(h.acknowledgment),/verified/)}
 h.alter(null);h.error({message:'Response unavailable'});await assert.rejects(h.service.acknowledgeCatalogPublication(h.acknowledgment),/Could not confirm/)
})

test('cancellation uses the original canonical input and validates fencing metadata without publication writes',async()=>{
 const h=harness(),input={publication:h.publication,reason:'Cancelled original uncommitted request'}
 const reply=await h.service.cancelCatalogPublication(input);assert.equal(reply.cancellationId,id(103))
 assert.equal(h.calls[0].name,'cancel_catalog_publication');assert.equal(h.calls[0].args.p_key,h.publication.attempt.publicationKey)
 for(const alter of [r=>r.orgId=id(99),r=>r.kind='package',r=>r.requestKey=id(99),r=>r.cancellationId=null,r=>r.cancelledAt='bad']){h.alter(alter);await assert.rejects(h.service.cancelCatalogPublication(input),/verified/)}
 h.alter(null);h.error({message:'Publication already committed'});await assert.rejects(h.service.cancelCatalogPublication(input),/Keep this request/)
 h.error(null);h.deny();const calls=h.calls.length;await assert.rejects(h.service.cancelCatalogPublication(input),/Denied/);assert.equal(h.calls.length,calls)
})
test('cancelled inspection requires cancellation identity and time and rejects mixed commit/cancellation metadata',async()=>{
 const h=harness(),cancelled={status:'cancelled',receiptId:null,committedAt:null,sourceState:null,entityIds:[],cancellationId:id(103),cancelledAt:'2026-10-03T10:00:00Z'}
 h.alter(r=>Object.assign(r,cancelled));assert.equal((await h.service.inspectCatalogPublication(h.publication)).status,'cancelled')
 for(const patch of [{cancellationId:null},{cancelledAt:null},{receiptId:id(100)},{sourceState:'changed'},{entityIds:[id(101)]}]){h.alter(r=>Object.assign(r,cancelled,patch));await assert.rejects(h.service.inspectCatalogPublication(h.publication),/incomplete/)}
 h.alter(r=>r.cancellationId=id(103));await assert.rejects(h.service.inspectCatalogPublication(h.publication),/incomplete/)
})

test('inspection validates captured name identity and refuses false margin confirmation for cost-bearing reviewed inputs',async()=>{
 const h=harness(),labels={kind:'prices',items:[{optionId:id(50),packageId:null,housePlanVersionId:id(31),subjectName:'Original upgrade',planName:'Alpha',versionLabel:'Release one'}]}
 h.alter(r=>r.reviewLabels=labels);assert.equal((await h.service.inspectCatalogPublication(h.publication)).reviewLabels.items[0].subjectName,'Original upgrade')
 for(const patch of [{optionId:id(99)},{housePlanVersionId:id(99)},{packageId:id(50)},{subjectName:'a'.repeat(201)}]){h.alter(r=>r.reviewLabels={kind:'prices',items:[{...labels.items[0],...patch}]});await assert.rejects(h.service.inspectCatalogPublication(h.publication),/verified|differ/)}
 h.alter(r=>r.reviewLabels={kind:'prices',items:[labels.items[0],labels.items[0]]});await assert.rejects(h.service.inspectCatalogPublication(h.publication),/differ/)
 h.alter(r=>{r.reviewLabels=labels;r.canReadMargin=false});assert.equal((await h.service.inspectCatalogPublication(h.publication)).canReadMargin,false)
 const costBearing={...h.publication,attempt:{...h.publication.attempt,items:[{...h.publication.attempt.items[0],costCents:123}]}};await assert.rejects(h.service.inspectCatalogPublication(costBearing),/Margin review/)
 h.alter(r=>{r.reviewLabels=labels;delete r.canReadMargin});await assert.rejects(h.service.inspectCatalogPublication(h.publication),/verified/)
})


test('group reconciliation preserves original hashes, verifies immutable public definitions and requires no margin privilege',async()=>{
 const h=harness(),{groupRequest}=require('./fixtures/catalog-group-request'),publication={kind:'group',attempt:groupRequest()}
 const categories=publication.attempt.expectedCategoryVersions.map(row=>({...row,definition:{id:row.id,community_id:null,parent_category_id:null,name:'Original name',description:null,image_url:null,sort_order:0,is_archived:false}}))
 h.alter(r=>{r.canReadMargin=false;r.reviewLabels={kind:'group',categories}})
 const result=await h.service.inspectCatalogPublication(publication);assert.equal(result.kind,'group');assert.equal(result.canReadMargin,false);assert.equal(JSON.stringify(h.calls[0].args.p_request.expectedCategoryVersions),JSON.stringify(publication.attempt.expectedCategoryVersions))
 for(const changed of [categories.slice(1),[...categories].reverse(),[{...categories[0],definitionHash:'0'.repeat(64)},categories[1]],[{...categories[0],definition:{...categories[0].definition,cost_cents:999}},categories[1]]]){h.alter(r=>r.reviewLabels={kind:'group',categories:changed});await assert.rejects(h.service.inspectCatalogPublication(publication),/verified|differ/)}
})
