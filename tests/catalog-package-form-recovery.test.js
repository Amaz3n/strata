const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test'),assert=require('node:assert/strict')
require('../scripts/register-ts-node-test')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
let requestIdentity=50
function form(storage=new Map(),locks={request:(_key,fn)=>fn()}){
 const slots=[],requests=[],toasts=[],effects=[];let cursor=0,pending=false
 const hooks={useEffect(fn){const n=cursor++;if(!slots[n]){slots[n]={};effects.push(fn)}},useState(initial){const n=cursor++;slots[n]??={value:initial};return [slots[n].value,value=>slots[n].value=typeof value==='function'?value(slots[n].value):value]},useRef(value){const n=cursor++;slots[n]??={current:value};return slots[n]},useMemo(fn){cursor++;return fn()},useTransition(){return [pending,fn=>{pending=true;Promise.resolve(fn()).finally(()=>pending=false)}]}}
 const props={atomicPublication:true,orgId:id(1),actorId:id(2),groups:[],catalog:{can_read_margin:true,packages:[],categories:[{id:id(3),name:'Kitchen',community_id:null,parent_category_id:null,options:[{id:id(4),name:'Cabinets'}]}]},canManage:true}
 const exports={}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/design-studio/cutoff-rules.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,navigator:{locks},window:{localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}},crypto:{randomUUID:()=>id(++requestIdentity)},Intl,require(name){
  if(name==='react')return hooks
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}
  if(name==='next/navigation')return {useRouter:()=>({refresh(){}})}
  if(name==='sonner')return {toast:{error:message=>toasts.push(message),success:message=>toasts.push(message)}}
  if(name==='@/lib/selections/group-publication-recovery')return require('../lib/selections/group-publication-recovery')
  if(name==='@/lib/selections/package-publication-recovery')return require('../lib/selections/package-publication-recovery')
  if(name==='@/lib/validation/selections')return require('../lib/validation/selections')
  if(name==='@/lib/action-result')return {unwrapAction:result=>{if(!result.success)throw new Error(result.error);return result.data}}
  if(name.endsWith('/design-studio/actions'))return {reviewCatalogGroupCategoriesAction:input=>new Promise((resolve,reject)=>requests.push({input,resolve,reject,review:true})),upsertSelectionGroupAction:input=>new Promise((resolve,reject)=>requests.push({input,resolve,reject,group:true})),listArchivedCatalogPackagesAction:input=>new Promise((resolve,reject)=>requests.push({input,resolve,reject,archiveList:true})),upsertPackageAction:input=>new Promise((resolve,reject)=>requests.push({input,resolve,reject}))}
  return new Proxy({},{get:(_,key)=>key})
 }})
 function nodes(tree,predicate,result=[]){if(!tree||typeof tree!=='object')return result;if(predicate(tree)){
 if(tree.type==='PackageMemberPicker') {const original=tree.props.onToggle;tree.props.onToggle=(id,members)=>original(id,members??props.catalog.categories.flatMap(category=>category.options.map(option=>({id:option.id,name:option.name,categoryId:category.id,categoryKey:category.parent_category_id??category.id,categoryName:category.name,available:option.is_available!==false&&!option.is_archived&&!category.is_archived}))))}
 result.push(tree)
 }for(const child of [tree.props?.children].flat(Infinity))nodes(child,predicate,result);return result}
 const render=()=>{cursor=0;const tree=exports.CutoffRules(props);for(const effect of effects.splice(0))effect();return tree}
 const button=(tree,label)=>nodes(tree,n=>n.type==='Button'&&[n.props.children].flat(Infinity).includes(label))[0]
 const packageDialog=tree=>nodes(tree,n=>n.type==='Dialog'&&nodes(n,x=>x.type==='DialogTitle'&&['New package','Edit package','Review package save','Archive package','Restore package','Edit archived package'].includes(x.props.children)).length)[0]
 const packageForm=tree=>nodes(packageDialog(tree),n=>n.type==='form')[0]
 const data={get:key=>({name:'Kitchen bundle',description:'Reviewed',price:'123.45',cost:'50'})[key]}
 return {storage,props,requests,toasts,render,button,packageDialog,packageForm,data,nodes,flush:async()=>{for(let n=0;n<8;n++)await Promise.resolve()}}
}
test('actual package form coalesces submissions and preserves exact request across unconfirmed retry and catalog refresh',async()=>{
 const f=form();let tree=f.render();f.button(tree,'Package').props.onClick();tree=f.render()
 f.nodes(f.packageDialog(tree),n=>n.type==='PackageMemberPicker')[0].props.onToggle(id(4));tree=f.render()
 const submit=f.packageForm(tree).props.action;submit(f.data);submit(f.data);assert.equal(f.requests.length,1)
 const original=JSON.parse(JSON.stringify(f.requests[0].input));assert.equal(original.expectedOrgId,f.props.orgId);assert.equal(original.expectedActorId,f.props.actorId)
 tree=f.render();f.packageDialog(tree).props.onOpenChange(false);assert.equal(f.packageDialog(f.render()).props.open,true)
 f.requests[0].resolve({success:false,error:'Unconfirmed',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await f.flush()
 f.props.catalog.packages.push({id:id(99),name:'Other package',option_ids:[],price_cents:0});tree=f.render()
 assert.equal(f.nodes(f.packageDialog(tree),n=>n.type==='fieldset'&&n.props.disabled)[0].props.disabled,true)
 f.packageForm(tree).props.action({get:()=>''});assert.equal(f.requests.length,2)
 assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].input)),original)
 f.requests[1].resolve({success:true,data:{id:id(70)}});await f.flush();tree=f.render();assert.equal(f.packageDialog(tree).props.open,false)
 f.button(tree,'Package').props.onClick();tree=f.render();f.nodes(f.packageDialog(tree),n=>n.type==='PackageMemberPicker')[0].props.onToggle(id(4));tree=f.render();f.packageForm(tree).props.action(f.data)
 assert.notEqual(f.requests[2].input.publicationKey,original.publicationKey)
 f.requests[2].resolve({success:true,data:{id:id(71)}});await f.flush()
})
test('confirmed transaction rejection allows edits while network rejection preserves the original attempt',async()=>{
 const f=form();let tree=f.render();f.button(tree,'Package').props.onClick();tree=f.render();f.nodes(f.packageDialog(tree),n=>n.type==='PackageMemberPicker')[0].props.onToggle(id(4));tree=f.render()
 f.packageForm(tree).props.action(f.data);f.requests[0].resolve({success:false,error:'Option unavailable'});await f.flush()
 tree=f.render();assert.equal(f.nodes(f.packageDialog(tree),n=>n.type==='fieldset'&&n.props.disabled).length,0)
 const changed={get:key=>key==='name'?'Revised':f.data.get(key)};f.packageForm(tree).props.action(changed);assert.equal(f.requests[1].input.name,'Revised')
 f.requests[1].reject(new Error('Network lost'));await f.flush();tree=f.render();f.packageForm(tree).props.action(f.data)
 assert.equal(f.requests[2].input.name,'Revised');f.requests[2].resolve({success:true,data:{id:id(71)}});await f.flush()
})

