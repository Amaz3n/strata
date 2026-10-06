require('../scripts/register-ts-node-test')
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test'),assert=require('node:assert/strict')
const group=require('../lib/selections/group-publication-recovery'),{groupRequest}=require('./fixtures/catalog-group-request')
const price=require('../lib/selections/price-publication-recovery'),pack=require('../lib/selections/package-publication-recovery'),id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function form(kind='prices'){
 const slots=[],requests=[],rows=new Map();let cursor=0,pending=false,completed=0,removeFailure=false
 const storage={getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>{if(removeFailure)throw new Error('Storage unavailable');rows.delete(key)}}
 const scope={orgId:id(1),actorId:id(2),communityId:null}
 const attempt=kind==='group'?groupRequest():kind==='prices'?{publicationKey:id(80),expectedOrgId:scope.orgId,expectedActorId:scope.actorId,communityId:null,items:[{optionId:id(50),housePlanVersionId:id(31),priceCents:123,isAvailable:true,expectedPrice:null}]}:{requireAtomicPublication:true,publicationKey:id(90),expectedOrgId:scope.orgId,expectedActorId:scope.actorId,communityId:null,name:'Bundle',priceCents:100,optionIds:[id(50)]}
 if(kind==='prices')price.persistPricePublication(storage,scope,attempt);else if(kind==='group')group.persistGroupPublication(storage,scope,attempt);else pack.persistPackagePublication(storage,scope,attempt)
 const props={publication:{kind,attempt},disabled:false,onReconciled:()=>completed++},compiled={exports:{}}
 const hooks={useState(initial){const n=cursor++;slots[n]??={value:initial};return [slots[n].value,value=>slots[n].value=value]},useRef(value){const n=cursor++;slots[n]??={current:value};return slots[n]},useTransition(){return [pending,fn=>{pending=true;Promise.resolve(fn()).finally(()=>pending=false)}]}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/design-studio/catalog-publication-reconciliation.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports:compiled.exports,navigator:{locks:{request:(_name,fn)=>fn()}},window:{localStorage:storage},require(name){
  if(name==='react')return hooks
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}
  if(name==='@/lib/selections/group-publication-recovery')return group
  if(name==='@/lib/selections/price-publication-recovery')return price
  if(name==='@/lib/selections/package-publication-recovery')return pack
  if(name==='@/lib/action-result')return {unwrapAction:result=>{if(!result.success)throw new Error(result.error);return result.data}}
  if(name.endsWith('/design-studio/actions'))return {upsertSelectionGroupAction:input=>new Promise(resolve=>requests.push({type:'publishGroup',input,resolve})),publishCatalogPricesAction:input=>new Promise(resolve=>requests.push({type:'publishPrices',input,resolve})),upsertPackageAction:input=>new Promise(resolve=>requests.push({type:'publishPackage',input,resolve})),inspectCatalogPublicationAction:input=>new Promise(resolve=>requests.push({type:'inspect',input,resolve})),cancelCatalogPublicationAction:input=>new Promise(resolve=>requests.push({type:'cancel',input,resolve})),acknowledgeCatalogPublicationAction:input=>new Promise(resolve=>requests.push({type:'ack',input,resolve}))}
  return new Proxy({},{get:(_,key)=>key})
 }})
 function nodes(tree,predicate,result=[]){if(!tree||typeof tree!=='object')return result;if(predicate(tree))result.push(tree);for(const child of [tree.props?.children].flat(Infinity))nodes(child,predicate,result);return result}
 const render=()=>{cursor=0;return compiled.exports.CatalogPublicationReconciliation(props)},button=(tree,label)=>nodes(tree,n=>n.type==='Button'&&n.props.children===label)[0]
 const metadata={orgId:scope.orgId,kind,requestKey:attempt.publicationKey,status:'committed',reviewLabels:null,canReadMargin:false,receiptId:id(100),committedAt:'2026-10-03T10:00:00Z',sourceState:'changed',entityIds:[id(101)]}
 return {props,rows,requests,render,button,metadata,completed:()=>completed,failRemoval:()=>removeFailure=true,repairRemoval:()=>removeFailure=false,flush:async()=>{for(let n=0;n<8;n++)await Promise.resolve()}}
}
test('not-found and failed receipt inspection keep recovery and expose no acknowledgment action',async()=>{
 const f=form(),tree=f.render();assert.equal(f.button(tree,'Check publication receipt').props.type,'button','receipt inspection inside package form must not submit publication');assert.equal(f.button(tree,'Acknowledge committed save'),undefined)
 f.button(tree,'Check publication receipt').props.onClick();f.requests[0].resolve({success:true,data:{...f.metadata,status:'not_found',receiptId:null,committedAt:null,sourceState:null,entityIds:[]}});await f.flush()
 assert.equal(f.button(f.render(),'Acknowledge committed save'),undefined);assert.equal(f.rows.size,1)
 f.button(f.render(),'Check publication receipt').props.onClick();f.requests[1].resolve({success:false,error:'Denied'});await f.flush();assert.equal(f.rows.size,1);assert.equal(f.completed(),0)
})
test('changed-source acknowledgment coalesces clicks and only clears recovery after confirmed audit reply',async()=>{
 const f=form();f.button(f.render(),'Check publication receipt').props.onClick();f.requests[0].resolve({success:true,data:f.metadata});await f.flush()
 assert.equal(f.button(f.render(),'Acknowledge committed save').props.type,'button','receipt acknowledgment must not submit the surrounding package form');const acknowledge=f.button(f.render(),'Acknowledge committed save').props.onClick;acknowledge();acknowledge();assert.equal(f.requests.length,2);assert.equal(f.rows.size,1)
 const request=JSON.parse(JSON.stringify(f.requests[1].input));assert.equal(request.ackKey,request.receiptId);assert.deepEqual(request.publication,f.props.publication)
 f.requests[1].resolve({success:false,error:'Response unknown'});await f.flush();assert.equal(f.rows.size,1);assert.equal(f.completed(),0)
 f.button(f.render(),'Acknowledge committed save').props.onClick();assert.deepEqual(JSON.parse(JSON.stringify(f.requests[2].input)),request)
 f.requests[2].resolve({success:true,data:{reconciliationId:id(200)}});await f.flush();assert.equal(f.rows.size,0);assert.equal(f.completed(),1)
 assert.deepEqual(f.requests.map(r=>r.type),['inspect','ack','ack'])
})
test('package acknowledgment preserves exact request when local clear fails and retries the same identity',async()=>{
 const f=form('package');f.button(f.render(),'Check publication receipt').props.onClick();f.requests[0].resolve({success:true,data:f.metadata});await f.flush();f.failRemoval()
 f.button(f.render(),'Acknowledge committed save').props.onClick();const frozen=JSON.parse(JSON.stringify(f.requests[1].input));f.requests[1].resolve({success:true,data:{reconciliationId:id(200)}});await f.flush();assert.equal(f.rows.size,1);assert.equal(f.completed(),0)
 f.repairRemoval();f.button(f.render(),'Acknowledge committed save').props.onClick();assert.deepEqual(JSON.parse(JSON.stringify(f.requests[2].input)),frozen);f.requests[2].resolve({success:true,data:{reconciliationId:id(200)}});await f.flush();assert.equal(f.rows.size,0);assert.equal(f.completed(),1)
})
test('disabled reconciliation refuses both inspection and acknowledgment even if callbacks are invoked',async()=>{
 const f=form();f.props.disabled=true;f.button(f.render(),'Check publication receipt').props.onClick();assert.equal(f.requests.length,0);assert.equal(f.rows.size,1)
})

