require('../scripts/register-ts-node-test')
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test'),assert=require('node:assert/strict')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,ORG=id(1),ACTOR=id(2),COMMUNITY=id(3)
const {catalogPricePublicationSchema}=require('../lib/validation/selections')
const compile=(file,globals)=>{const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,...globals});return exports}
function publisher(){
 let error=null,reject=false,alter=null,intentError=null,intentAlter=null;const calls=[],intentCalls=[],allCalls=[];let packageService
 const dependencies={require(name){
  if(name==='zod')return require('zod')
  if(name==='@/lib/validation/selections')return require('../lib/validation/selections')
  if(name==='@/lib/services/catalog-package-publication')return packageService
  if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>({rpc:async(name,args)=>{
   allCalls.push({name,args})
   if(name==='register_catalog_publication'){intentCalls.push({name,args});const result={orgId:ORG,actorId:ACTOR,kind:args.p_kind,requestKey:args.p_key,intentId:id(89),status:'prepared'};if(intentAlter)intentAlter(result);return {data:result,error:intentError}}
   calls.push({name,args});if(reject)throw new Error('Transport lost');const response={orgId:ORG,receiptId:id(90),created:true,prices:args.p_request.items.map((item,n)=>({id:id(91+n),option_id:item.optionId,package_id:item.packageId,house_plan_version_id:item.housePlanVersionId,community_id:args.p_request.communityId,price_cents:item.priceCents,is_available:item.isAvailable,...(item.costCents!==undefined?{cost_cents:item.costCents}:{})}))};if(alter)alter(response);return {data:response,error}
  }})}
  return {}
 }}
 packageService=compile('lib/services/catalog-package-publication.ts',dependencies)
 const compiled=compile('lib/services/catalog-price-publication.ts',dependencies)
 return {calls,intentCalls,allCalls,intentFail:e=>intentError=e,intentAlter:fn=>intentAlter=fn,publish:input=>compiled.publishCatalogPriceBatch({orgId:ORG,userId:ACTOR},input),fail:(value={message:'Offline'})=>error=value,reject:()=>reject=true,alter:fn=>alter=fn}
}
function request(){return catalogPricePublicationSchema.parse({publicationKey:id(80),communityId:COMMUNITY,items:[{optionId:id(11),housePlanVersionId:id(20),priceCents:123,expectedPrice:null},{optionId:id(10),housePlanVersionId:id(20),priceCents:456,expectedPrice:null}]})}
test('publisher canonicalizes and retains complete reviewed batch, preserves omitted costs and never falls back on uncertainty',async()=>{
 const h=publisher(),input=request();assert.equal((await h.publish(input)).count,2);await h.publish({...input,items:[...input.items].reverse()})
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])),JSON.parse(JSON.stringify(h.calls[1])))
 assert.equal(h.calls[0].args.p_org_id,ORG);assert.equal(h.calls[0].args.p_actor_id,ACTOR);assert.equal(h.calls[0].args.p_key,input.publicationKey)
 assert.ok(h.calls[0].args.p_request.items.every(item=>!Object.hasOwn(item,'costCents')))
 h.fail();await assert.rejects(h.publish(input),error=>error.code==='CATALOG_PUBLICATION_UNCONFIRMED');assert.equal(h.calls.length,3)
 const network=publisher();network.reject();await assert.rejects(network.publish(input),error=>error.code==='CATALOG_PUBLICATION_UNCONFIRMED')
})
test('publisher refuses missing, duplicate, foreign and mismatched receipt cells',async()=>{
 for(const alter of [r=>r.orgId=id(99),r=>r.prices.pop(),r=>r.prices[1]=r.prices[0],r=>r.prices[0].price_cents++,r=>r.prices[0].community_id=null,r=>r.prices[0].option_id=id(99)]){
  const h=publisher();h.alter(alter);await assert.rejects(h.publish(request()),error=>error.code==='CATALOG_PUBLICATION_UNCONFIRMED');assert.equal(h.calls.length,1)
 }
})
test('publication validation requires exactly one subject, a review baseline, unique cells and supported integer cents',()=>{
 const r=request();for(const change of [items=>delete items[0].expectedPrice,items=>items[0].priceCents=2147483648,items=>items[0].packageId=id(99),items=>items.push(items[0])]){
  const input=structuredClone(r);change(input.items);assert.throws(()=>catalogPricePublicationSchema.parse(input))
 }
})
function service({canMargin=false,rowCap=7,fail=null}={}){
 const reads=[],rpcCalls=[],delegations=[]
 const plans=Array.from({length:60},(_,n)=>({id:id(1000+n),org_id:ORG,name:`Plan ${String(n).padStart(3,'0')}`,status:'active'}))
 const versions=plans.flatMap((plan,n)=>[1,2,3].map(v=>({id:id(2000+n*3+v),org_id:ORG,house_plan_id:plan.id,status:'released',version_number:v,label:null,plan})))
 const options=Array.from({length:205},(_,n)=>id(5000+n))
 const prices=options.map((option_id,n)=>({id:id(6000+n),org_id:ORG,option_id,house_plan_version_id:versions[2].id,community_id:null,price_cents:1000+n,cost_cents:777,is_available:true}))
 const tables={house_plan_versions:versions,selection_catalog_prices:prices,communities:[{id:COMMUNITY,org_id:ORG,division_id:id(4)}]}
 let rpcError=null,alter=null,denied=false
 const supabase={from(table){let rows=tables[table]??[],limit=500,after=null,select;const filters=[];const q={
  select(value){select=value;return q},eq(key,value){filters.push([key,value]);rows=rows.filter(row=>key.includes('.')?row[key.split('.')[0]]?.[key.split('.')[1]]===value:row[key]===value);return q},in(key,values){rows=rows.filter(row=>values.includes(row[key]));return q},is(key,value){rows=rows.filter(row=>row[key]===value);return q},or(){rows=rows.filter(row=>row.community_id===null||row.community_id===COMMUNITY);return q},order(){rows=[...rows].sort((a,b)=>a.id.localeCompare(b.id));return q},limit(value){limit=value;return q},gt(key,value){after=value;rows=rows.filter(row=>row[key]>value);return q},maybeSingle:async()=>({data:rows[0],error:null}),then(resolve,reject){reads.push({table,select,filters,after});return Promise.resolve({data:rows.slice(0,Math.min(limit,rowCap)),error:fail===table&&after?{message:'Late read failure'}:null}).then(resolve,reject)}};return q}}
 const context={orgId:ORG,userId:ACTOR,supabase}
 const compiled=compile('lib/services/option-catalog.ts',{process:{env:{}},require(name){
  if(name==='zod')return require('zod')
  if(name==='@/lib/validation/selections')return require('../lib/validation/selections')
  if(name==='@/lib/services/context')return {requireOrgContext:async()=>context}
  if(name==='@/lib/services/permissions')return {requirePermission:async()=>{if(denied)throw new Error('Denied')},hasPermission:async()=>canMargin}
  if(name==='@/lib/services/authorization')return {getDivisionAccessForUser:async()=>({assignedOnly:false,divisionIds:[]})}
  if(name==='@/lib/land/paging')return require('../lib/land/paging')
  if(name==='@/lib/services/catalog-price-publication')return {publishCatalogPriceBatch:async(ctx,input)=>{delegations.push({ctx,input});return {count:input.items.length}}}
  if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>({rpc:async(name,args)=>{rpcCalls.push({name,args});const reply={orgId:ORG,plans:[{versionId:id(20),planId:id(21),planName:'Plan',versionLabel:'v1'}],cells:{},planPage:args.p_page,hasMorePlans:false,canReadMargin:canMargin};for(const option of args.p_option_ids)reply.cells[`${option}:${id(20)}`]={priceCents:123,isAvailable:true,isOverride:true,ownPrice:{id:id(90),price_cents:123,is_available:true},costCents:999};if(alter)alter(reply);return {data:reply,error:rpcError}}})}
  return {}
 }})
 return {module:compiled,options,prices,reads,rpcCalls,delegations,rpcFail:()=>rpcError={message:'Read RPC unavailable'},alter:fn=>alter=fn,deny:()=>denied=true}
}
test('indexed matrix requests only its visible window and refuses fallback or out-of-window replies',async()=>{
 const h=service(),result=await h.module.listPlanPricingMatrix({optionIds:h.options,optionPage:11,planPage:3})
 assert.equal(result.optionIds.length,5);assert.equal(h.rpcCalls[0].args.p_option_ids.length,5);assert.equal(h.rpcCalls[0].args.p_page,3);assert.equal(h.reads.length,0)
 assert.ok(Object.values(result.cells).every(cell=>!Object.hasOwn(cell,'costCents')))
 h.rpcFail();await assert.rejects(h.module.listPlanPricingMatrix({optionIds:h.options}),/Read RPC unavailable/);assert.equal(h.reads.length,0)
 const bad=service();bad.alter(reply=>reply.cells[`${id(99)}:${id(20)}`]={priceCents:1,isAvailable:true,isOverride:true,ownPrice:null})
 await assert.rejects(bad.module.listPlanPricingMatrix({optionIds:bad.options}),/outside|inconsistent/)
})
test('price service verifies current context and permission and batches complete inputs',async()=>{
 const h=service(),input={...request(),expectedOrgId:ORG,expectedActorId:ACTOR}
 await h.module.publishCatalogPrices(input);assert.equal(h.delegations.length,1);assert.equal(h.delegations[0].input.items.length,2)
 await assert.rejects(h.module.publishCatalogPrices({...input,expectedOrgId:id(99)}),/organization/);assert.equal(h.delegations.length,1)
 h.deny();await assert.rejects(h.module.publishCatalogPrices(input),/Denied/)
})

test('actual price publisher confirms durable registration of the same canonical body before dispatch; failed registration blocks all price writes',async()=>{
 const h=publisher(),input=request();await h.publish(input);assert.deepEqual(h.allCalls.map(c=>c.name),['register_catalog_publication','publish_catalog_prices_atomic']);assert.deepEqual(JSON.parse(JSON.stringify(h.intentCalls[0].args.p_request)),JSON.parse(JSON.stringify(h.calls[0].args.p_request)))
 const lost=publisher();lost.intentFail({message:'Response unavailable'});await assert.rejects(lost.publish(input),e=>e.code==='CATALOG_PUBLICATION_UNCONFIRMED');assert.equal(lost.calls.length,0)
 const rejected=publisher();rejected.fail({code:'P0001',message:'Reviewed price changed'});await assert.rejects(rejected.publish(input),e=>e.code==='CATALOG_PUBLICATION_UNCONFIRMED'&&/remains registered/.test(e.message))
})
