const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test'),assert=require('node:assert/strict')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
require('../scripts/register-ts-node-test')
function form(storage=new Map(),locks={request:(_key,fn)=>fn()}){
 const slots=[],requests=[],paths=[],refreshes=[],effects=[];let cursor=0,pending=false
 const hooks={useEffect(fn){const n=cursor++;if(!slots[n]){slots[n]={};effects.push(fn)}},useState(initial){const n=cursor++;slots[n]??={value:initial};return [slots[n].value,value=>slots[n].value=typeof value==='function'?value(slots[n].value):value]},useRef(value){const n=cursor++;slots[n]??={current:value};return slots[n]},useMemo(fn){cursor++;return fn()},useTransition(){return [pending,fn=>{pending=true;Promise.resolve(fn()).finally(()=>pending=false)}]}}
 const options=[10,11].map(n=>({id:id(n),name:`Option ${n}`,price_cents:1000,category_id:id(3),is_default:false}))
 const props={orgId:id(1),actorId:id(2),initialView:'pricing',initialCategoryId:id(3),canManage:true,catalog:{categories:[{id:id(3),name:'Kitchen',options}],packages:[],can_read_margin:false},matrix:{plans:[{planId:id(19),versionId:id(20),planName:'Plan',versionLabel:'v1'}],cells:Object.fromEntries(options.map((option,n)=>[`${option.id}:${id(20)}`,{priceCents:123+n,isAvailable:n===0,ownPrice:{id:id(30+n),price_cents:123+n,is_available:n===0},isOverride:true}])),optionIds:options.map(option=>option.id),optionPage:1,planPage:1,hasMoreOptions:true,hasMorePlans:true,atomicPricing:true}}
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/design-studio/catalog-workbench.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,URLSearchParams,navigator:{locks},window:{localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}},crypto:{randomUUID:()=>id(90)},require(name){
  if(name==='react')return hooks
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}
  if(name==='next/navigation')return {useRouter:()=>({refresh:()=>refreshes.push(true),replace:path=>paths.push(path)}),usePathname:()=>'/design-studio/catalog',useSearchParams:()=>new URLSearchParams('view=pricing')}
  if(name==='sonner')return {toast:{success(){},error(){}}}
  if(name==='@/lib/action-result')return {unwrapAction:result=>{if(!result.success)throw new Error(result.error);return result.data}}
  if(name==='@/lib/selections/price-publication-recovery')return require('../lib/selections/price-publication-recovery')
  if(name==='@/lib/selections/swatch')return {swatchHue:()=>''}
  if(name.endsWith('/design-studio/actions'))return {publishCatalogPricesAction:input=>new Promise((resolve,reject)=>requests.push({input,resolve,reject})),setCatalogPriceAction:async()=>({success:true,data:{}})}
  return new Proxy({},{get:(_,key)=>key})
 }})
 function nodes(tree,predicate,result=[]){if(!tree||typeof tree!=='object')return result;if(predicate(tree))result.push(tree);for(const child of [tree.props?.children].flat(Infinity))nodes(child,predicate,result);return result}
 const render=()=>{cursor=0;const tree=exports.CatalogWorkbench(props);for(const effect of effects.splice(0))effect();return tree}
 const button=(tree,label)=>nodes(tree,n=>n.type==='Button'&&n.props.children===label)[0]
 const inputs=tree=>nodes(tree,n=>n.type==='Input'&&n.props['aria-label']?.includes('price on'))
 return {storage,props,requests,paths,refreshes,render,button,inputs,flush:async()=>{for(let n=0;n<8;n++)await Promise.resolve()}}
}
test('actual price editor publishes rapid edits together, fences stale navigation and coalesces duplicate clicks',async()=>{
 const f=form(),tree=f.render(),publish=f.button(tree,'Publish prices').props.onClick,next=f.button(tree,'Next options').props.onClick
 assert.equal(f.inputs(tree)[0].props.value,'1.23')
 f.inputs(tree)[0].props.onBlur({target:{value:'2.45'}});f.inputs(tree)[1].props.onBlur({target:{value:'3.67'}})
 next();assert.equal(f.paths.length,0,'pre-render navigation handler must see new drafts')
 publish();publish();assert.equal(f.requests.length,1)
 const items=f.requests[0].input.items;assert.equal(items.length,2);assert.equal(items[0].priceCents,245);assert.equal(items[1].priceCents,367);assert.equal(items[1].isAvailable,false)
 assert.equal(f.requests[0].input.expectedOrgId,f.props.orgId);assert.equal(f.requests[0].input.expectedActorId,f.props.actorId)
 f.requests[0].resolve({success:true,data:{count:2}});await f.flush();assert.equal(f.refreshes.length,1)
})
test('unconfirmed publication preserves exact batch and blocks stale discard/edit callbacks after refresh',async()=>{
 const f=form(),tree=f.render(),oldInput=f.inputs(tree)[0],oldDiscard=f.button(tree,'Discard edits and reload').props.onClick
 oldInput.props.onBlur({target:{value:'2.45'}});f.button(tree,'Publish prices').props.onClick()
 const saved=JSON.parse(JSON.stringify(f.requests[0].input))
 f.requests[0].resolve({success:false,error:'Response lost',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await f.flush()
 oldDiscard();oldInput.props.onBlur({target:{value:'99.00'}});assert.equal(f.refreshes.length,0)
 f.props.matrix.cells[`${id(10)}:${id(20)}`].priceCents=9999
 const current=f.render();assert.ok(f.inputs(current).every(input=>input.props.disabled))
 f.button(current,'Retry reviewed batch').props.onClick();assert.equal(f.requests.length,2);assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].input)),saved)
 f.requests[1].resolve({success:true,data:{count:1}});await f.flush()
})
test('invalid cents block older publish handlers; definite rejection permits editing without implicit rebasing',async()=>{
 const f=form(),tree=f.render(),publish=f.button(tree,'Publish prices').props.onClick,input=f.inputs(tree)[0]
 input.props.onBlur({target:{value:'2.45'}});input.props.onBlur({target:{value:'3.456'}});publish();assert.equal(f.requests.length,0)
 input.props.onBlur({target:{value:'3.45'}});publish();assert.equal(f.requests[0].input.items[0].priceCents,345)
 f.requests[0].resolve({success:false,error:'Price changed'});await f.flush()
 const current=f.render();f.inputs(current)[0].props.onBlur({target:{value:'4.56'}});f.button(current,'Publish prices').props.onClick()
 assert.equal(f.requests[1].input.items[0].expectedPrice.price_cents,123)
 assert.equal(f.requests[1].input.items[0].priceCents,456)
 f.requests[1].resolve({success:true,data:{count:1}});await f.flush()
})

