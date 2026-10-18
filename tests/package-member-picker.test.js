const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test'),assert=require('node:assert/strict')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function harness(categories,selectedIds=[]){
 const slots=[],compiled={exports:{}};let cursor=0;const toggled=[],props={categories,selectedIds,disabled:false,onToggle:id=>toggled.push(id)}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/design-studio/package-member-picker.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports:compiled.exports,require(name){
  if(name==='react')return {useMemo:fn=>fn(),useState(initial){const n=cursor++;slots[n]??={value:initial};return [slots[n].value,v=>slots[n].value=typeof v==='function'?v(slots[n].value):v]}}
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};return new Proxy({},{get:(_,key)=>key})
 }})
 const nodes=(tree,predicate,out=[])=>{if(!tree||typeof tree!=='object')return out;if(predicate(tree))out.push(tree);for(const child of [tree.props?.children].flat(Infinity))nodes(child,predicate,out);return out}
 const text=tree=>tree==null||tree===false?'':typeof tree!=='object'?String(tree):[tree.props?.children].flat(Infinity).map(text).join('')
 const render=()=>{cursor=0;const tree=compiled.exports.PackageMemberPicker(props);return typeof tree.type==='function'?tree.type(tree.props):tree},button=(tree,label)=>nodes(tree,n=>n.type==='Button'&&n.props.children===label)[0]
 return {props,toggled,nodes,text,render,button}
}
const categories=(count=10000)=>Array.from({length:Math.ceil(count/100)},(_,c)=>({id:id(20000+c),name:`Category ${c}`,options:Array.from({length:Math.min(100,count-c*100)},(_,n)=>({id:id(c*100+n+1),name:`Option ${c*100+n+1}`,is_available:true}))}))
test('all 10000 catalog options remain reachable with at most 20 rendered members and non-submit pagination',()=>{
 const f=harness(categories()),seen=new Set()
 for(let page=1;page<=500;page++){const tree=f.render(),rows=f.nodes(tree,n=>n.type==='li');assert.equal(rows.length,20);for(const row of rows)seen.add(f.text(row));const next=f.button(tree,'Next members');assert.equal(next.props.type,'button');assert.equal(next.props.disabled,page===500);if(page<500)next.props.onClick()}
 assert.equal(seen.size,10000);assert.match(f.text(f.render()),/Showing 9981–10000 of 10000/)
 f.button(f.render(),'Previous members').props.onClick();assert.match(f.text(f.render()),/Showing 9961–9980 of 10000/)
})
test('search and selected review include missing references and reset pagination without changing selected membership',()=>{
 const f=harness(categories(300),[id(1),id(99999)]);f.button(f.render(),'Next members').props.onClick();f.nodes(f.render(),n=>n.type==='Input')[0].props.onChange({target:{value:'Category 2'}});assert.match(f.text(f.render()),/Showing 1–20 of 100/)
 f.nodes(f.render(),n=>n.type==='Input')[0].props.onChange({target:{value:''}});f.button(f.render(),'Review selected members').props.onClick();const rows=f.nodes(f.render(),n=>n.type==='li');assert.equal(rows.length,2);assert.match(f.text(f.render()),/Member unavailable/);assert.deepEqual(f.props.selectedIds,[id(1),id(99999)])
 f.nodes(f.render(),n=>n.type==='Input')[0].props.onChange({target:{value:id(99999)}});assert.equal(f.nodes(f.render(),n=>n.type==='li').length,1)
})
test('unavailable and disabled controls cannot add members, while selected obsolete members can be removed',()=>{
 const data=categories(2);data[0].options[0].is_available=false;const f=harness(data,[id(99999)])
 let checks=f.nodes(f.render(),n=>n.type==='Checkbox');assert.equal(checks[0].props.disabled,false);checks[0].props.onCheckedChange();assert.deepEqual(f.toggled,[id(99999)]);assert.equal(checks[1].props.disabled,true);checks[1].props.onCheckedChange();assert.equal(f.toggled.length,1)
 f.props.disabled=true;const tree=f.render();f.nodes(tree,n=>n.type==='Checkbox')[0].props.onCheckedChange();f.button(tree,'Review selected members').props.onClick();assert.equal(f.toggled.length,1);assert.ok(f.button(f.render(),'Review selected members'))
})

