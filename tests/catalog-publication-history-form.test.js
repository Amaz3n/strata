require('../scripts/register-ts-node-test')
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test'),assert=require('node:assert/strict')
const group=require('../lib/selections/group-publication-recovery'),{groupRequest}=require('./fixtures/catalog-group-request')
const price=require('../lib/selections/price-publication-recovery'),pack=require('../lib/selections/package-publication-recovery'),id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function form(kind='prices'){
 const slots=[],requests=[],rows=new Map(),locks=[];let cursor=0,pending=false,setFailure=false
 const storage={getItem:key=>rows.get(key)??null,setItem:(key,value)=>{if(setFailure)throw new Error('Storage blocked');rows.set(key,value)},removeItem:key=>rows.delete(key)}
 const scope={expectedOrgId:id(1),expectedActorId:id(2),communityId:null},storageScope={orgId:scope.expectedOrgId,actorId:scope.expectedActorId,communityId:null}
 const attempt=kind==='group'?groupRequest():kind==='prices'?{publicationKey:id(80),expectedOrgId:id(1),expectedActorId:id(2),communityId:null,items:[{optionId:id(50),housePlanVersionId:id(31),priceCents:123,isAvailable:true,expectedPrice:null}]}:{requireAtomicPublication:true,publicationKey:id(90),expectedOrgId:id(1),expectedActorId:id(2),communityId:null,name:'Bundle',priceCents:100,optionIds:[id(50)]}
 const entry={id:id(100),requestKey:attempt.publicationKey,kind,type:kind,status:'committed',occurredAt:'2026-10-03T10:00:00Z',sequence:'50',itemCount:1},nextCursor={throughSequence:'50',beforeSequence:'26'}
 const props={scope,initialPendingPage:{orgId:id(1),actorId:id(2),entries:[],nextCursor:null},initialPage:{orgId:id(1),actorId:id(2),communityId:null,entries:[entry],nextCursor,pendingRequests:[]}},compiled={exports:{}}
 const hooks={useState(initial){const n=cursor++;slots[n]??={value:initial};return [slots[n].value,value=>slots[n].value=typeof value==='function'?value(slots[n].value):value]},useRef(value){const n=cursor++;slots[n]??={current:value};return slots[n]},useTransition(){return [pending,fn=>{pending=true;Promise.resolve(fn()).finally(()=>pending=false)}]}}
 const navigator={locks:{request:(name,fn)=>{locks.push(name);return fn()}}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/design-studio/catalog-publication-history.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports:compiled.exports,navigator,window:{localStorage:storage},require(name){
  if(name==='react')return hooks
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}
  if(name==='@/lib/selections/group-publication-recovery')return group
  if(name==='@/lib/selections/price-publication-recovery')return price
  if(name==='@/lib/selections/package-publication-recovery')return pack
  if(name==='@/lib/action-result')return {unwrapAction:r=>{if(!r.success)throw new Error(r.error);return r.data}}
  if(name.endsWith('/design-studio/actions'))return {listPendingCatalogPublicationsAction:input=>new Promise(resolve=>requests.push({type:'pending',input,resolve})),listCatalogPublicationHistoryAction:input=>new Promise(resolve=>requests.push({type:'list',input,resolve})),recoverCatalogPublicationRequestAction:input=>new Promise(resolve=>requests.push({type:'recover',input,resolve}))}
  return new Proxy({},{get:(_,key)=>key})
 }})
 function nodes(tree,predicate,result=[]){if(!tree||typeof tree!=='object')return result;if(predicate(tree))result.push(tree);for(const child of [tree.props?.children].flat(Infinity))nodes(child,predicate,result);return result}
 const render=()=>{cursor=0;return compiled.exports.CatalogPublicationHistory(props)},button=(tree,label)=>nodes(tree,n=>n.type==='Button'&&n.props.children===label)[0],recovery=tree=>nodes(tree,n=>n.type==='CatalogPublicationReconciliation')[0]
 return {props,entry,attempt,rows,requests,locks,storage,storageScope,render,button,recovery,navigator,failStorage:()=>setFailure=true,flush:async()=>{for(let n=0;n<10;n++)await Promise.resolve()}}
}
test('history pagination sends the exact cursor, coalesces clicks and keeps visible rows on read failure',async()=>{
 const f=form(),next=f.button(f.render(),'Next 25 outcomes');assert.equal(next.props.type,'button');next.props.onClick();next.props.onClick();assert.equal(f.requests.length,1)
 assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0].input)),{...f.props.scope,cursor:f.props.initialPage.nextCursor})
 f.requests[0].resolve({success:false,error:'Read unavailable'});await f.flush();assert.ok(f.button(f.render(),'Review outcome'));assert.equal(f.rows.size,0)
 f.button(f.render(),'Newest outcomes').props.onClick();assert.equal(f.requests[1].input.cursor,null)
 f.requests[1].resolve({success:true,data:{...f.props.initialPage,entries:[],nextCursor:null,pendingRequests:[]}});await f.flush();assert.equal(f.button(f.render(),'Review outcome'),undefined);assert.equal(f.button(f.render(),'Next 25 outcomes').props.disabled,true)
})
test('price outcome restoration persists the exact verified request under its browser lock before exposing reconciliation',async()=>{
 const f=form(),oldNext=f.button(f.render(),'Next 25 outcomes').props.onClick,review=f.button(f.render(),'Review outcome');assert.equal(review.props.type,'button');review.props.onClick();review.props.onClick();assert.equal(f.requests.length,1);assert.equal(f.rows.size,0)
 assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0].input)),{...f.props.scope,id:f.entry.id,type:f.entry.type});assert.deepEqual(f.locks,[price.pricePublicationLockName(f.storageScope)])
 f.requests[0].resolve({success:true,data:{kind:'prices',attempt:f.attempt}});await f.flush()
 assert.deepEqual(price.readPricePublication(f.storage,f.storageScope),price.persistPricePublication(f.storage,f.storageScope,f.attempt));assert.ok(f.recovery(f.render()));assert.equal(f.button(f.render(),'Next 25 outcomes').props.disabled,true)
 oldNext();assert.equal(f.requests.length,1,'stale navigation handler must not bypass restored recovery')
 assert.deepEqual(f.requests.map(r=>r.type),['recover'])
})
test('package outcome restoration refuses unavailable Web Locks or blocked storage without exposing unsafe recovery',async()=>{
 const f=form('package');f.navigator.locks=undefined;f.button(f.render(),'Review outcome').props.onClick();assert.equal(f.requests.length,0)
 f.navigator.locks={request:(name,fn)=>{f.locks.push(name);return fn()}};f.failStorage();f.button(f.render(),'Review outcome').props.onClick();f.requests[0].resolve({success:true,data:{kind:'package',attempt:f.attempt}});await f.flush()
 assert.deepEqual(f.locks,[pack.packagePublicationLockName(f.storageScope)]);assert.equal(f.rows.size,0);assert.equal(f.recovery(f.render()),undefined)
})
test('restoration never replaces another pending local publication and read denial preserves its evidence',async()=>{
 const f=form(),previous={...f.attempt,publicationKey:id(99)};price.persistPricePublication(f.storage,f.storageScope,previous)
 f.button(f.render(),'Review outcome').props.onClick();f.requests[0].resolve({success:false,error:'Margin permission required'});await f.flush();assert.equal(price.readPricePublication(f.storage,f.storageScope).publicationKey,id(99))
 f.button(f.render(),'Review outcome').props.onClick();f.requests[1].resolve({success:true,data:{kind:'prices',attempt:f.attempt}});await f.flush();assert.equal(price.readPricePublication(f.storage,f.storageScope).publicationKey,id(99));assert.equal(f.recovery(f.render()),undefined)
})
test('confirmed package resolution releases history controls; body recovery itself never publishes or acknowledges',async()=>{
 const f=form('package');f.button(f.render(),'Review outcome').props.onClick();f.requests[0].resolve({success:true,data:{kind:'package',attempt:f.attempt}});await f.flush();assert.ok(f.recovery(f.render()));assert.equal(f.rows.size,1)
 f.recovery(f.render()).props.onReconciled();assert.equal(f.recovery(f.render()),undefined);assert.equal(f.requests[1].type,'list');assert.equal(f.requests[1].input.cursor,null);f.requests[1].resolve({success:true,data:{...f.props.initialPage,pendingRequests:[]}});await f.flush();assert.equal(f.button(f.render(),'Newest outcomes').props.disabled,false);assert.deepEqual(f.requests.map(r=>r.type),['recover','list'])
})

