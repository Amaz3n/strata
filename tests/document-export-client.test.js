const test = require('node:test')
const assert = require('node:assert/strict')
const { loadHandler } = require('./fixtures/drawing-lifecycle/harness.cjs')
function fixture(t) {
 const original={fetch:global.fetch,localStorage:global.localStorage,setTimeout:global.setTimeout}
 const saved=new Map(),calls=[],toasts=[]
 global.localStorage={getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)}
 global.setTimeout=()=>0
 let response=async()=>({ok:true,status:200,json:async()=>({status:'queued'})})
 global.fetch=async(url,options)=>{calls.push({url,options});return response(url,options)}
 t.after(()=>Object.assign(global,original))
 const client=loadHandler('components/files/download.ts',{sonner:{toast:{info:x=>toasts.push(x),success:x=>toasts.push(x),error:x=>toasts.push(x),dismiss(){}}}},['queueDocumentExport','pendingExports'])
 return {client,saved,calls,toasts,response:fn=>{response=fn}}
}
test('export receipts and deduplication are isolated by actor and organization',async t=>{
 const f=fixture(t);let stop=f.client.resumeDocumentExports('actor-a:org-a')
 await f.client.queueDocumentExport(['file'],'a.zip');const first=JSON.parse(f.calls.find(c=>c.options?.method==='POST').options.body).exportId
 stop();stop=f.client.resumeDocumentExports('actor-b:org-a');await f.client.queueDocumentExport(['file'],'b.zip')
 const second=JSON.parse(f.calls.filter(c=>c.options?.method==='POST')[1].options.body).exportId
 assert.notEqual(first,second);assert.equal(f.client.pendingExports('actor-a:org-a').length,1);assert.equal(f.client.pendingExports('actor-b:org-a').length,1);stop()
})
test('definitive rejection clears an unqueued receipt while uncertain failures reuse its identity',async t=>{
 const f=fixture(t);const stop=f.client.resumeDocumentExports('actor:org')
 f.response(async()=>({ok:false,status:403,json:async()=>({error:'Forbidden'})}))
 await assert.rejects(f.client.queueDocumentExport(['file'],'a.zip'),/Forbidden/);assert.equal(f.client.pendingExports('actor:org').length,0)
 f.response(async()=>{throw Error('response lost')})
 await assert.rejects(f.client.queueDocumentExport(['file'],'a.zip'));const kept=f.client.pendingExports('actor:org')[0].id
 await assert.rejects(f.client.queueDocumentExport(['file'],'a.zip'));assert.equal(f.client.pendingExports('actor:org')[0].id,kept);stop()
})
test('old-scope response cannot notify after an account switch',async t=>{
 const f=fixture(t);f.client.resumeDocumentExports('actor-a:org')
 let resolve;f.response(()=>new Promise(r=>{resolve=r}));const pending=f.client.queueDocumentExport(['file'],'a.zip')
 f.client.resumeDocumentExports('actor-b:org');resolve({ok:true,status:200,json:async()=>({status:'queued'})});await pending
 assert.equal(f.toasts.length,0)
})
