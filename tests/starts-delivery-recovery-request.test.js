require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {readPendingDeliveryRecovery,savePendingDeliveryRecovery,clearPendingDeliveryRecovery}=require('../lib/starts/delivery-recovery-request')
const scope={orgId:'org-a',actorId:'coordinator-a',packageId:'home-a'}
const request={receiptId:'00000000-0000-4000-8000-000000000001',requestId:'00000000-0000-4000-8000-000000000002',reason:'Provider credentials restored'}
function storage(){const rows=new Map();return {rows,getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)}}
test('an uncertain retry survives reopening and keeps the same identity and reason',()=>{
 const saved=storage();savePendingDeliveryRecovery(saved,scope,request)
 const reopened=readPendingDeliveryRecovery(saved,scope)
 assert.deepEqual(reopened,request);savePendingDeliveryRecovery(saved,scope,reopened)
 assert.equal(saved.rows.size,1)
 assert.throws(()=>savePendingDeliveryRecovery(saved,scope,{...request,requestId:'00000000-0000-4000-8000-000000000003'}),/previous delivery retry/)
 assert.deepEqual(readPendingDeliveryRecovery(saved,scope),request)
 clearPendingDeliveryRecovery(saved,scope);assert.equal(readPendingDeliveryRecovery(saved,scope),null)
})
test('pending requests are isolated across organization, coordinator and home changes',()=>{
 const saved=storage();savePendingDeliveryRecovery(saved,scope,request)
 for(const changed of [{orgId:'org-b'},{actorId:'coordinator-b'},{packageId:'home-b'}])assert.equal(readPendingDeliveryRecovery(saved,{...scope,...changed}),null)
 assert.deepEqual(readPendingDeliveryRecovery(saved,scope),request)
})
test('corrupt or unavailable session storage fails closed instead of replacing an unknown retry',()=>{
 const saved=storage();savePendingDeliveryRecovery(saved,scope,request)
 const key=[...saved.rows.keys()][0]
 saved.rows.set(key,'invalid JSON');assert.throws(()=>readPendingDeliveryRecovery(saved,scope))
 assert.throws(()=>savePendingDeliveryRecovery(saved,scope,request));assert.equal(saved.rows.get(key),'invalid JSON')
 const unavailable={getItem:()=>null,setItem:()=>{throw new Error('Quota unavailable')},removeItem:()=>{}}
 assert.throws(()=>savePendingDeliveryRecovery(unavailable,scope,request),/Quota unavailable/)
})