test('at the 100-member limit a category replacement remains available while a new category cannot be selected',()=>{
 const data=categories(10100),selected=Array.from({length:100},(_,n)=>id(n*100+1)),f=harness(data,selected)
 f.nodes(f.render(),n=>n.type==='Input')[0].props.onChange({target:{value:'Category 100'}});let check=f.nodes(f.render(),n=>n.type==='Checkbox')[0];assert.equal(check.props.disabled,true);check.props.onCheckedChange();assert.equal(f.toggled.length,0)
 f.nodes(f.render(),n=>n.type==='Input')[0].props.onChange({target:{value:'Option 2'}});check=f.nodes(f.render(),n=>n.type==='Checkbox')[0];assert.equal(check.props.disabled,false);check.props.onCheckedChange();assert.deepEqual(f.toggled,[id(2)])
})

function remoteHarness(selectedIds=[],domain="package"){
 const slots=[],effects=[],timers=new Map(),requests=[],toggled=[],compiled={exports:{}};let cursor=0,timerId=0
 const props={categories:[],selectedIds,disabled:false,discoveryScope:{expectedOrgId:id(1),expectedActorId:id(2),communityId:null},onToggle:(...args)=>toggled.push(args)}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/design-studio/catalog-member-picker.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports:compiled.exports,Error,setTimeout:fn=>{timers.set(++timerId,fn);return timerId},clearTimeout:n=>timers.delete(n),require(name){
  if(name==='react')return {useMemo:fn=>fn(),useState(initial){const n=cursor++;slots[n]??={value:initial};return [slots[n].value,v=>slots[n].value=typeof v==='function'?v(slots[n].value):v]},useEffect(fn,deps){const n=cursor++,old=slots[n];if(!old||deps.some((d,i)=>!Object.is(d,old.deps[i]))){old?.cleanup?.();const slot={deps};slots[n]=slot;effects.push(()=>slot.cleanup=fn())}}}
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}
  if(name.endsWith('/design-studio/actions'))return {discoverCatalogGroupCategoriesAction:input=>new Promise((resolve,reject)=>requests.push({input,resolve,reject,domain:'group'})),discoverCatalogPackageMembersAction:input=>new Promise((resolve,reject)=>requests.push({input,resolve,reject,domain:'package'}))}
  if(name==='@/lib/action-result')return {unwrapAction:r=>{if(!r.success)throw new Error(r.error);return r.data}}
  return new Proxy({},{get:(_,key)=>key})
 }})
 const nodes=(tree,predicate,out=[])=>{if(!tree||typeof tree!=='object')return out;if(predicate(tree))out.push(tree);for(const child of [tree.props?.children].flat(Infinity))nodes(child,predicate,out);return out}
 const text=tree=>tree==null||tree===false?'':typeof tree!=='object'?String(tree):[tree.props?.children].flat(Infinity).map(text).join('')
 const render=()=>{cursor=0;const tree=compiled.exports.CatalogMemberPicker({...props,scope:props.discoveryScope,domain});for(const effect of effects.splice(0))effect();return tree}
 const button=(tree,label)=>nodes(tree,n=>n.type==='Button'&&n.props.children===label)[0]
 const answer=(n,items,nextCursor=null)=>requests[n].resolve({success:true,data:{items,nextCursor}})
 const flush=async()=>{for(let n=0;n<8;n++)await Promise.resolve()}
 return {props,requests,toggled,nodes,text,render,button,answer,flush,timers}
}
const member=(n,key=200)=>({id:id(n),name:`Remote option ${n}`,categoryId:id(key),categoryKey:id(key),categoryName:`Remote category ${key}`,available:true})
test('remote member paging does not require bootstrap options and resolves selected references outside the search page',async()=>{
 const f=remoteHarness([id(9999)]);let tree=f.render();assert.equal(f.requests.length,2);assert.equal(f.nodes(tree,n=>n.type==='li').length,0)
 const rows=Array.from({length:20},(_,n)=>member(n+1));f.answer(0,rows,id(20));f.answer(1,[{...member(9999),name:null,categoryName:null,categoryId:null,categoryKey:null,available:false}]);await f.flush();tree=f.render();assert.equal(f.nodes(tree,n=>n.type==='li').length,20)
 f.nodes(tree,n=>n.type==='Checkbox')[0].props.onCheckedChange();assert.equal(f.toggled[0][0],id(1));assert.equal(f.toggled[0][1].length,21)
 f.button(tree,'Review selected members').props.onClick();tree=f.render();assert.equal(f.nodes(tree,n=>n.type==='li').length,1);assert.match(f.text(tree),/Member unavailable/);f.nodes(tree,n=>n.type==='Checkbox')[0].props.onCheckedChange();assert.equal(f.toggled[1][0],id(9999))
 f.button(tree,'Show all options').props.onClick();tree=f.render();f.button(tree,'Next members').props.onClick();tree=f.render();assert.equal(f.nodes(tree,n=>n.type==='li').length,0);assert.equal(f.requests[2].input.cursor,id(20));assert.deepEqual([...f.requests[3].input.selectedIds],[id(9999)])
 f.answer(2,[member(21)]);f.answer(3,[{...member(9999),available:false}]);await f.flush();tree=f.render();assert.equal(f.nodes(tree,n=>n.type==='li').length,1);assert.equal(f.button(tree,'Next members').props.disabled,true);f.button(tree,'Previous members').props.onClick();f.render();assert.equal(f.requests[4].input.cursor,null)
})
test('query and selected changes suppress stale discovery replies and errors retain membership with explicit retry',async()=>{
 const f=remoteHarness([id(90)]);let tree=f.render();f.nodes(tree,n=>n.type==='Input')[0].props.onChange({target:{value:'updated'}});tree=f.render();for(const fn of f.timers.values())fn();f.timers.clear();tree=f.render();assert.equal(f.requests[2].input.query,'updated')
 f.answer(0,[member(1)]);f.answer(1,[member(90)]);await f.flush();assert.equal(f.nodes(f.render(),n=>n.type==='li').length,0)
 f.requests[2].resolve({success:false,error:'Access changed'});f.answer(3,[member(90)]);await f.flush();tree=f.render();assert.match(f.text(tree),/Access changed/);assert.deepEqual(f.props.selectedIds,[id(90)]);f.button(tree,'Retry member discovery').props.onClick();f.render();assert.equal(f.requests.length,6)
 f.answer(4,[member(2)]);f.answer(5,[member(90)]);await f.flush();tree=f.render();assert.equal(f.nodes(tree,n=>n.type==='li').length,1)
 f.props.selectedIds=[id(91)];tree=f.render();assert.equal(f.nodes(tree,n=>n.type==='li').length,0);assert.deepEqual([...f.requests[7].input.selectedIds],[id(91)])
})

