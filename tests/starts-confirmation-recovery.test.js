require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {createFakeSupabase}=require('./support/fake-supabase')
const {confirmationRecoveryEnabled,loadStartConfirmationJobs,queueStartConfirmationRecovery,queueStartNotificationRecovery,readStartNotificationDeliveries}=require('../lib/services/starts-confirmation-recovery')
const {FEATURE_FLAGS}=require('../lib/feature-flags/registry')
const {buildHarness,stubModule,ORG,PACKAGE,ACTOR}=require('./support/starts-harness')
const enabled={org_id:ORG,flag_key:FEATURE_FLAGS.startsConfirmationRecovery,enabled:true}
function harness(flags=[enabled]){
 const db=createFakeSupabase({feature_flags:flags,outbox:[]}),calls=[]
 db.rpc=async(name,args)=>{calls.push({name,args});return {data:{job_id:args.p_job_id,event_id:ACTOR,audit_id:'1',status:'pending'},error:null}}
 return {db,calls,input:{supabase:db,orgId:ORG,packageId:PACKAGE,actorId:ACTOR,jobId:'9007199254740993',reason:'Provider issue resolved'}}
}
test('confirmation recovery defaults off and rejects expiring enabled gates or read failures',async()=>{
 const h=harness([]);assert.equal(await confirmationRecoveryEnabled(h.db,ORG),false)
 await assert.rejects(queueStartConfirmationRecovery(h.input),/not enabled/);assert.equal(h.calls.length,0)
 h.db.store.feature_flags=[{...enabled,expires_at:'2027-01-01'}]
 await assert.rejects(queueStartConfirmationRecovery(h.input),/expiring flag/)
 const from=h.db.from.bind(h.db);h.db.from=table=>{const q=from(table);q.run=()=>({data:null,error:{message:'Controls unavailable'}});return q}
 await assert.rejects(queueStartConfirmationRecovery(h.input),/Controls unavailable/)
})
test('adapter validates reason and returns an exact job receipt without numeric precision loss',async()=>{
 const h=harness();const result=await queueStartConfirmationRecovery(h.input)
 assert.equal(result.job_id,h.input.jobId)
 assert.deepEqual(h.calls,[{name:'retry_start_confirmation',args:{p_org_id:ORG,p_package_id:PACKAGE,p_job_id:h.input.jobId,p_actor_id:ACTOR,p_reason:h.input.reason}}])
 await assert.rejects(queueStartConfirmationRecovery({...h.input,reason:'short'}))
 assert.equal(h.calls.length,1)
})
test('missing RPC, lost responses and mismatched receipts never trigger fallback inserts',async()=>{
 const h=harness()
 for(const message of ['Missing staged RPC','Lost response']){
  h.db.rpc=async()=>({data:null,error:{message}})
  await assert.rejects(queueStartConfirmationRecovery(h.input),new RegExp(message))
 }
 h.db.rpc=async()=>({data:{job_id:'2',event_id:ACTOR,audit_id:'1',status:'pending'},error:null})
 await assert.rejects(queueStartConfirmationRecovery(h.input),/different job/)
 assert.equal(h.db.store.outbox.length,0)
})
test('confirmation history is bounded and scoped by organization, package and job family',async()=>{
 const h=harness();const job={id:'1',org_id:ORG,job_type:'start_release',payload:{start_package_id:PACKAGE},status:'failed',last_error:'Provider unavailable',retry_count:3}
 h.db.store.outbox=[job,{...job,id:'2',org_id:'foreign'},{...job,id:'3',job_type:'other'},{...job,id:'4',payload:{start_package_id:'foreign'}}]
 assert.deepEqual(await loadStartConfirmationJobs(h.db,ORG,PACKAGE),[{id:'1',status:'failed',error:'Provider unavailable',retryCount:3}])
 h.db.store.outbox=Array.from({length:51},(_,i)=>({...job,id:String(i+1)}))
 await assert.rejects(loadStartConfirmationJobs(h.db,ORG,PACKAGE),/requires reconciliation/)
})
test('starts service refuses an unreleased home or denied coordinator before recovery RPC',async()=>{
 const h=buildHarness();stubModule('@/lib/services/starts-pipeline-trigger',{triggerStartsPipeline:async()=>{}})
 delete require.cache[require.resolve('../lib/services/starts')]
 const {retryStartConfirmation}=require('../lib/services/starts')
 await assert.rejects(retryStartConfirmation(PACKAGE,{jobId:'1',reason:'Provider restored'}),/Only released homes/)
 stubModule('@/lib/services/permissions',{requirePermission:async()=>{throw new Error('Denied coordinator')}})
 delete require.cache[require.resolve('../lib/services/starts')]
 await assert.rejects(require('../lib/services/starts').retryStartConfirmation(PACKAGE,{jobId:'1',reason:'Provider restored'}),/Denied coordinator/)
 assert.equal(h.store.outbox[0].status,'pending')
})
test('starts service queues audited confirmation recovery without changing home artifacts',async()=>{
 const h=buildHarness();h.store.start_packages[0].status='released';h.store.feature_flags=[enabled]
 const before=JSON.stringify({packages:h.store.start_packages,projects:h.store.projects,steps:h.store.start_release_steps,lots:h.store.lots})
 let kicks=0,rpcs=0
 stubModule('@/lib/services/starts-pipeline-trigger',{triggerStartsPipeline:async()=>{kicks++}})
 h.supabase.rpc=async(name,args)=>{rpcs++;assert.equal(name,'retry_start_confirmation');assert.equal(args.p_actor_id,ACTOR);return {data:{job_id:'1',event_id:ACTOR,audit_id:'1',status:'pending'},error:null}}
 delete require.cache[require.resolve('../lib/services/starts')]
 const result=await require('../lib/services/starts').retryStartConfirmation(PACKAGE,{jobId:'1',reason:'Provider restored'})
 assert.equal(result.job_id,'1');assert.equal(rpcs,1);assert.equal(kicks,1)
 assert.equal(JSON.stringify({packages:h.store.start_packages,projects:h.store.projects,steps:h.store.start_release_steps,lots:h.store.lots}),before)
})