test('uncommitted cancellation coalesces clicks and retains exact price recovery until the server confirms its fence',async()=>{
 const f=form();f.button(f.render(),'Check publication receipt').props.onClick();f.requests[0].resolve({success:true,data:{...f.metadata,status:'not_found',receiptId:null,committedAt:null,sourceState:null,entityIds:[]}});await f.flush()
 const button=f.button(f.render(),'Cancel uncommitted request');assert.equal(button.props.type,'button');button.props.onClick();button.props.onClick()
 assert.equal(f.requests.length,2);assert.equal(f.rows.size,1);const frozen=JSON.parse(JSON.stringify(f.requests[1].input));assert.deepEqual(frozen.publication,f.props.publication)
 f.requests[1].resolve({success:false,error:'Cancellation response unknown'});await f.flush();assert.equal(f.rows.size,1);assert.equal(f.completed(),0)
 f.button(f.render(),'Cancel uncommitted request').props.onClick();assert.deepEqual(JSON.parse(JSON.stringify(f.requests[2].input)),frozen)
 f.requests[2].resolve({success:true,data:{cancellationId:id(200)}});await f.flush();assert.equal(f.rows.size,0);assert.equal(f.completed(),1)
 assert.deepEqual(f.requests.map(r=>r.type),['inspect','cancel','cancel'])
})
test('cancelled package recovery survives local cleanup failure and retries the same server resolution',async()=>{
 const f=form('package');f.button(f.render(),'Check publication receipt').props.onClick();f.requests[0].resolve({success:true,data:{...f.metadata,status:'cancelled',receiptId:null,committedAt:null,sourceState:null,entityIds:[],cancellationId:id(200),cancelledAt:'2026-10-03T10:00:00Z'}});await f.flush()
 assert.equal(f.button(f.render(),'Acknowledge committed save'),undefined);assert.equal(f.button(f.render(),'Close cancelled recovery').props.type,'button')
 f.failRemoval();f.button(f.render(),'Close cancelled recovery').props.onClick();const frozen=JSON.parse(JSON.stringify(f.requests[1].input));f.requests[1].resolve({success:true,data:{cancellationId:id(200)}});await f.flush();assert.equal(f.rows.size,1);assert.equal(f.completed(),0)
 f.repairRemoval();f.button(f.render(),'Close cancelled recovery').props.onClick();assert.deepEqual(JSON.parse(JSON.stringify(f.requests[2].input)),frozen);f.requests[2].resolve({success:true,data:{cancellationId:id(200)}});await f.flush();assert.equal(f.rows.size,0);assert.equal(f.completed(),1)
})
test('publication race rejection retains recovery; a subsequent committed inspection offers acknowledgment',async()=>{
 const f=form();f.button(f.render(),'Check publication receipt').props.onClick();f.requests[0].resolve({success:true,data:{...f.metadata,status:'not_found',receiptId:null,committedAt:null,sourceState:null,entityIds:[]}});await f.flush()
 f.button(f.render(),'Cancel uncommitted request').props.onClick();f.requests[1].resolve({success:false,error:'Publication already committed; acknowledge its receipt instead'});await f.flush();assert.equal(f.rows.size,1)
 f.button(f.render(),'Check publication receipt').props.onClick();f.requests[2].resolve({success:true,data:f.metadata});await f.flush();assert.ok(f.button(f.render(),'Acknowledge committed save'));assert.equal(f.button(f.render(),'Cancel uncommitted request'),undefined)
})
test('confirmed cancellation cannot clear a different pending request stored by another tab',async()=>{
 const f=form();f.button(f.render(),'Check publication receipt').props.onClick();f.requests[0].resolve({success:true,data:{...f.metadata,status:'not_found',receiptId:null,committedAt:null,sourceState:null,entityIds:[]}});await f.flush()
 f.button(f.render(),'Cancel uncommitted request').props.onClick()
 const key=[...f.rows.keys()][0],replacement={...JSON.parse(f.rows.get(key)),publicationKey:id(99)};f.rows.set(key,JSON.stringify(replacement))
 f.requests[1].resolve({success:true,data:{cancellationId:id(200)}});await f.flush()
 assert.equal(f.rows.size,1);assert.equal(JSON.parse(f.rows.get(key)).publicationKey,id(99));assert.equal(f.completed(),0)
})
test('disabled cancellation refuses its callback even with a verified absent receipt',async()=>{
 const f=form();f.button(f.render(),'Check publication receipt').props.onClick();f.requests[0].resolve({success:true,data:{...f.metadata,status:'not_found',receiptId:null,committedAt:null,sourceState:null,entityIds:[]}});await f.flush()
 f.props.disabled=true;f.button(f.render(),'Cancel uncommitted request').props.onClick();assert.equal(f.requests.length,1);assert.equal(f.rows.size,1)
})

