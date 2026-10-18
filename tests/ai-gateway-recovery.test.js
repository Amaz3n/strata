require('../scripts/register-ts-node-test')
const test=require('node:test')
const assert=require('node:assert/strict')
const Module=require('module')
const {z}=require('zod')
const original=Module._load
let calls=[],events=[],responses=[]
const supabase={from(){return {select(){return this},eq(){return this},async maybeSingle(){return {data:null,error:null}}}}}
Module._load=function(request,parent,isMain){
 if(request==='ai'){const actual=original.call(this,request,parent,isMain);return {...actual,generateObject:async(options)=>{calls.push(options);const next=responses.shift();if(next instanceof Error)throw next;return {object:next??{total:10},usage:{inputTokens:12,outputTokens:4,totalTokens:16}}}}}
 if(request==='@/lib/services/ai/provider')return {getApiKeyForProvider:()=> 'test',resolveLanguageModel:(provider,key,model)=>({provider,model})}
 if(request==='@/lib/services/ai/usage'){const actual=original.call(this,request,parent,isMain);return {...actual,recordAiUsage:async(_,record)=>{events.push(record)}}}
 if(request==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>supabase}
 if(request==='@/lib/services/feature-flags')return {isFeatureEnabledForOrg:async()=>true}
 if(request==='@/lib/services/ai/pdf-raster')return {rasterizePdfToImages:async()=>null}
 return original.call(this,request,parent,isMain)
}
const {runAiObject}=require('../lib/services/ai/gateway')
Module._load=original
const base={feature:'document_extraction',schema:z.object({total:z.number()}),prompt:'Synthetic invoice',totalTimeoutMs:1000}
test.beforeEach(()=>{calls=[];events=[];responses=[]})
test('busy primary moves to another provider without same-provider retries',async()=>{
 responses=[Object.assign(new Error('high demand'),{statusCode:503}),{total:10}]
 const result=await runAiObject(base)
 assert.equal(result.ok,true)
 assert.deepEqual(calls.map(c=>c.model.provider),['openai','google'])
 assert.deepEqual(events.map(e=>e.status),['error','ok'])
 assert.equal(calls[0].maxRetries,0)
})
test('bad credentials and invalid schemas stop without charging other tiers',async()=>{
 for(const error of [new Error('Incorrect API key provided'),new Error('Invalid schema for response_format')]){
 calls=[];responses=[error]
 assert.equal((await runAiObject(base)).ok,false)
 assert.equal(calls.length,1)
 }
})
test('deterministic verification escalates to a stronger independent model',async()=>{
 responses=[{total:9},{total:10}]
 const result=await runAiObject({...base,verify:value=>({ok:value.total===10})})
 assert.equal(result.ok,true)
 assert.equal(result.meta.escalated,true)
 assert.equal(events[0].errorKind,'verification_failed')
})
test('cost-capped task may recover availability but never buys quality escalation',async()=>{
 responses=[{total:9}]
 assert.equal((await runAiObject({...base,allowEscalation:false,verify:()=>({ok:false})})).ok,false)
 assert.equal(calls.length,1)
 calls=[];responses=[new Error('rate limit 429'),{total:10}]
 assert.equal((await runAiObject({...base,allowEscalation:false})).ok,true)
 assert.equal(calls.length,2)
})
test('at most one availability fallback; failed provider is not retried on heavy tier',async()=>{
 responses=[new Error('high demand'),new Error('high demand')]
 assert.equal((await runAiObject(base)).ok,false)
 assert.equal(calls.length,2)
})
test('invalid-output errors preserve billed usage before recovery',async()=>{
 const error=Object.assign(new Error('No object generated'),{name:'AI_NoObjectGeneratedError',usage:{inputTokens:20,outputTokens:8,totalTokens:28}})
 responses=[error,{total:10}]
 assert.equal((await runAiObject(base)).ok,true)
 assert.equal(events[0].usage.outputTokens,8)
})
