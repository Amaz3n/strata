const assert = require('node:assert/strict')
const test = require('node:test')
const { createHash } = require('node:crypto')
const { unzipSync } = require('fflate')
const { loadHandler } = require('./fixtures/drawing-lifecycle/harness.cjs')
const { streamZip, uniqueZipName } = loadHandler('lib/files/streaming-zip.ts')
const { hashDocumentUpload } = loadHandler('lib/files/upload-fingerprint.ts')

test('incremental upload checksum matches ordinary SHA-256 and legacy multipart chain',async()=>{
 const data=Buffer.alloc(9*1024*1024+7,41);const blob=new Blob([data]);blob.arrayBuffer=()=>{throw Error('must only read slices')}
 const actual=await hashDocumentUpload(blob);assert.equal(actual.checksum,createHash('sha256').update(data).digest('hex'))
 let chain=Buffer.alloc(32);for(let offset=0;offset<data.length;offset+=4*1024*1024)chain=createHash('sha256').update(chain).update(data.subarray(offset,offset+4*1024*1024)).digest()
 assert.equal(actual.fingerprint,`sha256-chain-v1:${data.length}:${chain.toString('hex')}`)
})
test('ZIP streams valid unicode names with bounded source reads before completion',async()=>{
 let reads=0;const data=Buffer.alloc(64*1024,7)
 const source=()=>new ReadableStream({pull(c){if(reads===50)c.close();else{reads++;c.enqueue(data)}}},{highWaterMark:0})
 const stream=streamZip([{name:'plans/été.pdf',open:async()=>source()}],4*1024*1024)
 const reader=stream.getReader();const first=await reader.read();assert.equal(first.done,false);assert.ok(reads<3)
 const chunks=[first.value];while(true){const next=await reader.read();if(next.done)break;chunks.push(next.value)}
 const zipped=Buffer.concat(chunks);const decoded=unzipSync(zipped);assert.equal(decoded['plans/été.pdf'].length,50*data.length)
 assert.ok(decoded['plans/été.pdf'].every(x=>x===7))
})
test('ZIP enforces actual bytes and cancels the active source on overflow',async()=>{
 let cancelled=false
 const stream=streamZip([{name:'x',open:async()=>new ReadableStream({pull(c){c.enqueue(new Uint8Array(8))},cancel(){cancelled=true}},{highWaterMark:0})}],10)
 await assert.rejects(new Response(stream).arrayBuffer(),/size limit/);assert.equal(cancelled,true)
})
test('ZIP browser cancellation closes the current source and never opens later files',async()=>{
 let cancelled=false,second=false
 const stream=streamZip([{name:'a',open:async()=>new ReadableStream({pull(c){c.enqueue(new Uint8Array(8))},cancel(){cancelled=true}},{highWaterMark:0})},{name:'b',open:async()=>{second=true;throw Error('should not open')}}],100)
 const reader=stream.getReader();await reader.read();await reader.cancel();assert.equal(cancelled,true);assert.equal(second,false)
 const names=new Set();assert.equal(uniqueZipName('../plans/a.pdf',names),'plans/a.pdf');assert.equal(uniqueZipName('plans/a.pdf',names),'plans/a (2).pdf')
})