function start(f){let tree=f.render();f.button(tree,'Package').props.onClick();tree=f.render();f.nodes(f.packageDialog(tree),n=>n.type==='PackageMemberPicker')[0].props.onToggle(id(4));tree=f.render();f.packageForm(tree).props.action(f.data)}
test('reload restores the full reviewed package without copying current catalog defaults',async()=>{
 const f=form();start(f);assert.equal(f.storage.size,1);const original=JSON.parse(JSON.stringify(f.requests[0].input));assert.equal(original.requireAtomicPublication,true)
 f.requests[0].resolve({success:false,error:'Unknown',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await f.flush()
 const restored=form(f.storage);restored.props.catalog.packages.push({id:id(77),name:'Other package',option_ids:[],price_cents:0});restored.render();const tree=restored.render()
 assert.equal(restored.packageDialog(tree).props.open,true)
 restored.packageForm(tree).props.action({get:()=>''});assert.deepEqual(JSON.parse(JSON.stringify(restored.requests[0].input)),original)
 restored.requests[0].resolve({success:true,data:{id:id(70)}});await restored.flush();assert.equal(restored.storage.size,0)
})
test('storage failures and concurrent tabs cannot send a new package over an unreconciled request',async()=>{
 const storage=new Map(),first=form(storage),second=form(storage);first.render();second.render();start(first);const saved=[...storage.values()][0];start(second);await second.flush()
 assert.equal(second.requests.length,0);assert.equal([...storage.values()][0],saved)
 first.requests[0].resolve({success:false,error:'Unknown',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await first.flush()
 const denied=new Map();denied.set=()=>{throw new Error('Quota')};const f=form(denied);start(f);await f.flush();assert.equal(f.requests.length,0)
 const unsupported=form(new Map(),null);start(unsupported);assert.equal(unsupported.requests.length,0)
})
test('disabled cutover, revoked access and rejected retry preserve possibly committed recovery',async()=>{
 const f=form();start(f);f.requests[0].resolve({success:false,error:'Unknown',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await f.flush();const saved=[...f.storage.values()][0]
 for(const changed of [{atomicPublication:false},{canManage:false}]){
  const restored=form(f.storage);Object.assign(restored.props,changed);restored.render();const tree=restored.render();restored.packageForm(tree).props.action(restored.data);assert.equal(restored.requests.length,0);assert.equal([...f.storage.values()][0],saved)
 }
 const restored=form(f.storage);restored.render();restored.packageForm(restored.render()).props.action(restored.data);restored.requests[0].resolve({success:false,error:'Package changed'});await restored.flush();assert.equal([...f.storage.values()][0],saved)
 assert.ok(restored.nodes(restored.packageDialog(restored.render()),n=>n.type==='fieldset'&&n.props.disabled).length)
})
test('browser lock serializes package tabs before persistent recovery checks',async()=>{
 let tail=Promise.resolve();const locks={request:(_key,fn)=>{const operation=tail.then(fn);tail=operation.catch(()=>{});return operation}}
 const storage=new Map(),first=form(storage,locks),second=form(storage,locks);first.render();second.render();start(first);start(second);await first.flush();assert.equal(first.requests.length,1);assert.equal(second.requests.length,0)
 first.requests[0].resolve({success:false,error:'Unknown',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await first.flush();await second.flush();assert.equal(second.requests.length,0)
})
test('package form without margin access omits cost from the request and durable recovery',async()=>{
 const f=form();f.props.catalog.can_read_margin=false;start(f)
 assert.equal(Object.hasOwn(f.requests[0].input,'costCents'),false)
 const saved=JSON.parse([...f.storage.values()][0]);assert.equal(Object.hasOwn(saved,'costCents'),false)
 f.requests[0].resolve({success:false,error:'Unknown',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await f.flush()
})

function existingPackage(){return {id:id(80),community_id:null,name:'Original bundle',description:'Original description',image_url:'https://example.test/package.png',price_cents:12345,cost_cents:5000,is_available:false,is_archived:false,sort_order:17,option_ids:[id(4)]}}
test('reviewed edit preserves original package baseline, members, image, sort and availability across catalog refresh, with explicit cost clearing',async()=>{
 const f=form(),target=existingPackage();f.props.catalog.packages=[target];f.render();f.button(f.render(),'Edit package').props.onClick();let tree=f.render()
 assert.equal(f.nodes(f.packageDialog(tree),n=>n.type==='Input'&&n.props.name==='name')[0].props.defaultValue,'Original bundle');assert.equal(f.nodes(f.packageDialog(tree),n=>n.type==='Input'&&n.props.name==='price')[0].props.defaultValue,'123.45')
 target.name='Current catalog name';target.option_ids.push(id(999));f.props.catalog.packages=[{...target,price_cents:999999}]
 f.packageForm(f.render()).props.action({get:key=>key==='cost'?'':f.data.get(key)});assert.equal(f.requests.length,1)
 const input=f.requests[0].input;assert.equal(input.id,id(80));assert.equal(input.expectedPackage.name,'Original bundle');assert.deepEqual([...input.expectedPackage.option_ids],[id(4)]);assert.deepEqual([...input.optionIds],[id(4)]);assert.equal(input.expectedPackage.cost_cents,5000);assert.equal(input.costCents,null);assert.equal(input.imageUrl,'https://example.test/package.png');assert.equal(input.sortOrder,17);assert.equal(input.isAvailable,false)
 f.requests[0].resolve({success:false,error:'Unconfirmed',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await f.flush();f.packageForm(f.render()).props.action({get:()=>''});assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].input)),JSON.parse(JSON.stringify(input)));f.requests[1].resolve({success:true,data:{id:id(80)}});await f.flush();assert.ok(f.toasts.includes('Package updated'))
})
test('edit without margin permission strips a previously visible baseline cost and omits cost updates',async()=>{
 const f=form();f.props.catalog.packages=[existingPackage()];f.props.catalog.can_read_margin=false;f.render();f.button(f.render(),'Edit package').props.onClick();const tree=f.render();assert.equal(f.nodes(f.packageDialog(tree),n=>n.type==='Input'&&n.props.name==='cost').length,0)
 f.packageForm(tree).props.action(f.data);assert.equal(f.requests.length,1);assert.equal(Object.hasOwn(f.requests[0].input,'costCents'),false);assert.equal(Object.hasOwn(f.requests[0].input.expectedPackage,'cost_cents'),false);f.requests[0].resolve({success:true,data:{id:id(80)}});await f.flush()
})
test('inherited packages cannot be moved to the ambient scope and disabled cutover cannot fall back to a legacy edit',async()=>{
 const f=form();f.props.catalog.packages=[existingPackage()];f.props.communityId=id(13);f.render();let tree=f.render();const edit=f.button(tree,'Edit package');assert.equal(edit.props.disabled,true);edit.props.onClick();assert.equal(f.packageDialog(f.render()).props.open,false)
 const g=form();g.props.catalog.packages=[existingPackage()];g.render();g.button(g.render(),'Edit package').props.onClick();g.props.atomicPublication=false;g.packageForm(g.render()).props.action(g.data);assert.equal(g.requests.length,0)
})
test('recovery uses only the verified original review and never a cached-cost or current-name details preview',async()=>{
 const f=form();start(f);f.requests[0].resolve({success:false,error:'Unknown',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await f.flush();const tree=f.render();assert.equal(f.nodes(f.packageDialog(tree),n=>n.type==='details').length,0);assert.equal(f.nodes(f.packageDialog(tree),n=>n.type==='CatalogPublicationReconciliation').length,1);assert.equal(f.nodes(f.packageDialog(tree),n=>n.type==='Input'&&n.props.name==='cost').length,0)
})

test('archive confirmation preserves the full original public package without copying costs or mutable form fields',async()=>{
 const f=form();f.props.catalog.packages=[existingPackage()];f.render();f.button(f.render(),'Archive package').props.onClick();const tree=f.render()
 assert.equal(f.nodes(f.packageDialog(tree),n=>n.type==='Input').length,0);f.packageForm(tree).props.action({get:()=> 'Tampered'})
 const request=f.requests[0].input;assert.equal(request.isArchived,true);assert.equal(request.name,'Original bundle');assert.equal(request.priceCents,12345);assert.equal(request.isAvailable,false);assert.equal(Object.hasOwn(request,'costCents'),false);assert.equal(Object.hasOwn(request.expectedPackage,'cost_cents'),false)
 f.requests[0].resolve({success:false,error:'Unknown',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await f.flush();f.packageForm(f.render()).props.action({get:()=>''});assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].input)),JSON.parse(JSON.stringify(request)));f.requests[1].resolve({success:true,data:{id:id(80)}});await f.flush();assert.ok(f.toasts.includes('Package archived'))
})
test('archived discovery coalesces reads and restores the original package using an explicit pure lifecycle request',async()=>{
 const f=form();f.render();const button=f.button(f.render(),'Archived packages');button.props.onClick();button.props.onClick();assert.equal(f.requests.length,1);assert.equal(f.requests[0].archiveList,true);assert.equal(f.requests[0].input.cursor,null)
 const item={...existingPackage(),is_archived:true},page={orgId:id(1),actorId:id(2),communityId:null,canReadMargin:true,packages:[item],nextCursor:id(80)}
 f.requests[0].resolve({success:true,data:page});await f.flush();f.button(f.render(),'Restore package').props.onClick();f.packageForm(f.render()).props.action({get:()=>''});assert.equal(f.requests[1].input.isArchived,false);assert.equal(f.requests[1].input.expectedPackage.is_archived,true);assert.equal(f.requests[1].input.name,item.name);assert.equal(Object.hasOwn(f.requests[1].input,'costCents'),false)
 f.requests[1].resolve({success:true,data:{id:item.id}});await f.flush();assert.ok(f.toasts.includes('Package restored'))
})

test('archived remediation stays archived and captures the original baseline while replacing obsolete members',async()=>{
 const f=form();f.render();f.button(f.render(),'Archived packages').props.onClick();const archived={...existingPackage(),is_archived:true,option_ids:[id(999)]};f.requests[0].resolve({success:true,data:{orgId:id(1),actorId:id(2),communityId:null,canReadMargin:true,packages:[archived],nextCursor:null}});await f.flush()
 f.button(f.render(),'Edit archived contents').props.onClick();let tree=f.render();const picker=f.nodes(f.packageDialog(tree),n=>n.type==='PackageMemberPicker')[0];picker.props.onToggle(id(999));picker.props.onToggle(id(4));tree=f.render();f.packageForm(tree).props.action(f.data)
 const input=f.requests[1].input;assert.equal(input.editArchived,true);assert.equal(Object.hasOwn(input,'isArchived'),false);assert.equal(input.expectedPackage.is_archived,true);assert.deepEqual([...input.expectedPackage.option_ids],[id(999)]);assert.deepEqual([...input.optionIds],[id(4)])
 f.requests[1].resolve({success:false,error:'Unknown',code:'CATALOG_PUBLICATION_UNCONFIRMED'});await f.flush();f.packageForm(f.render()).props.action({get:()=>''});assert.deepEqual(JSON.parse(JSON.stringify(f.requests[2].input)),JSON.parse(JSON.stringify(input)));f.requests[2].resolve({success:true,data:{id:archived.id}});await f.flush();assert.ok(f.toasts.includes('Archived package updated'))
})

test('choosing a replacement in the same effective category retains only the latest option before publication',async()=>{
 const f=form();f.props.catalog.categories[0].options.push({id:id(5),name:'Replacement cabinets'});f.render();f.button(f.render(),'Package').props.onClick();let tree=f.render();const picker=f.nodes(f.packageDialog(tree),n=>n.type==='PackageMemberPicker')[0];picker.props.onToggle(id(4));picker.props.onToggle(id(5));tree=f.render();f.packageForm(tree).props.action(f.data);assert.deepEqual([...f.requests[0].input.optionIds],[id(5)]);f.requests[0].resolve({success:true,data:{id:id(80)}});await f.flush()
})

test('stale picker handlers cannot exceed 100 distinct package categories',async()=>{
 const f=form();f.props.catalog.categories=Array.from({length:101},(_,n)=>({id:id(1000+n),name:`Category ${n}`,options:[{id:id(2000+n),name:`Option ${n}`,is_available:true}]}));f.render();f.button(f.render(),'Package').props.onClick();let tree=f.render();const picker=f.nodes(f.packageDialog(tree),n=>n.type==='PackageMemberPicker')[0]
 for(let n=0;n<101;n++)picker.props.onToggle(id(2000+n));tree=f.render();assert.equal(f.nodes(f.packageDialog(tree),n=>n.type==='PackageMemberPicker')[0].props.selectedIds.length,100);f.packageForm(tree).props.action(f.data);assert.equal(f.requests[0].input.optionIds.length,100);assert.ok(!f.requests[0].input.optionIds.includes(id(2100)));f.requests[0].resolve({success:true,data:{id:id(80)}});await f.flush()
})

test('atomic member editing uses discovered effective categories beyond the loaded catalog and preserves unavailable originals',async()=>{
 const f=form();f.props.catalog.categories=[];f.render();f.button(f.render(),'Package').props.onClick();let tree=f.render();const picker=f.nodes(f.packageDialog(tree),n=>n.type==='PackageMemberPicker')[0];assert.equal(picker.props.discoveryScope.expectedOrgId,f.props.orgId)
 const members=[{id:id(800),available:true,categoryKey:id(900)},{id:id(801),available:true,categoryKey:id(900)},{id:id(802),available:true,categoryKey:id(901)}]
 picker.props.onToggle(id(800),members);picker.props.onToggle(id(801),members);picker.props.onToggle(id(802),members);tree=f.render();assert.deepEqual([...f.nodes(f.packageDialog(tree),n=>n.type==='PackageMemberPicker')[0].props.selectedIds],[id(801),id(802)])
 f.packageForm(tree).props.action(f.data);assert.deepEqual([...f.requests[0].input.optionIds],[id(801),id(802)]);f.requests[0].resolve({success:true,data:{id:id(80)}});await f.flush()
})


test('cutoff rule continuation links preserve community scope and empty later pages retain first-page navigation',()=>{
 const f=form();f.props.communityId=id(12);f.props.groupCursor=id(40);f.props.nextGroupCursor=id(60);let tree=f.render()
 const links=f.nodes(tree,n=>typeof n.props?.href==='string'&&n.props.href.startsWith('/design-studio/rules'))
 assert.ok(links.some(n=>n.props.href===`/design-studio/rules?community=${id(12)}&groupsAfter=${id(60)}`))
 assert.ok(links.some(n=>n.props.href===`/design-studio/rules?community=${id(12)}`))
 assert.equal(f.button(tree,'Copy org rules'),undefined);assert.equal(f.button(tree,'Add the first rule'),undefined)
 f.props.nextGroupCursor=null;tree=f.render();assert.ok(f.nodes(tree,n=>n.props?.href===`/design-studio/rules?community=${id(12)}`).length)
})


test('cutoff rule rows resolve inherited category names and expose unavailable original references',()=>{
 const f=form();f.props.catalog.categories=[{id:id(14),parent_category_id:id(13),name:'Community kitchen',options:[]}];f.props.groups=[{id:id(50),name:'Kitchen deadline',category_ids:[id(13),id(999)],schedule_task_key:'frame',cutoff_offset_days:-14,cutoff_anchor:'start',community_id:null}]
 const cells=f.nodes(f.render(),n=>n.type==='td');const text=tree=>tree==null?'':typeof tree!=='object'?String(tree):[tree.props?.children].flat(Infinity).map(text).join('')
 assert.ok(cells.some(cell=>text(cell)===`Community kitchen, Unavailable category (${id(999)})`))
})

test('editing an inherited org cutoff rule retains its original org scope and explains its shared effect',async()=>{
 const f=form();f.props.atomicPublication=false;f.props.communityId=id(12);f.props.groups=[{id:id(50),name:'Org deadline',category_ids:[],schedule_task_key:'frame',cutoff_offset_days:-14,cutoff_anchor:'start',community_id:null,sort_order:7}];f.render();f.button(f.render(),'Edit').props.onClick();let tree=f.render()
 const dialog=f.nodes(tree,n=>n.type==='Dialog'&&f.nodes(n,x=>x.type==='DialogTitle'&&x.props.children==='Edit Org deadline').length)[0]
 assert.ok(f.nodes(dialog,n=>n.type==='DialogDescription'&&String(n.props.children).includes('shared by communities')).length)
 f.nodes(dialog,n=>n.type==='form')[0].props.action({get:k=>({name:'Reviewed',scheduleTaskKey:'frame',cutoffOffsetDays:'-14'})[k]});assert.equal(f.requests[0].input.communityId,null);assert.equal(f.requests[0].input.sortOrder,7);f.requests[0].resolve({success:true,data:{community_id:null}});await f.flush()
})


test('shared rule category editing recognizes inherited roots, removes unavailable references and retains org-compatible assignments',async()=>{
 const f=form();f.props.atomicPublication=false;f.props.communityId=id(12);f.props.catalog.categories=[{id:id(14),parent_category_id:id(13),community_id:id(12),name:'Override kitchen',options:[]},{id:id(15),parent_category_id:null,community_id:id(12),name:'Community only',options:[]}];f.props.groups=[{id:id(50),name:'Shared',category_ids:[id(13),id(999)],community_id:null,cutoff_anchor:'start',cutoff_offset_days:-14,schedule_task_key:'frame',sort_order:0}]
 f.render();f.button(f.render(),'Edit').props.onClick();let tree=f.render();const dialog=()=>f.nodes(tree,n=>n.type==='Dialog'&&f.nodes(n,x=>x.type==='DialogTitle'&&x.props.children==='Edit Shared').length)[0]
 let checks=f.nodes(dialog(),n=>n.type==='Checkbox');assert.equal(checks.length,2);assert.equal(checks[0].props.checked,true);checks[1].props.onCheckedChange();tree=f.render();checks=f.nodes(dialog(),n=>n.type==='Checkbox');assert.equal(checks.length,1);checks[0].props.onCheckedChange();tree=f.render();f.nodes(dialog(),n=>n.type==='Checkbox')[0].props.onCheckedChange();tree=f.render()
 f.nodes(dialog(),n=>n.type==='form')[0].props.action({get:k=>({name:'Reviewed',scheduleTaskKey:'frame',cutoffOffsetDays:'-14'})[k]});assert.deepEqual([...f.requests[0].input.categoryIds],[id(13)]);assert.equal(f.requests[0].input.communityId,null);f.requests[0].resolve({success:true,data:{community_id:null}});await f.flush()
})

function groupDialog(f,tree){return f.nodes(tree,n=>n.type==='Dialog'&&f.nodes(n,x=>x.type==='DialogTitle'&&(x.props.children==='Add a cutoff rule'||String(x.props.children).startsWith('Edit '))&&!String(x.props.children).includes('package')).length)[0]}
function groupSubmit(f,data={get:k=>({name:'Reviewed deadline',scheduleTaskKey:'frame',cutoffOffsetDays:'-14'})[k]}){const dialog=groupDialog(f,f.render());f.nodes(dialog,n=>n.type==='form')[0].props.action(data)}
function groupReviewReply(input){return {orgId:input.expectedOrgId,actorId:input.expectedActorId,communityId:input.communityId,categories:input.categoryIds.map(id=>({id,definitionHash:'a'.repeat(64),definition:{id,community_id:null,parent_category_id:null,name:'Original category',description:null,image_url:null,sort_order:0,is_archived:false}})).sort((a,b)=>a.id.localeCompare(b.id))}}
async function reviewGroup(f){f.render();f.button(f.render(),'Add the first rule').props.onClick();groupSubmit(f);const review=f.requests.at(-1);assert.equal(review.review,true);review.resolve({success:true,data:groupReviewReply(review.input)});await f.flush();return f.render()}
test('atomic rule form reviews without writing, freezes exact original scope/source and confirms only the reviewed versioned body',async()=>{
 const f=form();f.props.communityId=id(12);const group={id:id(50),name:'Org deadline',category_ids:[id(3)],schedule_task_key:'frame',cutoff_offset_days:-14,cutoff_anchor:'start',community_id:null,sort_order:7,is_archived:false};f.props.groups=[group]
 f.render();f.button(f.render(),'Edit').props.onClick();groupSubmit(f);assert.equal(f.requests.length,1);assert.equal(f.requests[0].review,true);assert.equal(f.requests[0].input.communityId,null);assert.equal(f.storage.size,0)
 group.name='Changed current row';group.category_ids.push(id(999));f.requests[0].resolve({success:true,data:groupReviewReply(f.requests[0].input)});await f.flush();let tree=f.render()
 const review=f.nodes(groupDialog(f,tree),n=>n.type==='CatalogPublicationReview')[0];assert.equal(review.props.publication.attempt.expectedGroup.name,'Org deadline');assert.deepEqual([...review.props.publication.attempt.expectedGroup.category_ids],[id(3)])
 groupSubmit(f);assert.equal(f.requests.length,1);const confirm=f.button(tree,'Confirm rule save');confirm.props.onClick();confirm.props.onClick();assert.equal(f.requests.length,2);assert.equal(f.requests[1].group,true);assert.equal(f.storage.size,1)
 const original=JSON.parse(JSON.stringify(f.requests[1].input));assert.equal(original.communityId,null);assert.equal(original.expectedCategoryVersions[0].definitionHash,'a'.repeat(64));assert.equal(original.requireAtomicPublication,true)
 groupDialog(f,f.render()).props.onOpenChange(false);assert.equal(groupDialog(f,f.render()).props.open,true)
 f.requests[1].resolve({success:false,error:'Unknown rule commit'});await f.flush();tree=f.render();assert.equal(f.storage.size,1);assert.equal(f.button(tree,'Confirm rule save'),undefined)
 const recovery=f.nodes(groupDialog(f,tree),n=>n.type==='CatalogPublicationReconciliation')[0];assert.equal(JSON.stringify(recovery.props.publication.attempt),JSON.stringify(original));assert.equal(recovery.props.allowRetry,true)
})
test('rule reload recovers the original body and locked fields instead of preparing a new review from current defaults',async()=>{
 const f=form();let tree=await reviewGroup(f);f.button(tree,'Confirm rule save').props.onClick();const original=JSON.parse(JSON.stringify(f.requests[1].input));f.requests[1].reject(new Error('Lost response'));await f.flush()
 const restored=form(f.storage);restored.props.catalog.categories=[];restored.render();tree=restored.render();const recovery=restored.nodes(groupDialog(restored,tree),n=>n.type==='CatalogPublicationReconciliation')[0]
 assert.equal(JSON.stringify(recovery.props.publication.attempt),JSON.stringify(original));assert.equal(restored.requests.length,0);assert.equal(restored.button(tree,'Review rule'),undefined)
 assert.equal(restored.nodes(groupDialog(restored,tree),n=>n.type==='fieldset'&&n.props.disabled)[0].props.disabled,true)
})
test('rule stale review replies and callbacks cannot publish after context/permission changes or dialog closure',async()=>{
 for(const change of ['actor','permission','close']){
  const f=form();f.render();f.button(f.render(),'Add the first rule').props.onClick();groupSubmit(f)
  if(change==='actor')f.props.actorId=id(999);if(change==='permission')f.props.canManage=false;if(change==='close')groupDialog(f,f.render()).props.onOpenChange(false)
  f.render();f.requests[0].resolve({success:true,data:groupReviewReply(f.requests[0].input)});await f.flush();assert.equal(f.button(f.render(),'Confirm rule save'),undefined);assert.equal(f.requests.length,1);assert.equal(f.storage.size,0)
 }
 const f=form(),tree=await reviewGroup(f),callback=f.button(tree,'Confirm rule save').props.onClick;f.props.actorId=id(999);f.render();callback();await f.flush();assert.equal(f.requests.length,1);assert.equal(f.storage.size,0)
})
test('rule storage conflicts and missing Web Locks prevent publication and preserve competing recovery evidence',async()=>{
 const {groupRequest}=require('./fixtures/catalog-group-request'),{persistGroupPublication}=require('../lib/selections/group-publication-recovery')
 const f=form(),tree=await reviewGroup(f),other=groupRequest(),scope={orgId:f.props.orgId,actorId:f.props.actorId,communityId:null},storage={getItem:k=>f.storage.get(k)??null,setItem:(k,v)=>f.storage.set(k,v),removeItem:k=>f.storage.delete(k)}
 persistGroupPublication(storage,scope,other);f.button(tree,'Confirm rule save').props.onClick();await f.flush();assert.equal(f.requests.length,1);assert.equal(f.storage.size,1)
 const recovery=f.nodes(groupDialog(f,f.render()),n=>n.type==='CatalogPublicationReconciliation')[0];assert.equal(recovery.props.publication.attempt.publicationKey,other.publicationKey)
 const blocked=form(new Map(),null),ready=await reviewGroup(blocked);blocked.button(ready,'Confirm rule save').props.onClick();assert.equal(blocked.requests.length,1);assert.equal(blocked.storage.size,0)
})
test('confirmed rule publication clears only its matching original evidence and returning to edits requires a new explicit review',async()=>{
 const f=form();let tree=await reviewGroup(f);const oldReview=f.requests[0];f.button(tree,'Edit reviewed values').props.onClick();tree=f.render();assert.equal(f.button(tree,'Confirm rule save'),undefined);groupSubmit(f);assert.equal(f.requests.length,2);assert.notEqual(f.requests[1],oldReview);f.requests[1].resolve({success:true,data:groupReviewReply(f.requests[1].input)});await f.flush();f.button(f.render(),'Confirm rule save').props.onClick();assert.equal(f.storage.size,1);f.requests[2].resolve({success:true,data:{id:id(71)}});await f.flush();assert.equal(f.storage.size,0);assert.equal(groupDialog(f,f.render()).props.open,false)
})

test('rule storage write/removal failures never lose evidence or start an unprotected action',async()=>{
 const f=form(),tree=await reviewGroup(f),write=f.storage.set;f.storage.set=()=>{throw new Error('Storage unavailable')};f.button(tree,'Confirm rule save').props.onClick();await f.flush();assert.equal(f.requests.length,1);assert.equal(f.storage.size,0)
 f.storage.set=write;f.button(f.render(),'Confirm rule save').props.onClick();assert.equal(f.requests.length,2);const original=JSON.parse(JSON.stringify(f.requests[1].input));const remove=f.storage.delete;f.storage.delete=()=>false;f.requests[1].resolve({success:true,data:{id:id(70)}});await f.flush();assert.equal(f.storage.size,1);assert.equal(JSON.stringify(f.nodes(groupDialog(f,f.render()),n=>n.type==='CatalogPublicationReconciliation')[0].props.publication.attempt),JSON.stringify(original));f.storage.delete=remove
})
test('a rule waiting for its browser lock cannot dispatch after the original actor or dialog context changes',async()=>{
 for(const mode of ['actor','close']){
  const queue=[],f=form(new Map(),{request:(_key,callback)=>new Promise(resolve=>queue.push({callback,resolve}))}),tree=await reviewGroup(f);f.button(tree,'Confirm rule save').props.onClick();assert.equal(queue.length,1);assert.equal(f.requests.length,1)
  if(mode==='actor'){f.props.actorId=id(999);f.render()}else groupDialog(f,f.render()).props.onOpenChange(false)
  await queue[0].callback();queue[0].resolve();await f.flush();assert.equal(f.requests.length,1);assert.equal(f.storage.size,0)
 }
})