test('alert delivery recovery requires both gates and carries a stable recovery request',async()=>{
 const h=harness(),input={...h.input,receiptId:ACTOR,requestId:PACKAGE}
 await assert.rejects(queueStartNotificationRecovery(input),/receipts are not enabled/)
 h.db.store.feature_flags.push({org_id:ORG,flag_key:FEATURE_FLAGS.notificationDeliveryReceipts,enabled:true})
 h.db.rpc=async(name,args)=>{assert.equal(name,'retry_start_notification_delivery');assert.equal(args.p_request_id,PACKAGE);assert.equal(args.p_receipt_id,ACTOR)
  return {data:{request_id:PACKAGE,receipt_id:ACTOR,job_id:'9007199254740993',event_id:ACTOR,audit_id:'1',status:'completed',replayed:true},error:null}}
 const receipt=await queueStartNotificationRecovery(input);assert.equal(receipt.replayed,true);assert.equal(receipt.status,'completed')
 h.db.rpc=async()=>({data:null,error:{message:'Lost response'}})
 await assert.rejects(queueStartNotificationRecovery(input),/same request/)
 assert.equal(h.db.store.outbox.length,0)
})
test('delivery inspection is gated, bounded, scoped and rejects inconsistent page receipts',async()=>{
 const h=harness(),input={...h.input,after:null,failedOnly:true}
 await assert.rejects(readStartNotificationDeliveries(input),/receipts are not enabled/)
 h.db.store.feature_flags.push({org_id:ORG,flag_key:FEATURE_FLAGS.notificationDeliveryReceipts,enabled:true})
 h.db.rpc=async(name,args)=>{assert.equal(name,'list_start_notification_deliveries');assert.deepEqual(args,{p_org_id:ORG,p_package_id:PACKAGE,p_actor_id:ACTOR,p_after:null,p_failed_only:true,p_limit:20})
  return {data:{items:[],next_cursor:null,has_more:false},error:null}}
 const page=await readStartNotificationDeliveries(input)
 assert.deepEqual(page.scope,{orgId:ORG,actorId:ACTOR,packageId:PACKAGE})
 h.db.rpc=async()=>({data:{items:[],next_cursor:ACTOR,has_more:false},error:null})
 await assert.rejects(readStartNotificationDeliveries(input))
 h.db.rpc=async()=>({data:null,error:{message:'Read unavailable'}})
 await assert.rejects(readStartNotificationDeliveries(input),/Read unavailable/)
})