test('remote selected review reaches all 100 originals and permits same-category replacement at the member bound',async()=>{
 const ids=Array.from({length:100},(_,n)=>id(1000+n)),f=remoteHarness(ids);f.render();f.answer(0,[member(2000,300),member(2001,999)]);f.answer(1,ids.map((_,n)=>member(1000+n,300+n)));await f.flush();let tree=f.render(),checks=f.nodes(tree,n=>n.type==='Checkbox');assert.equal(checks[0].props.disabled,false);assert.equal(checks[1].props.disabled,true);checks[0].props.onCheckedChange();assert.equal(f.toggled[0][0],id(2000));checks[1].props.onCheckedChange();assert.equal(f.toggled.length,1)
 f.button(tree,'Review selected members').props.onClick();const seen=new Set();for(let n=0;n<5;n++){tree=f.render();const rows=f.nodes(tree,x=>x.type==='li');assert.equal(rows.length,20);for(const row of rows)seen.add(f.text(row));const next=f.button(tree,'Next members');assert.equal(next.props.disabled,n===4);if(n<4)next.props.onClick()}assert.equal(seen.size,100)
})
test('remote scope changes discard old actor results and disabled handlers cannot change the request or selected members',async()=>{
 const f=remoteHarness();let tree=f.render();f.props.discoveryScope={...f.props.discoveryScope,expectedActorId:id(3)};tree=f.render();assert.equal(f.requests[2].input.expectedActorId,id(3));f.answer(0,[member(1)]);f.answer(1,[]);await f.flush();assert.equal(f.nodes(f.render(),n=>n.type==='li').length,0)
 f.answer(2,[member(2)]);f.answer(3,[]);await f.flush();f.props.disabled=true;tree=f.render();f.nodes(tree,n=>n.type==='Checkbox')[0].props.onCheckedChange();f.nodes(tree,n=>n.type==='Input')[0].props.onChange({target:{value:'ignored'}});f.button(tree,'Review selected members').props.onClick();tree=f.render();assert.equal(f.toggled.length,0);assert.equal(f.requests.length,4);assert.equal(f.nodes(tree,n=>n.type==='Input')[0].props.value,'');assert.ok(f.button(tree,'Review selected members'))
})

