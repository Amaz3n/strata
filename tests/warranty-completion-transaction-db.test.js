require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')
const ORG='00000000-0000-4000-8000-000000000001', HOME='00000000-0000-4000-8000-000000000002', VISIT='00000000-0000-4000-8000-000000000003', REQUEST='00000000-0000-4000-8000-000000000004', ACTOR='00000000-0000-4000-8000-000000000005', FILE='00000000-0000-4000-8000-000000000006'
const REV='2026-10-03T00:00:00Z'
async function fixture(t, guards=false) {
 const db=new PGlite(); t.after(()=>db.close())
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create table orgs(id uuid primary key); create table app_users(id uuid primary key);
 create table roles(id uuid primary key);
 create table permissions(key text primary key);
 create table role_permissions(role_id uuid references roles(id),permission_key text references permissions(key),primary key(role_id,permission_key));
 create table memberships(id uuid primary key default gen_random_uuid(),org_id uuid references orgs(id),user_id uuid references app_users(id),role_id uuid references roles(id),status text,project_scope text default 'all',division_scope text default 'all');
 create table projects(id uuid primary key,org_id uuid references orgs(id),division_id uuid);
 create table project_members(id uuid primary key default gen_random_uuid(),org_id uuid references orgs(id),project_id uuid references projects(id),user_id uuid references app_users(id),role_id uuid references roles(id),status text);
 create table platform_memberships(id uuid primary key default gen_random_uuid(),user_id uuid references app_users(id),role_id uuid references roles(id),status text,expires_at timestamptz);
 create table membership_permission_overrides(membership_id uuid references memberships(id),permission_key text,effect text,primary key(membership_id,permission_key));
 create table membership_divisions(membership_id uuid references memberships(id),division_id uuid,primary key(membership_id,division_id));
 create table warranty_requests(id uuid primary key,org_id uuid,project_id uuid,status text,closed_at timestamptz,metadata jsonb,updated_at timestamptz);
 create table warranty_service_visits(id uuid primary key,org_id uuid,project_id uuid,request_id uuid,status text,outcome text,outcome_note text,completed_at timestamptz,completed_by uuid,buyer_signoff_name text,buyer_signoff_at timestamptz,buyer_signature_file_id uuid,labor_hours numeric,labor_rate_cents bigint,internal_labor_cents bigint,internal_material_cents bigint,updated_at timestamptz);
 create table files(id uuid primary key,org_id uuid,project_id uuid,archived_at timestamptz);
 create table warranty_visit_photos(org_id uuid,visit_id uuid,file_id uuid,created_by uuid,unique(visit_id,file_id));
 create table events(id uuid primary key default gen_random_uuid(),org_id uuid,event_type text,entity_type text,entity_id uuid,payload jsonb,channel text);
 create table audit_log(id bigint generated always as identity primary key,org_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,before_data jsonb,after_data jsonb,source text);`)
 await db.query('insert into orgs values($1)',[ORG]); await db.query('insert into app_users values($1),($2)',[ACTOR,FILE]); await db.query('insert into roles values($1),($2),($3)',[HOME,VISIT,FILE]); await db.exec("insert into permissions values('warranty.write'),('project.read'),('project.manage'),('*'),('org.admin'),('platform.org.access');"); await db.query("insert into role_permissions values($1,'warranty.write'),($1,'project.read')",[HOME]); await db.query("insert into memberships(org_id,user_id,role_id,status) values($1,$2,$4,'active'),($1,$3,$4,'active')",[ORG,ACTOR,FILE,HOME]); await db.query('insert into projects(id,org_id,division_id) values($1,$2,$3)',[HOME,ORG,REQUEST]); await db.query("insert into warranty_requests values($1,$2,$3,'open',null,'{\"earlierNote\":true}',$4)",[REQUEST,ORG,HOME,REV]); await db.query("insert into warranty_service_visits(id,org_id,project_id,request_id,status,updated_at) values($1,$2,$3,$4,'scheduled',$5)",[VISIT,ORG,HOME,REQUEST,REV]); await db.query('insert into files values($1,$2,$3,null)',[FILE,ORG,HOME])
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261003051000_warranty_visit_completion_receipts.sql'),'utf8'))
 if (guards) {
  await db.exec(`alter table warranty_service_visits add column metadata jsonb default '{}',add column books_cost_journal_entry_id uuid,add column visit_number integer default 1,add column window_start timestamptz default '2026-10-03',add column window_end timestamptz default '2026-10-04',add column assigned_user_id uuid;
   alter table warranty_visit_photos add column caption text,add column created_at timestamptz default now();
   alter table files add column storage_path text default 'evidence/photo.jpg',add column checksum text default 'original',add column current_version_id uuid,add column size_bytes bigint default 100,add column mime_type text default 'image/jpeg',add column uploaded_by uuid,add column file_name text,add column folder_path text;`)
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261003052000_warranty_completion_evidence_guards.sql'),'utf8'))
 }
 const input={outcome:'resolved',outcome_note:'Repaired leak',photo_file_ids:[FILE,FILE],labor_hours:1.5,labor_rate_cents:1001,material_cents:200}
 const complete=async(data=input,actor=ACTOR,org=ORG)=>(await db.query('select complete_warranty_visit_atomic($1,$2,$3,$4,$4,$5) result',[org,VISIT,actor,REV,JSON.stringify(data)])).rows[0].result
 const counts=async()=>(await db.query('select (select count(*)::int from warranty_visit_photos) photos,(select count(*)::int from events) events,(select count(*)::int from audit_log) audits,(select count(*)::int from warranty_visit_completion_receipts) receipts')).rows[0]
 return {db,input,complete,counts}
}
test('completion commits all evidence once and retry preserves original actor and later follow-up',async t=>{
 const h=await fixture(t),first=await h.complete(); assert.equal(first.status,'created')
 assert.deepEqual(await h.counts(),{photos:1,events:1,audits:1,receipts:1})
 const visit=(await h.db.query('select * from warranty_service_visits')).rows[0]; assert.equal(visit.status,'completed'); assert.equal(Number(visit.internal_labor_cents),1502)
 const request=(await h.db.query('select * from warranty_requests')).rows[0]; assert.equal(request.status,'resolved');assert.equal(request.metadata.earlierNote,true)
 await h.db.exec("update warranty_requests set status='in_progress',metadata='{\"newFollowUp\":true}'")
 const replay=await h.complete({...h.input,photo_file_ids:[FILE]},FILE);assert.equal(replay.status,'existing');assert.equal(replay.receipt_id,first.receipt_id);assert.equal(replay.actor_id,ACTOR)
 assert.equal((await h.db.query('select metadata from warranty_requests')).rows[0].metadata.newFollowUp,true)
 assert.deepEqual(await h.counts(),{photos:1,events:1,audits:1,receipts:1})
})
test('failure while persisting audit rolls back visit, photos, request, event and receipt together',async t=>{
 const h=await fixture(t); await h.db.exec("alter table audit_log add constraint reject_test_audit check(source<>'warranty_completion_transaction')")
 await assert.rejects(h.complete(),/reject_test_audit/)
 assert.deepEqual(await h.counts(),{photos:0,events:0,audits:0,receipts:0})
 assert.equal((await h.db.query('select status from warranty_service_visits')).rows[0].status,'scheduled')
 assert.equal((await h.db.query('select status from warranty_requests')).rows[0].status,'open')
 await h.db.exec('alter table audit_log drop constraint reject_test_audit');assert.equal((await h.complete()).status,'created')
})
test('home ancestry, active file scope, membership and stale revisions reject before mutation',async t=>{
 for(const [sql,pattern] of [
  ["update warranty_service_visits set project_id='00000000-0000-4000-8000-000000000006'",/ancestry|unavailable/],
  ["update files set project_id='00000000-0000-4000-8000-000000000006'",/active home/],
  ["update files set archived_at=now()",/active home/],
  ["update memberships set status='inactive'",/organization write permission/],
  ["update warranty_service_visits set updated_at=now()",/revision/],
  ["update warranty_requests set updated_at=now()",/revision/],
  ["update warranty_requests set status='closed'",/current state/],
 ]) {
  const h=await fixture(t);await h.db.exec(sql);await assert.rejects(h.complete(),pattern);assert.deepEqual(await h.counts(),{photos:0,events:0,audits:0,receipts:0})
 }
})
test('immutable receipt and restrictive source links preserve completion history',async t=>{
 const h=await fixture(t);await h.complete()
 await assert.rejects(h.db.exec('delete from warranty_visit_completion_receipts'),/immutable/)
 await assert.rejects(h.db.exec("update warranty_visit_completion_receipts set input='{}'"),/immutable/)
 for(const table of ['warranty_service_visits','warranty_requests','events','audit_log'])await assert.rejects(h.db.exec(`delete from ${table}`),/foreign key/)
})
test('different retry input or changed recorded visit/event/audit/photos requires reconciliation',async t=>{
 const h=await fixture(t);await h.complete();await assert.rejects(h.complete({...h.input,material_cents:300}),/differs from original receipt/)
 for(const [sql,pattern] of [
  ["update warranty_service_visits set internal_material_cents=999",/completion evidence changed/],
  ["update events set payload='{}'",/event evidence changed/],
  ["update audit_log set after_data='{}'",/audit evidence changed/],
  ["delete from warranty_visit_photos",/photo evidence changed/],
 ]) {const item=await fixture(t);await item.complete();await item.db.exec(sql);await assert.rejects(item.complete(),pattern)}
})
test('invalid costs, outcomes and photo limits cannot leave partial work',async t=>{
 for(const input of [{outcome:'invalid'},{outcome:'resolved',labor_hours:1},{outcome:'resolved',outcome_note:123},{outcome:'resolved',labor_hours:25},{outcome:'resolved',labor_rate_cents:1.5},{outcome:'resolved',material_cents:-1},{outcome:'resolved',material_cents:'100'},{outcome:'resolved',photo_file_ids:Array(21).fill(FILE)}]){
  const h=await fixture(t);await assert.rejects(h.complete(input),/invalid|numeric|limit|required|strings/);assert.deepEqual(await h.counts(),{photos:0,events:0,audits:0,receipts:0})
 }
})
test('completion transaction and receipt storage are service-only',async t=>{
 const h=await fixture(t)
 const privileges=(await h.db.query("select has_function_privilege('authenticated','complete_warranty_visit_atomic(uuid,uuid,uuid,timestamptz,timestamptz,jsonb)','execute') rpc,has_table_privilege('authenticated','warranty_visit_completion_receipts','insert') receipt,has_function_privilege('service_role','complete_warranty_visit_atomic(uuid,uuid,uuid,timestamptz,timestamptz,jsonb)','execute') worker")).rows[0]
 assert.deepEqual(privileges,{rpc:false,receipt:false,worker:true})
})
test('requested permission denies override wildcard/grants and revoked permission also blocks receipt replay',async t=>{
 for(const kind of ['wildcard','grant','replay']) {
  const h=await fixture(t)
  if(kind==='wildcard') await h.db.query("insert into role_permissions values($1,'*')",[HOME])
  if(kind==='replay') await h.complete()
  await h.db.query("insert into membership_permission_overrides select id,'warranty.write','deny' from memberships where user_id=$1",[ACTOR])
  await assert.rejects(h.complete(),/organization write permission/)
  assert.equal((await h.counts()).receipts,kind==='replay'?1:0)
 }
 const h=await fixture(t);await h.db.query("delete from role_permissions where permission_key='warranty.write'")
 await assert.rejects(h.complete(),/organization write permission/)
 await h.db.query("insert into membership_permission_overrides select id,'warranty.write','grant' from memberships where user_id=$1",[ACTOR])
 assert.equal((await h.complete()).status,'created')
})
test('assigned-project policy requires an active same-org project membership unless wildcard/admin grants access',async t=>{
 for(const kind of ['none','inactive','foreign-org','active','wildcard','admin']){
  const h=await fixture(t);await h.db.query("update memberships set project_scope='assigned' where user_id=$1",[ACTOR])
  if(['inactive','foreign-org','active'].includes(kind)) {
   if(kind==='foreign-org')await h.db.query('insert into orgs values($1)',[FILE])
   await h.db.query('insert into project_members(org_id,project_id,user_id,role_id,status) values($1,$2,$3,$4,$5)',[kind==='foreign-org'?FILE:ORG,HOME,ACTOR,VISIT,kind==='inactive'?'inactive':'active'])
  }
  if(kind==='wildcard'||kind==='admin')await h.db.query('insert into role_permissions values($1,$2)',[HOME,kind==='wildcard'?'*':'org.admin'])
  if(['active','wildcard','admin'].includes(kind))assert.equal((await h.complete()).status,'created')
  else {await assert.rejects(h.complete(),/assigned project access/);assert.equal((await h.counts()).receipts,0)}
 }
})
test('division assignments restrict wildcard users, raw admin role bypasses scope, grant-only admin does not',async t=>{
 for(const kind of ['missing','wrong','null-home','assigned','base-admin','grant-admin']){
  const h=await fixture(t);await h.db.query("update memberships set division_scope='assigned' where user_id=$1",[ACTOR])
  await h.db.query("insert into role_permissions values($1,'*')",[HOME])
  if(kind==='assigned'||kind==='wrong')await h.db.query('insert into membership_divisions select id,$2 from memberships where user_id=$1',[ACTOR,kind==='assigned'?REQUEST:FILE])
  if(kind==='null-home')await h.db.exec('update projects set division_id=null')
  if(kind==='base-admin')await h.db.query("insert into role_permissions values($1,'org.admin')",[HOME])
  if(kind==='grant-admin')await h.db.query("insert into membership_permission_overrides select id,'org.admin','grant' from memberships where user_id=$1",[ACTOR])
  if(['assigned','base-admin'].includes(kind))assert.equal((await h.complete()).status,'created')
  else {await assert.rejects(h.complete(),/division access/);assert.equal((await h.counts()).receipts,0)}
 }
})
test('platform org access follows current membership expiry and overrides organization restrictions',async t=>{
 for(const kind of ['active','expired','inactive']){
  const h=await fixture(t)
  await h.db.query("insert into role_permissions values($1,'platform.org.access')",[FILE])
  await h.db.query('insert into platform_memberships(user_id,role_id,status,expires_at) values($1,$2,$3,$4)',[ACTOR,FILE,kind==='inactive'?'inactive':'active',kind==='expired'?'2000-01-01':null])
  await h.db.query("update memberships set division_scope='assigned',project_scope='assigned' where user_id=$1",[ACTOR])
  await h.db.query("insert into membership_permission_overrides select id,'warranty.write','deny' from memberships where user_id=$1",[ACTOR])
  if(kind==='active')assert.equal((await h.complete()).status,'created')
  else {await assert.rejects(h.complete(),/organization write permission/);assert.equal((await h.counts()).receipts,0)}
 }
})
test('project-only grants cannot bypass the office organization gate and catalog must be registered',async t=>{
 const h=await fixture(t);await h.db.exec("delete from role_permissions where permission_key='warranty.write'")
 await h.db.query("insert into role_permissions values($1,'warranty.write')",[VISIT]);await h.db.query("insert into project_members(org_id,project_id,user_id,role_id,status) values($1,$2,$3,$4,'active')",[ORG,HOME,ACTOR,VISIT])
 await assert.rejects(h.complete(),/organization write permission/)
 await h.db.exec("delete from role_permissions where permission_key='warranty.write';delete from permissions where key='warranty.write'")
 await assert.rejects(h.complete(),/not registered/)
 assert.deepEqual(await h.counts(),{photos:0,events:0,audits:0,receipts:0})
})
test('sealed visits keep completion/identity/schedule/cost evidence but permit accounting metadata and later request work',async t=>{
 const h=await fixture(t,true);await h.complete()
 for(const change of ["status='scheduled'","outcome_note='Rewritten'","internal_material_cents=999","project_id='00000000-0000-4000-8000-000000000006'","request_id='00000000-0000-4000-8000-000000000006'","visit_number=2","window_start=now()","assigned_user_id='00000000-0000-4000-8000-000000000006'","completed_by=null"]){
  await assert.rejects(h.db.exec(`update warranty_service_visits set ${change}`),/immutable/)
 }
 await assert.rejects(h.db.exec('delete from warranty_service_visits'),/cannot be deleted/)
 await h.db.query("update warranty_service_visits set metadata='{\"booksReviewed\":true}',books_cost_journal_entry_id=$1,updated_at=now()",[FILE])
 await h.db.exec("update warranty_requests set status='in_progress',metadata='{\"followUp\":true}'")
 assert.equal((await h.complete()).status,'existing')
 assert.equal((await h.db.query('select metadata from warranty_requests')).rows[0].metadata.followUp,true)
})
test('sealed photo identity and attribution cannot change, disappear or gain photos while captions remain editable',async t=>{
 const h=await fixture(t,true);await h.complete()
 for(const change of ["file_id='00000000-0000-4000-8000-000000000005'","org_id='00000000-0000-4000-8000-000000000005'","visit_id='00000000-0000-4000-8000-000000000005'","created_by=null","created_at=now()"])
  await assert.rejects(h.db.exec(`update warranty_visit_photos set ${change}`),/immutable/)
 await assert.rejects(h.db.exec('delete from warranty_visit_photos'),/cannot be deleted/)
 await assert.rejects(h.db.query('insert into warranty_visit_photos(org_id,visit_id,file_id) values($1,$2,$3)',[ORG,VISIT,ACTOR]),/immutable/)
 await h.db.query("insert into warranty_service_visits(id,org_id,project_id,request_id,status,updated_at) values($1,$2,$3,$4,'scheduled',$5)",[ACTOR,ORG,HOME,REQUEST,REV])
 await h.db.query('insert into warranty_visit_photos(org_id,visit_id,file_id) values($1,$2,$3)',[ORG,ACTOR,FILE])
 await assert.rejects(h.db.query('update warranty_visit_photos set visit_id=$1 where visit_id=$2',[VISIT,ACTOR]),/immutable/)
 await h.db.exec("update warranty_visit_photos set caption='Original completed repair'")
 assert.equal((await h.complete()).status,'existing')
})
test('sealed event and audit cannot be rewritten while unrelated activity remains editable',async t=>{
 const h=await fixture(t,true);await h.complete()
 for(const sql of ["update events set payload='{}'","update events set org_id='00000000-0000-4000-8000-000000000006'","update audit_log set after_data='{}'","update audit_log set actor_user_id=null"])
  await assert.rejects(h.db.exec(sql),/immutable/)
 for(const table of ['events','audit_log'])await assert.rejects(h.db.exec(`delete from ${table}`),/cannot be deleted/)
 await h.db.query("insert into events(org_id,event_type) values($1,'unrelated')",[ORG]);await h.db.exec("update events set payload='{}' where event_type='unrelated'")
 assert.equal((await h.complete()).status,'existing')
})
test('sealed photo and signature file identity/version/digest cannot change or be archived/deleted',async t=>{
 for(const useSignature of [false,true]) {
  const h=await fixture(t,true)
  await h.complete({...h.input,photo_file_ids:useSignature?[]:[FILE],buyer_signature_file_id:useSignature?FILE:null})
  for(const change of ["storage_path='replacement.jpg'","checksum='different'","current_version_id='00000000-0000-4000-8000-000000000005'","size_bytes=200","mime_type='application/pdf'","archived_at=now()","org_id='00000000-0000-4000-8000-000000000005'","project_id='00000000-0000-4000-8000-000000000005'"])
   await assert.rejects(h.db.exec(`update files set ${change}`),/immutable/)
  await assert.rejects(h.db.exec('delete from files'),/cannot be deleted/)
  await h.db.exec("update files set file_name='Repair evidence',folder_path='/warranty'")
 }
})
test('unsealed visit/file/photo sources retain ordinary mutation behavior',async t=>{
 const h=await fixture(t,true)
 await h.db.exec("update warranty_service_visits set outcome_note='Draft note';update files set checksum='pre-completion',storage_path='draft.jpg'")
 await h.db.query('insert into warranty_visit_photos(org_id,visit_id,file_id) values($1,$2,$3)',[ORG,VISIT,FILE])
 await h.db.exec('delete from warranty_visit_photos')
 assert.equal((await h.complete()).status,'created')
})