test('registered request retry requires explicit inspection and opt-in, retains unknown results and clears only confirmed publication',async()=>{
 const f=form();f.props.allowRetry=true;assert.equal(f.button(f.render(),'Retry original registered request'),undefined)
 f.button(f.render(),'Check publication receipt').props.onClick();f.requests[0].resolve({success:true,data:{...f.metadata,status:'not_found',receiptId:null,committedAt:null,sourceState:null,entityIds:[]}});await f.flush()
 const retry=f.button(f.render(),'Retry original registered request');assert.equal(retry.props.type,'button');retry.props.onClick();retry.props.onClick();assert.equal(f.requests.length,2);assert.equal(f.requests[1].type,'publishPrices');assert.equal(f.rows.size,1)
 f.requests[1].resolve({success:false,error:'Registered publication unconfirmed'});await f.flush();assert.equal(f.rows.size,1);assert.equal(f.completed(),0)
 f.button(f.render(),'Retry original registered request').props.onClick();assert.deepEqual(JSON.parse(JSON.stringify(f.requests[2].input)),JSON.parse(JSON.stringify(f.requests[1].input)))
 f.requests[2].resolve({success:true,data:{receiptId:id(200)}});await f.flush();assert.equal(f.rows.size,0);assert.equal(f.completed(),1)
})
test('package registered retry cannot overwrite another tab request or bypass disabled callback guards',async()=>{
 const f=form('package');f.props.allowRetry=true;f.button(f.render(),'Check publication receipt').props.onClick();f.requests[0].resolve({success:true,data:{...f.metadata,status:'not_found',receiptId:null,committedAt:null,sourceState:null,entityIds:[]}});await f.flush()
 f.props.disabled=true;f.button(f.render(),'Retry original registered request').props.onClick();assert.equal(f.requests.length,1)
 f.props.disabled=false;const key=[...f.rows.keys()][0],other={...JSON.parse(f.rows.get(key)),publicationKey:id(99)};f.rows.set(key,JSON.stringify(other))
 f.button(f.render(),'Retry original registered request').props.onClick();await f.flush();assert.equal(f.requests.length,1);assert.equal(JSON.parse(f.rows.get(key)).publicationKey,id(99));assert.equal(f.completed(),0)
})