test('reload restores the exact pending request and clears it only after confirmed recovery',async()=>{
 const original=form(),tree=original.render()
 original.inputs(tree)[0].props.onBlur({target:{value:'2.45'}});original.button(tree,'Publish prices').props.onClick()
 assert.equal(original.storage.size,1,'request must be persisted before reply')
 const frozen=JSON.parse(JSON.stringify(original.requests[0].input))
 original.requests[0].resolve({success:false,error:'Unknown',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await original.flush()
 const reloaded=form(original.storage);reloaded.props.matrix.cells[`${id(10)}:${id(20)}`].priceCents=7777
 reloaded.render();const restored=reloaded.render()
 assert.ok(reloaded.inputs(restored).every(input=>input.props.disabled))
 reloaded.button(restored,'Retry reviewed batch').props.onClick()
 assert.deepEqual(JSON.parse(JSON.stringify(reloaded.requests[0].input)),frozen)
 reloaded.requests[0].resolve({success:true,data:{count:1}});await reloaded.flush();assert.equal(reloaded.storage.size,0)
})
test('failed storage write blocks sending; another tab cannot replace a pending batch',async()=>{
 const storage=new Map(),first=form(storage),other=form(storage);const t=first.render(),u=other.render()
 first.inputs(t)[0].props.onBlur({target:{value:'2.45'}});first.button(t,'Publish prices').props.onClick()
 const frozen=[...storage.values()][0]
 other.inputs(u)[0].props.onBlur({target:{value:'9.99'}});other.button(u,'Publish prices').props.onClick();await other.flush()
 assert.equal(other.requests.length,0);assert.equal([...storage.values()][0],frozen)
 first.requests[0].resolve({success:false,error:'Unknown',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await first.flush()
 const denied=new Map();denied.set=()=>{throw new Error('Quota exceeded')}
 const f=form(denied),tree=f.render();f.inputs(tree)[0].props.onBlur({target:{value:'2.45'}});f.button(tree,'Publish prices').props.onClick();await f.flush()
 assert.equal(f.requests.length,0,'cannot send an unrecoverable attempt')
})
test('malformed recovery blocks publication and a disabled cutover retains the saved request',async()=>{
 const storage=new Map([[`arc:catalog-price-publication:v1:${id(1)}:${id(2)}:org`,'{broken']])
 const f=form(storage),tree=f.render();f.inputs(tree)[0].props.onBlur({target:{value:'2.45'}});f.button(tree,'Publish prices').props.onClick();await f.flush();assert.equal(f.requests.length,0);assert.equal(storage.size,1)
 const active=form(),t=active.render();active.inputs(t)[0].props.onBlur({target:{value:'2.45'}});active.button(t,'Publish prices').props.onClick()
 active.requests[0].resolve({success:false,error:'Unknown',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await active.flush()
 const disabled=form(active.storage);disabled.props.matrix.atomicPricing=false;disabled.render();const current=disabled.render()
 assert.equal(disabled.button(current,'Retry reviewed batch').props.disabled,true)
 disabled.button(current,'Retry reviewed batch').props.onClick();assert.equal(disabled.requests.length,0);assert.equal(disabled.storage.size,1)
})
test('a rejection after an unconfirmed attempt does not erase possible committed publication evidence',async()=>{
 const f=form(),tree=f.render();f.inputs(tree)[0].props.onBlur({target:{value:'2.45'}});f.button(tree,'Publish prices').props.onClick()
 const frozen=[...f.storage.values()][0]
 f.requests[0].resolve({success:false,error:'Unknown',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await f.flush()
 f.button(f.render(),'Retry reviewed batch').props.onClick();f.requests[1].resolve({success:false,error:'Published prices changed'});await f.flush()
 assert.equal([...f.storage.values()][0],frozen)
 assert.equal(f.button(f.render(),'Discard edits and reload').props.disabled,true)
})

test('browser lock serializes tabs before persisting and refuses unsupported browsers',async()=>{
 let tail=Promise.resolve();const locks={request:(_key,fn)=>{const operation=tail.then(fn);tail=operation.catch(()=>{});return operation}}
 const storage=new Map(),first=form(storage,locks),second=form(storage,locks),a=first.render(),b=second.render()
 first.inputs(a)[0].props.onBlur({target:{value:'2.45'}});second.inputs(b)[0].props.onBlur({target:{value:'9.99'}})
 first.button(a,'Publish prices').props.onClick();second.button(b,'Publish prices').props.onClick();await first.flush()
 assert.equal(first.requests.length,1);assert.equal(second.requests.length,0)
 first.requests[0].resolve({success:false,error:'Unknown',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await first.flush();await second.flush()
 assert.equal(second.requests.length,0,'second tab must inspect persisted first attempt after lock release')
 const unsupported=form(new Map(),null),t=unsupported.render();unsupported.inputs(t)[0].props.onBlur({target:{value:'2.45'}});unsupported.button(t,'Publish prices').props.onClick();assert.equal(unsupported.requests.length,0)
})
test('revoked management access preserves recovery visibly without allowing a stale retry handler',async()=>{
 const f=form(),tree=f.render();f.inputs(tree)[0].props.onBlur({target:{value:'2.45'}});f.button(tree,'Publish prices').props.onClick()
 f.requests[0].resolve({success:false,error:'Unknown',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await f.flush()
 const restored=form(f.storage);restored.props.canManage=false;restored.render();const current=restored.render()
 assert.equal(restored.button(current,'Retry reviewed batch').props.disabled,true)
 restored.button(current,'Retry reviewed batch').props.onClick();assert.equal(restored.requests.length,0);assert.equal(restored.storage.size,1)
})