test('the bounded awaiting queue restores registered intent through read-only recovery without publishing it',async()=>{
 const f=form();f.props.initialPage.pendingRequests=[{...f.entry,type:'intent',status:'registered',outcomeRecorded:false}]
 const button=f.button(f.render(),'Review registered request');assert.equal(button.props.type,'button');button.props.onClick()
 assert.equal(f.requests[0].type,'recover');assert.equal(f.requests[0].input.type,'intent');f.requests[0].resolve({success:true,data:{kind:'prices',attempt:f.attempt}});await f.flush()
 const recovery=f.recovery(f.render());assert.ok(recovery);assert.equal(recovery.props.allowRetry,true);assert.equal(f.rows.size,1);assert.deepEqual(f.requests.map(r=>r.type),['recover'])
})

test('confirmed resolution removes only its matching pending pointer even if refreshed history is unavailable',async()=>{
 const f=form(),pending={...f.entry,type:'intent',status:'registered',outcomeRecorded:false},other={...pending,id:id(101),requestKey:id(90),kind:'package'};f.props.initialPage.pendingRequests=[pending,other]
 f.button(f.render(),'Review registered request').props.onClick();f.requests[0].resolve({success:true,data:{kind:'prices',attempt:f.attempt}});await f.flush();f.recovery(f.render()).props.onReconciled()
 f.requests[1].resolve({success:false,error:'History unavailable'});await f.flush();const button=f.button(f.render(),'Review registered request');assert.ok(button);button.props.onClick();assert.equal(f.requests[2].input.id,other.id)
})