test('rule category browser reaches all 100 selected references, permits family replacement and never needs bootstrap categories',async()=>{
 const ids=Array.from({length:100},(_,n)=>id(1000+n)),f=remoteHarness(ids,'group');f.render();assert.ok(f.requests.every(r=>r.domain==='group'));assert.equal(f.props.categories.length,0)
 f.answer(0,[{...member(2000,300),categoryId:id(2000)},{...member(2001,999),categoryId:id(2001)}]);f.answer(1,ids.map((_,n)=>({...member(1000+n,300+n),categoryId:id(1000+n)})));await f.flush();let tree=f.render(),checks=f.nodes(tree,n=>n.type==='Checkbox');assert.equal(checks[0].props.disabled,false);assert.equal(checks[1].props.disabled,true);checks[0].props.onCheckedChange();assert.equal(f.toggled[0][0],id(2000))
 f.button(tree,'Review selected categories').props.onClick();const seen=new Set();for(let n=0;n<5;n++){tree=f.render();const rows=f.nodes(tree,x=>x.type==='li');assert.equal(rows.length,20);for(const row of rows)seen.add(f.text(row));if(n<4)f.button(tree,'Next categories').props.onClick()}assert.equal(seen.size,100)
})
test('rule category search/actor changes discard old replies and explicit retry retains selected unavailable references',async()=>{
 const f=remoteHarness([id(99)],'group');f.render();f.props.discoveryScope={...f.props.discoveryScope,expectedActorId:id(3)};f.render();f.answer(0,[member(1)]);f.answer(1,[member(99)]);await f.flush();assert.equal(f.nodes(f.render(),n=>n.type==='li').length,0)
 f.requests[2].resolve({success:false,error:'Category access changed'});f.answer(3,[{...member(99),available:false,name:null,categoryName:null,categoryId:null,categoryKey:null}]);await f.flush();const tree=f.render();assert.match(f.text(tree),/Category access changed/);f.button(tree,'Retry category discovery').props.onClick();f.render();f.answer(4,[]);f.answer(5,[{...member(99),available:false,name:null,categoryName:null,categoryId:null,categoryKey:null}]);await f.flush();f.button(f.render(),'Review selected categories').props.onClick();const selected=f.render();assert.match(f.text(selected),/Category unavailable/);f.nodes(selected,n=>n.type==='Checkbox')[0].props.onCheckedChange();assert.equal(f.toggled[0][0],id(99))
})
