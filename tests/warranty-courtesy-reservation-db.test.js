require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {PGlite}=require('@electric-sql/pglite')
const ORG='00000000-0000-4000-8000-000000000001',PROJECT='00000000-0000-4000-8000-000000000002',COVERAGE='00000000-0000-4000-8000-000000000003',OTHER='00000000-0000-4000-8000-000000000004'
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table app_users(id uuid primary key);create table memberships(id uuid primary key,org_id uuid,user_id uuid,status text);create table orgs(id uuid primary key);create table projects(id uuid primary key,org_id uuid);
 create table project_warranty_coverage(id uuid primary key,org_id uuid,project_id uuid,effective_date date);
 create table warranty_requests(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,request_number integer,title text,description text,status text,priority text,severity text,category text,coverage_status text,source text,cost_dump_flag boolean,scheduled_date date,first_response_due_at timestamptz,resolution_due_at timestamptz,metadata jsonb);
 create unique index warranty_requests_project_number_idx on warranty_requests(project_id,request_number);
 create table warranty_sla_targets(org_id uuid,severity text,first_response_hours integer,resolution_days integer,unique(org_id,severity));
 create table events(id uuid primary key default gen_random_uuid(),org_id uuid,event_type text,entity_type text,entity_id uuid,payload jsonb,channel text);
 create table audit_log(id bigint generated always as identity primary key,org_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,after_data jsonb,source text);`)
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261003049000_warranty_courtesy_reservations.sql'),'utf8'))
 await db.query('insert into orgs values($1),($2)',[ORG,OTHER]);await db.query('insert into projects values($1,$2)',[PROJECT,ORG]);await db.query("insert into project_warranty_coverage values($1,$2,$3,'2026-09-03')",[COVERAGE,ORG,PROJECT])
 const reserve=async(milestone='day_30',asOf='2026-10-03',org=ORG)=>(await db.query('select reserve_warranty_courtesy_inspection($1,$2,$3,$4::date) result',[org,COVERAGE,milestone,asOf])).rows[0].result
 const counts=async()=>(await db.query('select (select count(*)::int from warranty_requests) requests,(select count(*)::int from events) events,(select count(*)::int from audit_log) audits,(select count(*)::int from warranty_courtesy_reservations) receipts')).rows[0]
 return {db,reserve,counts}
}
test('reservation commits one request/event/audit and replay preserves closed request and permanent receipt',async t=>{
 const h=await fixture(t),first=await h.reserve();assert.equal(first.status,'created');assert.equal(first.due_on,'2026-10-03')
 assert.deepEqual(await h.counts(),{requests:1,events:1,audits:1,receipts:1})
 await h.db.query("update warranty_requests set status='closed' where id=$1",[first.request_id])
 const replay=await h.reserve('day_30','2027-10-03');assert.equal(replay.status,'existing');assert.equal(replay.request_id,first.request_id)
 assert.deepEqual(await h.counts(),{requests:1,events:1,audits:1,receipts:1})
 await assert.rejects(h.db.query('delete from warranty_requests where id=$1',[first.request_id]),/foreign key/)
 await assert.rejects(h.db.exec('delete from warranty_courtesy_reservations'),/immutable/)
 await assert.rejects(h.db.exec("update warranty_courtesy_reservations set milestone='month_11'"),/immutable/)
})
test('organization, home, invalid milestone, due window and changed coverage evidence cannot create false work',async t=>{
 const h=await fixture(t);await assert.rejects(h.reserve('day_30','2026-10-03',OTHER),/not found/)
 await assert.rejects(h.reserve('invalid'),/required/)
 assert.equal((await h.reserve('month_11')).status,'not_due');assert.equal((await h.reserve('day_30','2027-10-03')).status,'not_due')
 assert.deepEqual(await h.counts(),{requests:0,events:0,audits:0,receipts:0})
 await h.reserve();await h.db.exec("update project_warranty_coverage set effective_date='2026-09-04'")
 await assert.rejects(h.reserve(),/evidence changed/)
})
test('historical request is adopted once and absent event is atomically repaired',async t=>{
 const h=await fixture(t)
 await h.db.query("insert into warranty_requests(org_id,project_id,request_number,status,metadata) values($1,$2,1,'closed','{\"courtesy_milestone\":\"day_30\",\"courtesy_due_on\":\"2026-10-03\"}')",[ORG,PROJECT])
 assert.equal((await h.reserve()).status,'adopted');assert.deepEqual(await h.counts(),{requests:1,events:1,audits:1,receipts:1})
 assert.equal((await h.reserve()).status,'existing')
})
test('ambiguous or stale historical request evidence rejects adoption',async t=>{
 const h=await fixture(t)
 await h.db.query("insert into warranty_requests(org_id,project_id,request_number,metadata) values($1,$2,1,'{\"courtesy_milestone\":\"day_30\",\"courtesy_due_on\":\"2026-10-02\"}')",[ORG,PROJECT])
 await assert.rejects(h.reserve(),/due date does not match/)
 await h.db.exec("update warranty_requests set metadata=jsonb_set(metadata,'{courtesy_due_on}','\"2026-10-03\"');insert into warranty_requests(org_id,project_id,request_number,metadata) select org_id,project_id,2,metadata from warranty_requests")
 await assert.rejects(h.reserve(),/ambiguous/);assert.equal((await h.counts()).receipts,0)
})
test('late audit failure rolls back request and event, then retry succeeds',async t=>{
 const h=await fixture(t)
 await h.db.exec("create function fail_audit() returns trigger language plpgsql as $$begin raise exception 'Audit unavailable';end;$$;create trigger fail_audit before insert on audit_log for each row execute function fail_audit()")
 await assert.rejects(h.reserve(),/Audit unavailable/);assert.deepEqual(await h.counts(),{requests:0,events:0,audits:0,receipts:0})
 await h.db.exec('drop trigger fail_audit on audit_log');assert.equal((await h.reserve()).status,'created')
})
test('calendar month clamp, configured SLA and browser privilege boundary',async t=>{
 const h=await fixture(t);await h.db.exec("update project_warranty_coverage set effective_date='2025-03-31'")
 await h.db.query("insert into warranty_sla_targets values($1,'routine_60',48,20)",[ORG])
 const result=await h.reserve('month_11','2026-02-28');assert.equal(result.due_on,'2026-02-28')
 const req=(await h.db.query('select severity,first_response_due_at,resolution_due_at from warranty_requests')).rows[0];assert.equal(req.severity,'routine_60');assert.equal((new Date(req.resolution_due_at)-new Date(req.first_response_due_at))/86400000,18)
 const priv=(await h.db.query("select has_function_privilege('authenticated','reserve_warranty_courtesy_inspection(uuid,uuid,text,date,uuid)','execute') browser,has_function_privilege('anon','reserve_warranty_courtesy_inspection(uuid,uuid,text,date,uuid)','execute') anon,has_function_privilege('service_role','reserve_warranty_courtesy_inspection(uuid,uuid,text,date,uuid)','execute') service")).rows[0];assert.deepEqual(priv,{browser:false,anon:false,service:true})
})
test('coordinator attribution is permanent and revoked membership blocks even a replay',async t=>{
 const h=await fixture(t),actor=OTHER,second='00000000-0000-4000-8000-000000000005'
 await h.db.query('insert into app_users values($1),($2)',[actor,second])
 await h.db.query("insert into memberships values(gen_random_uuid(),$1,$2,'active'),(gen_random_uuid(),$1,$3,'active')",[ORG,actor,second])
 const reserve=async user=>(await h.db.query("select reserve_warranty_courtesy_inspection($1,$2,'day_30','2026-10-03',$3) result",[ORG,COVERAGE,user])).rows[0].result
 const first=await reserve(actor),replay=await reserve(second);assert.equal(first.request_id,replay.request_id)
 const row=(await h.db.query('select r.actor_id,r.origin,e.payload,a.actor_user_id from warranty_courtesy_reservations r join events e on e.id=r.event_id join audit_log a on a.id=r.audit_id')).rows[0]
 assert.equal(row.actor_id,actor);assert.equal(row.origin,'coordinator');assert.equal(row.payload.actor_id,actor);assert.equal(row.actor_user_id,actor)
 await h.db.query("update memberships set status='inactive' where user_id=$1",[second]);await assert.rejects(reserve(second),/active organization member/)
 assert.deepEqual(await h.counts(),{requests:1,events:1,audits:1,receipts:1})
})
test('replay refuses altered linked event or audit proof',async t=>{
 const h=await fixture(t);await h.reserve()
 await h.db.exec("update events set payload=jsonb_set(payload,'{project_id}','\"00000000-0000-4000-8000-000000000004\"')")
 await assert.rejects(h.reserve(),/event evidence changed/)
 await h.db.query("update events set payload=jsonb_set(payload,'{project_id}',to_jsonb($1::text))",[PROJECT])
 await h.db.exec("update audit_log set source='altered'")
 await assert.rejects(h.reserve(),/audit evidence changed/)
})