test('cross-scope pending recovery uses the original community lock and storage, blocks stale navigation and checks selected identity',async()=>{
 const f=form(),community=id(13),entry={id:id(150),requestKey:f.attempt.publicationKey,kind:'prices',communityId:community,communityName:'Original community',occurredAt:'2026-10-04T10:00:00.000000Z',itemCount:1}
 f.props.initialPendingPage.entries=[entry];const tree=f.render(),oldNext=f.button(tree,'Newest pending requests').props.onClick
 f.button(tree,'Review pending request').props.onClick();assert.equal(f.requests[0].input.communityId,community);assert.equal(f.requests[0].input.type,'intent');assert.equal(f.locks[0],price.pricePublicationLockName({...f.storageScope,communityId:community}))
 f.requests[0].resolve({success:true,data:{kind:'prices',attempt:{...f.attempt,communityId:community}}});await f.flush()
 assert.ok(price.readPricePublication(f.storage,{...f.storageScope,communityId:community}));assert.equal(price.readPricePublication(f.storage,f.storageScope),null);assert.ok(f.recovery(f.render()))
 oldNext();assert.equal(f.requests.length,1);assert.equal(f.button(f.render(),'Newest pending requests').props.disabled,true)
})
test('cross-scope queue pagination is explicit and retains visible evidence on read failure',async()=>{
 const f=form();f.props.initialPendingPage.nextCursor=id(155)
 const next=f.button(f.render(),'Next 25 pending requests');assert.equal(next.props.type,'button');next.props.onClick();next.props.onClick();assert.equal(f.requests.length,1);assert.equal(f.requests[0].type,'pending');assert.equal(f.requests[0].input.cursor,id(155));assert.ok(!Object.hasOwn(f.requests[0].input,'communityId'))
 f.requests[0].resolve({success:false,error:'Scope changed'});await f.flush();assert.equal(f.button(f.render(),'Next 25 pending requests').props.disabled,false)
 f.button(f.render(),'Newest pending requests').props.onClick();assert.equal(f.requests[1].input.cursor,null);f.requests[1].resolve({success:true,data:{...f.props.initialPendingPage,nextCursor:null}});await f.flush();assert.equal(f.button(f.render(),'Next 25 pending requests').props.disabled,true)
})
test('selected publication identity mismatch never persists or exposes a different request',async()=>{
 const f=form();f.button(f.render(),'Review outcome').props.onClick();f.requests[0].resolve({success:true,data:{kind:'prices',attempt:{...f.attempt,publicationKey:id(999)}}});await f.flush();assert.equal(f.rows.size,0);assert.equal(f.recovery(f.render()),undefined)
})

test('pending cross-scope recovery remains usable when the ambient history scope is unavailable',async()=>{
 const f=form(),community=id(13);f.props.initialPage=null;f.props.initialPendingPage.entries=[{id:id(150),requestKey:f.attempt.publicationKey,kind:'prices',communityId:community,communityName:'Assigned community',occurredAt:'2026-10-04T10:00:00.000000Z',itemCount:1}]
 f.button(f.render(),'Review pending request').props.onClick();f.requests[0].resolve({success:true,data:{kind:'prices',attempt:{...f.attempt,communityId:community}}});await f.flush();assert.ok(f.recovery(f.render()));f.recovery(f.render()).props.onReconciled();assert.equal(f.requests[1].type,'list');f.requests[1].resolve({success:false,error:'Scope still unavailable'});await f.flush();assert.equal(f.button(f.render(),'Review pending request'),undefined);assert.equal(f.button(f.render(),'Newest pending requests').props.disabled,false)
})

test('group history restores exact reviewed versions under its own lock before exposing shared reconciliation',async()=>{
 const f=form('group');f.button(f.render(),'Review outcome').props.onClick();assert.equal(f.requests[0].input.type,'group');assert.equal(f.locks[0],group.groupPublicationLockName(f.storageScope))
 f.requests[0].resolve({success:true,data:{kind:'group',attempt:f.attempt}});await f.flush();assert.ok(f.recovery(f.render()));assert.equal(JSON.stringify(group.readGroupPublication(f.storage,f.storageScope).expectedCategoryVersions),JSON.stringify(f.attempt.expectedCategoryVersions))
})
