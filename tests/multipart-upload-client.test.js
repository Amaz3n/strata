const assert = require("node:assert/strict")
const test = require("node:test")
const {loadHandler} = require("./fixtures/drawing-lifecycle/harness.cjs")
const {File} = require("node:buffer")
function fixture(t, {failPart, loseComplete = false, storageFails = false, legacy = false} = {}) {
  const saved = new Map(), remote = new Map(), puts = [], calls = []
  let completed = false, fail = failPart
  const old = {fetch:global.fetch,localStorage:global.localStorage,XMLHttpRequest:global.XMLHttpRequest}
  global.localStorage = {getItem:k=>saved.get(k),setItem:(k,v)=>{if(storageFails) throw Error('quota'); saved.set(k,v)},removeItem:k=>saved.delete(k)}
  global.fetch = async (url,options) => {
    const body=JSON.parse(options.body); calls.push({url,body})
    if (options.signal.aborted) throw new DOMException('aborted','AbortError')
    let value
    if (url==='create') value={provider:'r2',storagePath:'fixture/path',uploadId:'upload',partSize:2}
    else if(url==='batch') value={parts:body.partNumbers.map(partNumber=>({partNumber,uploadUrl:'part/'+partNumber}))}
    else if(url==='part') value={uploadUrl:'part/'+body.partNumber}
    else if(url==='status') value=completed?{state:'completed'}:{state:'uploading',parts:[...remote.values()]}
    else if(url==='complete') {completed=true;if(loseComplete) throw Error('lost response');value={ok:true}}
    else if(url==='abort') {value={ok:true}}
    else throw Error('Nonfixture request '+url)
    return {ok:true,json:async()=>value}
  }
  global.XMLHttpRequest = class {
    upload={};status=200
    open(method,url){this.number=Number(url.split('/')[1])}
    setRequestHeader(){}
    getResponseHeader(){return 'etag-'+this.number}
    send(blob){puts.push(this.number);setTimeout(()=>{if(this.aborted)return;if(this.number===fail){this.onerror?.();return}remote.set(this.number,{partNumber:this.number,size:blob.size,etag:'etag-'+this.number});this.onload?.()},0)}
    abort(){this.aborted=true;this.onabort?.()}
  }
  t.after(()=>Object.assign(global,old))
  const client=loadHandler('lib/services/multipart-upload-client.ts')
  const file=new File(['abcdefgh'],'plans.pdf',{type:'application/pdf'})
  const options={file,contentType:'application/pdf',resumeKey:'key',createBody:{},endpoints:{create:'create',partUrl:'part',complete:'complete',abort:'abort',...(!legacy&&{partUrls:'batch',status:'status'})},retainCompleted:true}
  return {client,options,saved,remote,puts,calls,repair:()=>{fail=null}}
}
test('failed part retains session, reconciles and resends only missing part',async t=>{
  const f=fixture(t,{failPart:2});await assert.rejects(f.client.runMultipartUpload(f.options));assert.equal(f.calls.filter(c=>c.url==='abort').length,0)
  const before=f.puts.length;f.repair();await f.client.runMultipartUpload(f.options);assert.deepEqual(f.puts.slice(before),[2]);assert.equal(f.calls.filter(c=>c.url==='create').length,1)
})
test('lost completion response resolves via authoritative identity status without another PUT',async t=>{
  const f=fixture(t,{loseComplete:true});await f.client.runMultipartUpload(f.options);const before=f.puts.length;await f.client.runMultipartUpload(f.options);assert.equal(f.puts.length,before)
})
test('quota failure does not prevent upload and remote session supports resume without saved data',async t=>{
  const f=fixture(t,{storageFails:true});await f.client.runMultipartUpload(f.options);const before=f.puts.length
  await f.client.runMultipartUpload({...f.options,initialSession:{transferId:'00000000-0000-4000-8000-000000000001',storagePath:'fixture/path',uploadId:'upload',partSize:2}});assert.equal(f.puts.length,before)
})
test('legacy document caller requires neither status nor batch endpoints',async t=>{
  const f=fixture(t,{legacy:true});assert.equal(await f.client.runMultipartUpload(f.options),'fixture/path');assert.equal(f.puts.length,4);assert.equal(f.calls.filter(c=>c.url==='part').length,4)
})
test('malformed state is discarded; different content cannot resume saved parts',async t=>{
  const f=fixture(t);f.saved.set('key','invalid json');await f.client.runMultipartUpload(f.options)
  await assert.rejects(f.client.runMultipartUpload({...f.options,file:new File(['different'],'plans.pdf')}),/does not match/)
})
test('pause while signing settles without aborting remote upload',async t=>{
  const f=fixture(t);const controller=new AbortController();const fetch=global.fetch
  global.fetch=async(url,options)=>{if(url==='batch'){controller.abort('pause');throw new DOMException('aborted','AbortError')}return fetch(url,options)}
  await assert.rejects(f.client.runMultipartUpload({...f.options,signal:controller.signal}));assert.equal(f.puts.length,0);assert.equal(f.calls.filter(c=>c.url==='abort').length,0)
})

test('64 parts use four bounded signing batches',async t=>{
 const f=fixture(t);await f.client.runMultipartUpload({...f.options,file:new File(['x'.repeat(128)],'plans.pdf')})
 const batches=f.calls.filter(c=>c.url==='batch');assert.equal(batches.length,4);assert.ok(batches.every(c=>c.body.partNumbers.length===16));assert.equal(f.puts.length,64)
})
test('explicit cancellation while signing aborts the remote session only after work settles',async t=>{
 const f=fixture(t);const controller=new AbortController();const fetch=global.fetch
 global.fetch=async(url,options)=>{if(url==='batch'){controller.abort('cancel');throw new DOMException('aborted','AbortError')}return fetch(url,options)}
 await assert.rejects(f.client.runMultipartUpload({...f.options,signal:controller.signal}));assert.equal(f.calls.filter(c=>c.url==='abort').length,1);assert.equal(f.saved.has('key'),false);assert.equal(f.puts.length,0)
})

test('stalled siblings are all aborted and late callbacks cannot mutate retained progress',async t=>{
 const f=fixture(t);let active=0,late=0;const progress=[]
 global.XMLHttpRequest=class {
  upload={};status=200;open(method,url){this.number=Number(url.split('/')[1])}setRequestHeader(){}getResponseHeader(){return 'etag-'+this.number}
  send(){active++;this.running=true;if(this.number===1)setTimeout(()=>{this.running=false;active--;this.onload?.()},0)}
  abort(){if(this.running){this.running=false;active--}this.onabort?.();setTimeout(()=>{late++;this.onload?.();this.upload.onprogress?.({lengthComputable:true,loaded:2})},2)}
 }
 await assert.rejects(f.client.runMultipartUpload({...f.options,file:new File(['abcdefghijkl'],'plans.pdf'),stallTimeoutMs:5,onProgress:value=>progress.push(value.loaded)}),/stalled/)
 assert.equal(active,0,'Every sibling XHR must settle before returning')
 const receipt=f.saved.get('key'),reportCount=progress.length
 assert.deepEqual(JSON.parse(receipt).completedParts.map(part=>part.partNumber),[1])
 await new Promise(resolve=>setTimeout(resolve,20))
 assert.ok(late>0);assert.equal(f.saved.get('key'),receipt);assert.equal(progress.length,reportCount,'Late callbacks cannot update progress after settlement')
 assert.equal(f.calls.filter(call=>call.url==='abort').length,0,'A stall preserves remote parts')
})
