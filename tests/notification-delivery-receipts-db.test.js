const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs')
const {PGlite}=require('@electric-sql/pglite')
require('../scripts/register-ts-node-test')
const {createFakeSupabase}=require('./support/fake-supabase')
const {reserveNotificationDeliveries}=require('../lib/services/notification-delivery-reservation')
const {FEATURE_FLAGS}=require('../lib/feature-flags/registry')
const ORG='00000000-0000-4000-8000-000000000001',NOTE='00000000-0000-4000-8000-000000000002',USER='00000000-0000-4000-8000-000000000003',OTHER='00000000-0000-4000-8000-000000000004'
async function setup(t){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table notifications(id uuid primary key,org_id uuid,user_id uuid,notification_type text,payload jsonb);
 create table outbox(id bigint generated always as identity primary key,org_id uuid,job_type text,payload jsonb,status text default 'pending',retry_count integer default 0,last_error text,run_at timestamptz default now(),updated_at timestamptz default now(),created_at timestamptz default now(),priority integer default 0,dedupe_key text,start_claim_token uuid,start_job_lease_expires_at timestamptz);
 create table start_packages(id uuid primary key,org_id uuid,project_id uuid,status text);
 create function assert_starts_release_actor(outbox,start_packages) returns void language plpgsql as $$ begin if current_setting('test.actor_allowed',true)='false' then raise exception 'Actor revoked';end if;end $$;`)
 await db.exec(fs.readFileSync(require.resolve('../supabase/migrations/20261003044000_notification_delivery_receipts.sql'),'utf8'))
 await db.query("insert into notifications values($1,$2,$3,'start_released',$4)",[NOTE,ORG,USER,{title:'House released',project_id:OTHER}])
 const reserve=async(type='deliver_push',org=ORG,note=NOTE)=>(await db.query('select reserve_notification_delivery($1,$2,$3) receipt',[org,note,type])).rows[0].receipt
 return {db,reserve}
}
test('application reservation adapter replays actual service-role SQL receipts after completion and pruning',async t=>{
 const h=await setup(t)
 await h.db.exec('grant all on notifications,outbox,start_packages to service_role;grant usage on all sequences in schema public to service_role;set role service_role')
 const client=createFakeSupabase({feature_flags:[{org_id:ORG,flag_key:FEATURE_FLAGS.notificationDeliveryReceipts,enabled:true}]})
 client.rpc=async(name,args)=>{
  assert.equal(name,'reserve_notification_delivery')
  try{return {data:(await h.db.query('select reserve_notification_delivery($1,$2,$3) receipt',[args.p_org_id,args.p_notification_id,args.p_job_type])).rows[0].receipt,error:null}}
  catch(error){return {data:null,error:{code:error.code,message:error.message}}}
 }
 const input={supabase:client,orgId:ORG,notificationId:NOTE,channels:['deliver_notification','deliver_push']}
 assert.equal(await reserveNotificationDeliveries(input),true)
 await h.db.exec("update outbox set status='completed';delete from outbox where status='completed'")
 assert.equal(await reserveNotificationDeliveries(input),true)
 assert.equal((await h.db.query('select count(*)::int n from outbox')).rows[0].n,0)
 assert.equal((await h.db.query('select count(*)::int n from notification_delivery_receipts')).rows[0].n,2)
})
test('reservation creates one channel job and completed replay survives retention pruning',async t=>{
 const h=await setup(t),first=await h.reserve();assert.equal(first.status,'pending')
 assert.deepEqual(await h.reserve(),first)
 await h.db.query("update outbox set status='processing' where id=$1",[first.job_id]);assert.equal((await h.reserve()).status,'processing')
 await h.db.query("update outbox set status='completed' where id=$1",[first.job_id]);const done=await h.reserve();assert.equal(done.status,'completed')
 await h.db.query('delete from outbox where id=$1',[first.job_id]);const retained=await h.reserve()
 assert.equal(retained.receipt_id,first.receipt_id);assert.equal(retained.job_id,null);assert.equal(retained.status,'completed')
 assert.equal((await h.db.query('select count(*)::int n from outbox')).rows[0].n,0)
})
test('channels remain distinct and role privileges prevent browser reservation or receipt tampering',async t=>{
 const h=await setup(t);await h.db.exec('grant all on notifications,outbox to service_role;grant usage on all sequences in schema public to service_role;set role service_role')
 const push=await h.reserve(),email=await h.reserve('deliver_notification');assert.notEqual(push.job_id,email.job_id)
 await h.db.exec('reset role;grant all on outbox to authenticated;set role authenticated')
 await assert.rejects(h.reserve(),/permission denied/)
 await assert.rejects(h.db.query('select * from notification_delivery_receipts'),/permission denied/)
 await assert.rejects(h.db.query("update outbox set status='completed' where id=$1",[push.job_id]),/require service role/)
 await h.db.query("insert into outbox(org_id,job_type,payload) values($1,'ordinary','{}')",[ORG]);await h.db.exec("update outbox set status='completed' where job_type='ordinary'")
})
test('changed notification scope or payload fails without a replacement delivery',async t=>{
 const h=await setup(t);await h.reserve();await h.db.exec("update notifications set payload='{}'")
 await assert.rejects(h.reserve(),/differs from its delivery receipt/)
 assert.equal((await h.db.query('select count(*)::int n from outbox')).rows[0].n,1)
 await assert.rejects(h.reserve('deliver_push',OTHER),/unavailable in organization/)
})
test('a single historical completed job is adopted but duplicate history requires reconciliation',async t=>{
 const h=await setup(t);await h.db.query("insert into outbox(org_id,job_type,payload,status) values($1,'deliver_push',$2,'completed')",[ORG,{notificationId:NOTE}])
 const adopted=await h.reserve();assert.equal(adopted.status,'completed')
 assert.equal((await h.db.query('select count(*)::int n from outbox')).rows[0].n,1)
 await h.db.query("insert into outbox(org_id,job_type,payload) values($1,'deliver_notification',$2),($1,'deliver_notification',$2)",[ORG,{notificationId:NOTE}])
 await assert.rejects(h.reserve('deliver_notification'),/historical delivery jobs require reconciliation/)
 assert.equal((await h.db.query('select count(*)::int n from notification_delivery_receipts')).rows[0].n,1)
})
test('receipt insert failure rolls back the new queue job and legacy payload adoption',async t=>{
 const h=await setup(t)
 await h.db.exec(`create function reject_receipt() returns trigger language plpgsql as $$ begin raise exception 'Injected receipt failure';end $$;create trigger reject_receipt before insert on notification_delivery_receipts for each row execute function reject_receipt()`)
 await assert.rejects(h.reserve(),/Injected receipt failure/)
 assert.equal((await h.db.query('select count(*)::int n from outbox')).rows[0].n,0)
 await h.db.query("insert into outbox(org_id,job_type,payload) values($1,'deliver_push',$2)",[ORG,{notificationId:NOTE}])
 await assert.rejects(h.reserve(),/Injected receipt failure/)
 assert.deepEqual((await h.db.query('select payload from outbox')).rows[0].payload,{notificationId:NOTE})
})
test('receipt/job identity, completed state and active-job pruning are protected',async t=>{
 const h=await setup(t),receipt=await h.reserve()
 await assert.rejects(h.db.query('delete from outbox where id=$1',[receipt.job_id]),/Active delivery jobs/)
 await assert.rejects(h.db.exec("update notification_delivery_receipts set payload_hash=repeat('a',64)"),/identity is immutable/)
 await assert.rejects(h.db.exec('delete from notification_delivery_receipts'),/cannot be deleted/)
 await assert.rejects(h.db.query("update outbox set payload='{}' where id=$1",[receipt.job_id]),/job identity is immutable/)
 await h.db.query("update outbox set status='completed' where id=$1",[receipt.job_id])
 await assert.rejects(h.db.query("update outbox set status='pending' where id=$1",[receipt.job_id]),/cannot be requeued/)
 await assert.rejects(h.db.exec("update notification_delivery_receipts set completed_at=clock_timestamp()+interval '1 hour'"),/receipt is immutable/)
})
test('failed jobs can be explicitly retried while completed receipts survive notification pruning',async t=>{
 const h=await setup(t),receipt=await h.reserve();await h.db.query("update outbox set status='failed' where id=$1",[receipt.job_id])
 assert.equal((await h.reserve()).status,'failed')
 await h.db.query("update outbox set status='pending' where id=$1",[receipt.job_id]);assert.equal((await h.reserve()).status,'pending')
 await h.db.query("update outbox set status='completed' where id=$1",[receipt.job_id]);await h.db.exec('delete from notifications')
 assert.equal((await h.db.query('select count(*)::int n from notification_delivery_receipts')).rows[0].n,1)
 await h.db.query("insert into notifications values($1,$2,$3,'start_released',$4)",[NOTE,ORG,USER,{title:'House released',project_id:OTHER}])
 assert.equal((await h.reserve()).status,'completed')
})

test('failed receipt completion rolls back the queue status update',async t=>{
 const h=await setup(t),receipt=await h.reserve()
 await h.db.exec(`create function reject_completion_receipt() returns trigger language plpgsql as $$ begin if new.status='completed' then raise exception 'Injected completion failure';end if;return new;end $$;create trigger reject_completion_receipt before update on notification_delivery_receipts for each row execute function reject_completion_receipt()`)
 await assert.rejects(h.db.query("update outbox set status='completed' where id=$1",[receipt.job_id]),/Injected completion failure/)
 assert.equal((await h.reserve()).status,'pending')
 assert.equal((await h.db.query('select status from outbox')).rows[0].status,'pending')
})

test('legacy UUID casing is normalized during adoption and history lookup uses its source index',async t=>{
 const h=await setup(t)
 const note='abcdefab-cdef-4abc-8def-abcdefabcdef'
 await h.db.query("insert into notifications values($1,$2,$3,'start_released','{}')",[note,ORG,USER])
 await h.db.query("insert into outbox(org_id,job_type,payload,status) values($1,'deliver_push',$2,'completed')",[ORG,{notificationId:note.toUpperCase()}])
 const adopted=await h.reserve('deliver_push',ORG,note)
 assert.equal(adopted.status,'completed');assert.equal((await h.db.query('select payload from outbox')).rows[0].payload.notificationId,note)
 await h.db.exec(`insert into outbox(org_id,job_type,payload) select '${ORG}','deliver_push',jsonb_build_object('notificationId',md5(n::text)::uuid) from generate_series(1,30000) n;analyze outbox`)
 const plan=(await h.db.query("explain(format json) select id from outbox where org_id=$1 and job_type='deliver_push' and lower(payload->>'notificationId')=$2 order by id limit 2",[ORG,note])).rows
 assert.match(JSON.stringify(plan),/outbox_notification_delivery_source_idx/)
})
