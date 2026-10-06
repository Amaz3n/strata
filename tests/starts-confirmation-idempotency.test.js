require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {createFakeSupabase}=require('./support/fake-supabase')
const {insertImmutableRecord}=require('../lib/services/immutable-record')
const {startsConfirmationId}=require('../lib/starts/confirmation-identity')
const {buildHarness,stubModule,ORG,PACKAGE,ACTOR,PROJECT}=require('./support/starts-harness')
const id=startsConfirmationId(ORG,PACKAGE,'event')
function record(extra={}){return {id,org_id:ORG,event_type:'start.released',entity_type:'start_package',entity_id:PACKAGE,payload:{actor_id:ACTOR,project_id:PROJECT},channel:'activity',...extra}}
test('confirmation IDs survive retries and separate org, package, channel and recipient',()=>{
 assert.equal(startsConfirmationId(ORG,PACKAGE,'event'),id)
 const ids=[id,startsConfirmationId('other',PACKAGE,'event'),startsConfirmationId(ORG,'other','event'),startsConfirmationId(ORG,PACKAGE,'notification',ACTOR),startsConfirmationId(ORG,PACKAGE,'notification','other')]
 assert.equal(new Set(ids).size,ids.length);assert.match(id,/^[0-9a-f-]{36}$/)
 assert.throws(()=>startsConfirmationId(ORG,PACKAGE,'notification'),/scope/)
})
test('immutable event replay reuses its record and permits JSON key ordering differences',async()=>{
 const db=createFakeSupabase({events:[]}),first=await insertImmutableRecord(db,'events',record())
 assert.equal(first.created,true)
 const second=await insertImmutableRecord(db,'events',record({payload:{project_id:PROJECT,actor_id:ACTOR}}))
 assert.equal(second.created,false);assert.equal(db.store.events.length,1)
})
test('changed entity, actor or payload cannot adopt a stable event identity',async()=>{
 for(const extra of [{entity_id:'other'},{payload:{actor_id:'other',project_id:PROJECT}},{channel:'integration'}]){
  const db=createFakeSupabase({events:[record()]})
  await assert.rejects(insertImmutableRecord(db,'events',record(extra)),/original scope or payload/)
  assert.deepEqual(db.store.events[0],record())
 }
})
test('lost insert responses are recovered with the same stable identity',async()=>{
 const db=createFakeSupabase({events:[]}),from=db.from.bind(db);let fail=true
 db.from=table=>{const q=from(table),run=q.run.bind(q);q.run=()=>{const result=run();if(q.action==='insert'&&fail){fail=false;return {data:null,error:{message:'Lost response'}}}return result};return q}
 await assert.rejects(insertImmutableRecord(db,'events',record()),/Lost response/)
 assert.equal((await insertImmutableRecord(db,'events',record())).created,false);assert.equal(db.store.events.length,1)
})
test('a competing insert winner must have the same immutable scope',async()=>{
 const db=createFakeSupabase({events:[]}),from=db.from.bind(db)
 db.from=table=>{const q=from(table),run=q.run.bind(q);q.run=()=>{if(q.action==='insert'){db.store.events.push(record());return {data:null,error:{code:'23505',message:'duplicate'}}}return run()};return q}
 assert.equal((await insertImmutableRecord(db,'events',record())).created,false)
})
test('foreign identity collisions and recovery read errors fail closed',async()=>{
 const db=createFakeSupabase({events:[record({org_id:'foreign'})]}),from=db.from.bind(db)
 db.from=table=>{const q=from(table),run=q.run.bind(q);q.run=()=>q.action==='insert'?{data:null,error:{code:'23505',message:'duplicate'}}:run();return q}
 await assert.rejects(insertImmutableRecord(db,'events',record()),/another scope/)
 const unavailable=createFakeSupabase({events:[]});unavailable.from=()=>({select(){return this},eq(){return this},maybeSingle:async()=>({data:null,error:{message:'Read unavailable'}})})
 await assert.rejects(insertImmutableRecord(unavailable,'events',record()),/Read unavailable/)
})
function notificationHarness(){
 const h=buildHarness({instantiate:async()=>({success:true})})
 stubModule('@/lib/services/apns',{isApnsConfigured:()=>true})
 stubModule('@/lib/auth/context',{requireOrgMembership:async()=>{throw new Error('No session')}})
 stubModule('@/lib/services/notification-email-delivery',{deliverNotificationEmail:async()=>{}})
 delete require.cache[require.resolve('../lib/services/notifications')]
 const {NotificationService}=require('../lib/services/notifications')
 const input={orgId:ORG,userId:ACTOR,type:'start_released',title:'House released',message:'Released',projectId:PROJECT,entityType:'start_package',entityId:PACKAGE,eventId:id}
 return {...h,service:new NotificationService(),input,options:{idempotencyId:startsConfirmationId(ORG,PACKAGE,'notification',ACTOR)}}
}
test('notification retries create one in-app record and reuse pending or completed delivery jobs',async()=>{
 const h=notificationHarness();await h.service.createAndQueue(h.input,h.options)
 await h.service.createAndQueue(h.input,h.options)
 const jobs=h.store.outbox.filter(row=>row.job_type==='deliver_push')
 assert.equal(h.store.notifications.length,1);assert.equal(jobs.length,1)
 jobs[0].status='completed';await h.service.createAndQueue(h.input,h.options)
 assert.equal(h.store.outbox.filter(row=>row.job_type==='deliver_push').length,1)
})
test('failed enqueue is surfaced and replay repairs delivery without recreating the alert',async()=>{
 const h=notificationHarness()
 stubModule('@/lib/services/outbox',{enqueueOutboxJob:async()=>({enqueued:false,reason:'error'})})
 // Reload to bind the deliberately failing outbox stub.
 delete require.cache[require.resolve('../lib/services/notifications')]
 const {NotificationService}=require('../lib/services/notifications')
 await assert.rejects(new NotificationService().createAndQueue(h.input,h.options),/queue notification delivery/)
 assert.equal(h.store.notifications.length,1)
 stubModule('@/lib/services/outbox',{enqueueOutboxJob:async input=>{h.store.outbox.push({id:'repair-job',org_id:ORG,job_type:input.jobType,status:'pending',payload:input.payload});return {enqueued:true}}})
 delete require.cache[require.resolve('../lib/services/notifications')]
 const Reloaded=require('../lib/services/notifications').NotificationService
 await new Reloaded().createAndQueue(h.input,h.options)
 assert.equal(h.store.notifications.length,1);assert.equal(h.store.outbox.filter(row=>row.job_type==='deliver_push').length,1)
})
test('failed delivery receipts require recovery and mismatched alerts cannot be adopted',async()=>{
 const h=notificationHarness();await h.service.createAndQueue(h.input,h.options)
 h.store.outbox.find(row=>row.job_type==='deliver_push').status='failed'
 await assert.rejects(h.service.createAndQueue(h.input,h.options),/failed-job recovery/)
 await assert.rejects(h.service.createAndQueue({...h.input,userId:'other'},h.options),/original scope or payload/)
 assert.equal(h.store.notifications.length,1)
})