test('new inspection hides cached margin review until current permissions are confirmed again',async()=>{
 const f=form();f.button(f.render(),'Check publication receipt').props.onClick();f.requests[0].resolve({success:true,data:{...f.metadata,canReadMargin:true}});await f.flush()
 const review=tree=>{function find(n){if(!n||typeof n!=='object')return;if(n.type==='CatalogPublicationReview')return n;for(const child of [n.props?.children].flat(Infinity)){const value=find(child);if(value)return value}}return find(tree)}
 assert.equal(review(f.render()).props.canReadMargin,true);f.button(f.render(),'Check publication receipt').props.onClick();assert.equal(review(f.render()).props.canReadMargin,false)
 f.requests[1].resolve({success:false,error:'Margin permission revoked'});await f.flush();assert.equal(review(f.render()).props.canReadMargin,false);assert.equal(f.rows.size,1)
})

test('group recovery retries the exact original request through the rule action and retains evidence until confirmed',async()=>{
 const f=form('group');f.props.allowRetry=true;f.button(f.render(),'Check publication receipt').props.onClick();f.requests[0].resolve({success:true,data:{...f.metadata,status:'not_found',receiptId:null,committedAt:null,sourceState:null,entityIds:[]}});await f.flush()
 f.button(f.render(),'Retry original registered request').props.onClick();assert.equal(f.requests[1].type,'publishGroup');assert.equal(JSON.stringify(f.requests[1].input.expectedCategoryVersions),JSON.stringify(f.props.publication.attempt.expectedCategoryVersions));f.requests[1].resolve({success:false,error:'Unconfirmed rule commit'});await f.flush();assert.equal(f.rows.size,1)
 f.button(f.render(),'Retry original registered request').props.onClick();assert.equal(JSON.stringify(f.requests[2].input),JSON.stringify(f.requests[1].input));f.requests[2].resolve({success:true,data:{id:id(210)}});await f.flush();assert.equal(f.rows.size,0);assert.equal(f.completed(),1)
})
