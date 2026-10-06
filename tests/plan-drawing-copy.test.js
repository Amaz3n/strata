require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {createFakeSupabase}=require('./support/fake-supabase'),{stubModule}=require('./support/starts-harness')
const ORG='00000000-0000-4000-8000-000000000001',HOME='00000000-0000-4000-8000-000000000002',PLAN='00000000-0000-4000-8000-000000000003',ACTOR='00000000-0000-4000-8000-000000000004',SOURCE='00000000-0000-4000-8000-000000000005',ATTEMPT='00000000-0000-4000-8000-000000000006'
const receipt={file_id:SOURCE,drawing_set_id:PLAN,revision_id:HOME,job_id:'7'}
const input={orgId:ORG,projectId:HOME,planVersionId:PLAN,actorId:ACTOR,source:{id:SOURCE,storage_path:`${ORG}/library/plan.pdf`,mime_type:'application/pdf',size_bytes:100}}
function harness({copyFails=false,loseReply=false}={}){
 const calls={head:0,copies:[],published:0},db=createFakeSupabase({projects:[{id:HOME,org_id:ORG,metadata:{}}]})
 let attempt
 db.rpc=async(name,args)=>{
  if(name==='reserve_plan_drawing_copy'){
   attempt??={attempt_id:ATTEMPT,plan_version_id:PLAN,source_file_id:SOURCE,actor_id:ACTOR,storage_path:`${ORG}/projects/${HOME}/plans/${PLAN}/${ATTEMPT}/plan.pdf`,size_bytes:100,source_etag:args.p_source_evidence.source_etag,status:'reserved'}
   db.store.projects[0].metadata={plan_instantiation:{drawing_copy_attempt:attempt}};return {data:attempt,error:null}
  }
  assert.equal(name,'publish_plan_drawing_copy');calls.published++
  attempt={...attempt,status:'published',etag:args.p_copy.etag,receipt};db.store.projects[0].metadata={plan_instantiation:{drawing_copy_attempt:attempt}}
  if(loseReply){loseReply=false;return {data:null,error:{message:'response lost'}}}return {data:receipt,error:null}
 }
 stubModule('@/lib/supabase/server',{createServiceSupabaseClient:()=>db})
 stubModule('@/lib/storage/files-storage',{
  headFilesCopySource:async()=>{calls.head++;return {size:100,sourceEtag:'original'}},
  copyFilesObject:async(params)=>{calls.copies.push(params);if(copyFails){copyFails=false;throw new Error('worker stopped')}return {size:100,sourceEtag:'original',etag:'copied'}},
 })
 delete require.cache[require.resolve('@/lib/services/plan-drawing-copy')]
 const service=require('@/lib/services/plan-drawing-copy');return {db,calls,service}
}
test('copy crash reuses persisted destination and source ETag on the next worker attempt',async()=>{
 const h=harness({copyFails:true})
 await assert.rejects(h.service.publishPlanDrawingCopy(input),/worker stopped/)
 const result=await h.service.publishPlanDrawingCopy(input);assert.equal(result.drawing_set_id,receipt.drawing_set_id)
 assert.equal(h.calls.head,1);assert.equal(h.calls.copies.length,2);assert.equal(h.calls.copies[0].destinationPath,h.calls.copies[1].destinationPath);assert.equal(h.calls.copies[1].expectedSourceEtag,'original')
})
test('lost publication response replays and verifies the receipt without copying again',async()=>{
 const h=harness({loseReply:true})
 await assert.rejects(h.service.publishPlanDrawingCopy(input),/response lost/)
 await h.service.publishPlanDrawingCopy(input)
 assert.equal(h.calls.head,1);assert.equal(h.calls.copies.length,1);assert.equal(h.calls.published,2)
})
test('reserved identity mismatch stops before a storage copy',async()=>{
 const h=harness();h.db.rpc=async()=>({data:{attempt_id:ATTEMPT,plan_version_id:PLAN,source_file_id:HOME,actor_id:ACTOR,storage_path:'path',size_bytes:100,source_etag:'original',status:'reserved'},error:null})
 await assert.rejects(h.service.publishPlanDrawingCopy(input),/does not match this release/);assert.equal(h.calls.copies.length,0)
})
test('drawing publication flag defaults disabled and fails closed on uncertainty or expiry',async()=>{
 const h=harness();assert.equal(await h.service.planDrawingCopyTransactionsEnabled(h.db,ORG),false)
 h.db.store.feature_flags=[{org_id:ORG,flag_key:'plan_drawing_copy_transactions',enabled:true,expires_at:'2099-01-01'}]
 await assert.rejects(h.service.planDrawingCopyTransactionsEnabled(h.db,ORG),/expiring flag/)
 h.db.store.feature_flags[0].expires_at=null;assert.equal(await h.service.planDrawingCopyTransactionsEnabled(h.db,ORG),true)
 const from=h.db.from.bind(h.db);h.db.from=table=>{const query=from(table);query.then=resolve=>Promise.resolve({data:null,error:{message:'unavailable'}}).then(resolve);return query}
 await assert.rejects(h.service.planDrawingCopyTransactionsEnabled(h.db,ORG),/Unable to verify/)
})
test('reservation failure leaves storage untouched and changed recovery receipts are refused',async()=>{
 const h=harness();h.db.rpc=async()=>({data:null,error:{message:'lease lost'}})
 await assert.rejects(h.service.publishPlanDrawingCopy(input),/lease lost/);assert.equal(h.calls.copies.length,0)
 const recovery=harness({loseReply:true});await assert.rejects(recovery.service.publishPlanDrawingCopy(input),/response lost/)
 const rpc=recovery.db.rpc.bind(recovery.db);recovery.db.rpc=async(name,args)=>name==='publish_plan_drawing_copy'?{data:{...receipt,job_id:'99'},error:null}:rpc(name,args)
 await assert.rejects(recovery.service.publishPlanDrawingCopy(input),/receipt changed/);assert.equal(recovery.calls.copies.length,1)
})
