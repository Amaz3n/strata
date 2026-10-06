const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),test=require('node:test')
function form(){
 const slots=[],toasts=[],refreshes=[],creates=[];let cursor=0,pending=false,result={success:true,data:{documentId:'doc',envelopeId:'env',reason:'Invitations queued'}},effects=[]
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>v===b[i])
 const react={useMemo(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={deps,value:fn()};return slots[i].value},useRef(value){const i=cursor++;return slots[i]??(slots[i]={current:value})},useLayoutEffect(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)){const old=slots[i];slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=fn()})}},useTransition(){return [pending,fn=>{pending=true;Promise.resolve(fn()).finally(()=>pending=false)}]}}
 const compiled={exports:{}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/sales/agreement-signing-recovery.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports:compiled.exports,require(name){
 if(name==='react')return react
 if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}
 if(name==='next/link')return {default:'Link'}
 if(name==='next/navigation')return {useRouter:()=>({refresh:()=>refreshes.push(true)})}
 if(name==='@/components/ui/button')return {Button:'Button'}
 if(name==='@/hooks/use-toast')return {useToast:()=>({toast:value=>toasts.push(value)})}
 if(name==='@/lib/action-result')return {unwrapAction:r=>{if(!r.success)throw new Error(r.error);return r.data}}
 if(name==='@/app/(app)/sales/actions')return {resumePurchaseAgreementSigningAction:input=>{creates.push(input);return result}}
 return {}
 }})
 const props={contractId:'contract',projectId:'home',state:{stage:'prepared',title:'Preparation incomplete',detail:'Resume',canResume:true,documentId:'doc'}}
 const nodes=(node,predicate)=>!node||typeof node!=='object'?[]:[...(predicate(node)?[node]:[]),...(Array.isArray(node.props?.children)?node.props.children:[node.props?.children]).flatMap(c=>nodes(c,predicate))]
 return {props,toasts,refreshes,creates,setResult:r=>result=r,render(){cursor=0;effects=[];const tree=compiled.exports.AgreementSigningRecovery(props);effects.forEach(f=>f());return tree},button:tree=>nodes(tree,n=>n.type==='Button'&&n.props.onClick)[0],unmount(){slots.forEach(s=>s?.cleanup?.())},flush:async()=>{for(let i=0;i<10;i++)await Promise.resolve()}}
}
test('recovery reports queued preparation accurately and coalesces duplicate submits',async()=>{
 const f=form(),button=f.button(f.render());button.props.onClick();button.props.onClick();await f.flush()
 assert.equal(f.creates.length,1);assert.equal(f.toasts[0].title,'Signing packet prepared');assert.equal(f.refreshes.length,0)
 assert.match(f.toasts[0].description,/queued/)
})
test('late recovery callbacks cannot affect another contract, home, status view or unmounted page',async()=>{
 for(const change of ['contract','home','status','unmount']){
 const f=form();let resolve;f.setResult(new Promise(done=>resolve=done));const old=f.button(f.render());old.props.onClick()
 assert.equal(f.button(f.render()).props.disabled,true)
 if(change==='contract')f.props.contractId='other'
 if(change==='home')f.props.projectId='other'
 if(change==='status')f.props.state={...f.props.state,stage:'queued',canResume:false}
 if(change==='unmount')f.unmount();else f.render()
 old.props.onClick();assert.equal(f.creates.length,1)
 resolve({success:true,data:{documentId:'doc',envelopeId:'env',reason:'Queued'}});await f.flush()
 assert.equal(f.toasts.length,0);assert.equal(f.refreshes.length,0)
 }
})
test('recovery errors refresh evidence once without automatic retry or a successful toast',async()=>{
 const f=form();f.setResult({success:false,error:'Reconciliation required'});f.button(f.render()).props.onClick();await f.flush()
 assert.equal(f.toasts[0].title,'Could not resume signing');assert.equal(f.creates.length,1);assert.equal(f.refreshes.length,1)
 const unavailable=form();unavailable.props.state.canResume=false;assert.equal(unavailable.button(unavailable.render()),undefined)
})