test('enabled notification receipts recover lost reservation responses without legacy queue insertion',async()=>{
 const h=notificationHarness(),key=require('../lib/feature-flags/registry').FEATURE_FLAGS.notificationDeliveryReceipts
 h.store.feature_flags=[{org_id:ORG,flag_key:key,enabled:true}]
 let attempts=0
 h.supabase.rpc=async(name,args)=>{
  assert.equal(name,'reserve_notification_delivery');assert.equal(args.p_notification_id,h.options.idempotencyId)
  attempts++
  if(!h.store.notification_delivery_receipts?.length)h.store.notification_delivery_receipts=[{id:ACTOR,org_id:ORG,notification_id:h.options.idempotencyId}]
  if(attempts===1)return {data:null,error:{message:'Lost reservation response'}}
  return {data:{receipt_id:ACTOR,job_id:null,status:'completed'},error:null}
 }
 await assert.rejects(h.service.createAndQueue(h.input,h.options),/Lost reservation response/)
 assert.equal(h.store.notifications.length,1);assert.equal(h.store.outbox.filter(row=>row.job_type==='deliver_push').length,0)
 assert.equal(await h.service.createAndQueue(h.input,h.options),h.options.idempotencyId)
 assert.equal(h.store.notifications.length,1);assert.equal(attempts,2)
 h.store.feature_flags[0].enabled=false
 await assert.rejects(h.service.createAndQueue(h.input,h.options),/Restore notification delivery receipts/)
 assert.equal(h.store.outbox.filter(row=>row.job_type==='deliver_push').length,0)
})

test('stable event adapter records once and rejects a different release actor',async()=>{
 const h=notificationHarness();let fanouts=0
 stubModule('@/lib/observability/after-response',{afterResponse:()=>{fanouts++}})
 delete require.cache[require.resolve('../lib/services/events')]
 const {recordEvent}=require('../lib/services/events')
 const input={orgId:ORG,actorId:ACTOR,eventType:'start.released',entityType:'start_package',entityId:PACKAGE,payload:{project_id:PROJECT},idempotencyId:id}
 assert.equal((await recordEvent(input)).id,id)
 assert.equal((await recordEvent(input)).id,id)
 assert.equal(h.store.events.length,1);assert.equal(fanouts,1)
 await assert.rejects(recordEvent({...input,actorId:'other'}),/original scope or payload/)
})

test('competing stable event inserts converge through a real PostgreSQL primary key',async t=>{
 const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();t.after(()=>db.close())
 await db.exec('create table events(id uuid primary key,org_id uuid,event_type text,entity_type text,entity_id uuid,payload jsonb,channel text,created_at timestamptz default now())')
 const client={from(table){
  assert.equal(table,'events')
  const filters=[],q={values:null,select(){return this},eq(key,value){assert.ok(['id','org_id'].includes(key));filters.push([key,value]);return this},insert(values){this.values=values;return this},
   async execute(){try{
    let rows
    if(this.values){const columns=Object.keys(this.values);assert.ok(columns.every(key=>['id','org_id','event_type','entity_type','entity_id','payload','channel'].includes(key)))
     const params=columns.map(key=>key==='payload'?JSON.stringify(this.values[key]):this.values[key])
     rows=(await db.query(`insert into events(${columns.join(',')}) values(${columns.map((key,i)=>`$${i+1}${key==='payload'?'::jsonb':''}`).join(',')}) returning *`,params)).rows
    }else rows=(await db.query(`select * from events where ${filters.map(([key],i)=>`${key}=$${i+1}`).join(' and ')}`,filters.map(([,value])=>value))).rows
    return {data:rows[0]??null,error:null}
   }catch(error){return {data:null,error:{code:error.code,message:error.message}}}},single(){return this.execute()},maybeSingle(){return this.execute()}}
  return q
 }}
 const results=await Promise.all([insertImmutableRecord(client,'events',record()),insertImmutableRecord(client,'events',record())])
 assert.equal(results.filter(result=>result.created).length,1)
 assert.equal(results[0].record.id,results[1].record.id)
 assert.equal((await db.query('select count(*)::int n from events')).rows[0].n,1)
 await assert.rejects(insertImmutableRecord(client,'events',record({payload:{actor_id:ACTOR,project_id:'different'}})),/original scope or payload/)
})
