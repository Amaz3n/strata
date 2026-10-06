require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {createFakeSupabase}=require('./support/fake-supabase')
const {reserveNotificationDeliveries}=require('../lib/services/notification-delivery-reservation')
const {FEATURE_FLAGS,FEATURE_FLAG_DEFINITIONS}=require('../lib/feature-flags/registry')
const ORG='00000000-0000-4000-8000-000000000001',NOTE='00000000-0000-4000-8000-000000000002',RECEIPT='00000000-0000-4000-8000-000000000003'
function harness(flags=[],receipts=[]){
 const db=createFakeSupabase({feature_flags:flags,notification_delivery_receipts:receipts}),calls=[]
 db.rpc=async(name,args)=>{calls.push({name,args});return {data:{receipt_id:RECEIPT,job_id:'9007199254740993',status:'pending'},error:null}}
 return {db,calls,input:{supabase:db,orgId:ORG,notificationId:NOTE,channels:['deliver_notification','deliver_push']}}
}
function flag(extra={}){return {org_id:ORG,flag_key:FEATURE_FLAGS.notificationDeliveryReceipts,enabled:true,...extra}}
function failRead(db,table,error){const from=db.from.bind(db);db.from=name=>{const q=from(name);if(name===table)q.run=()=>({data:null,error});return q}}
test('receipt rollout defaults off and isolates organization scope',async()=>{
 assert.equal(FEATURE_FLAG_DEFINITIONS[FEATURE_FLAGS.notificationDeliveryReceipts].defaultEnabled,false)
 const h=harness([flag({org_id:'foreign'})],[{id:RECEIPT,org_id:'foreign',notification_id:NOTE}])
 assert.equal(await reserveNotificationDeliveries(h.input),false);assert.equal(h.calls.length,0)
})
test('enabled rollout reserves each channel once and preserves bigint job identities',async()=>{
 const h=harness([flag()]);h.input.channels.push('deliver_push')
 assert.equal(await reserveNotificationDeliveries(h.input),true)
 assert.deepEqual(h.calls.map(call=>call.args.p_job_type),['deliver_notification','deliver_push'])
 for(const call of h.calls)assert.deepEqual(call,{name:'reserve_notification_delivery',args:{p_org_id:ORG,p_notification_id:NOTE,p_job_type:call.args.p_job_type}})
})
test('completed receipts accept pruned jobs; failed or missing active jobs demand recovery',async()=>{
 for(const [status,job,expected]of [['completed',null,true],['failed',null,/failed-job recovery/],['processing',null,/lost its job/]]){
  const h=harness([flag()]);h.db.rpc=async()=>({data:{receipt_id:RECEIPT,job_id:job,status},error:null})
  if(expected===true)assert.equal(await reserveNotificationDeliveries(h.input),true)
  else await assert.rejects(reserveNotificationDeliveries(h.input),expected)
 }
})
test('disabled rollout cannot send a previously receipted alert through legacy enqueue',async()=>{
 const h=harness([flag({enabled:false})],[{id:RECEIPT,org_id:ORG,notification_id:NOTE}])
 await assert.rejects(reserveNotificationDeliveries(h.input),/Restore notification delivery receipts/);assert.equal(h.calls.length,0)
})
test('pre-migration schema absence is allowed only with the rollout off',async()=>{
 for(const code of ['42P01','PGRST205']){
  const h=harness();failRead(h.db,'notification_delivery_receipts',{code,message:'Missing staged table'})
  assert.equal(await reserveNotificationDeliveries(h.input),false)
 }
 const h=harness([flag()]);h.db.rpc=async()=>({data:null,error:{code:'PGRST202',message:'Missing staged RPC'}})
 await assert.rejects(reserveNotificationDeliveries(h.input),/Missing staged RPC/)
})
test('read failures, expiring enabled flags and invalid states fail closed',async()=>{
 for(const table of ['feature_flags','notification_delivery_receipts']){
  const h=harness();failRead(h.db,table,{code:'42501',message:'Read denied'})
  await assert.rejects(reserveNotificationDeliveries(h.input),/Read denied/);assert.equal(h.calls.length,0)
 }
 for(const extra of [{expires_at:'2027-01-01'},{enabled:null}]){
  const h=harness([flag(extra)])
  await assert.rejects(reserveNotificationDeliveries(h.input),/expiring flag|Invalid notification delivery rollout/);assert.equal(h.calls.length,0)
 }
})
test('malformed RPC receipts are rejected rather than replaced by legacy enqueue',async()=>{
 for(const data of [null,{}, {receipt_id:RECEIPT,job_id:123,status:'pending'},{receipt_id:RECEIPT,job_id:'1',status:'unknown'}]){
  const h=harness([flag()]);h.db.rpc=async()=>({data,error:null})
  await assert.rejects(reserveNotificationDeliveries(h.input))
 }
})
