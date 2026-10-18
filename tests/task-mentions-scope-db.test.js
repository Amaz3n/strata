const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
let PGlite
try { ({PGlite}=require(process.env.ARC_TEST_PGLITE_MODULE || '@electric-sql/pglite')) } catch {}
const id=n=>`10000000-0000-0000-0000-${String(n).padStart(12,'0')}`
test('task mention queue is atomic, access-scoped and deduplicated; scope preserves pricing revision', {skip:!PGlite}, async t=>{
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create role anon; create role authenticated; create schema auth;
 create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.actor',true),'')::uuid $$;
 create table app_users(id uuid primary key,full_name text);
 create table roles(id uuid primary key,key text,scope text);
 create table memberships(org_id uuid,user_id uuid,role_id uuid,status text);
 create table project_members(org_id uuid,project_id uuid,user_id uuid,status text);
 create table tasks(id uuid primary key,org_id uuid,project_id uuid,title text,metadata jsonb default '{}');
 create table notifications(id uuid primary key default gen_random_uuid(),org_id uuid,user_id uuid,notification_type text,payload jsonb);
 create table outbox(id bigint generated always as identity,org_id uuid,job_type text,payload jsonb,dedupe_key text unique);
 create table prospects(id uuid primary key,org_id uuid,notes text);
 create table precon_workspaces(prospect_id uuid primary key,org_id uuid,brief jsonb,version int,updated_by uuid);`)
 await db.query('insert into prospects values($1,$2,$3)',[id(10),id(1),'Original notes'])
 await db.query('insert into precon_workspaces values($1,$2,$3,3,null)',[id(10),id(1),{scope:'Legacy scope',pricing_worksheet:{saved:true}}])
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260923113548_task_mentions_and_prospect_scope.sql'),'utf8'))
 assert.equal((await db.query('select notes from prospects')).rows[0].notes,'Original notes\n\nLegacy scope')
 const before=(await db.query('select * from precon_workspaces')).rows[0]
 await db.query('update prospects set notes=$1 where id=$2',['Updated scope',id(10)])
 let workspace=(await db.query('select * from precon_workspaces')).rows[0]
 assert.equal(workspace.brief.scope,'Updated scope');assert.deepEqual(workspace.brief.pricing_worksheet,{saved:true});assert.equal(workspace.version,before.version+1);assert.equal(workspace.brief.pricing_revision,workspace.version)
 assert.equal((await db.query('update precon_workspaces set version=version+1 where prospect_id=$1 and version=$2 returning version',[id(10),before.version])).rows.length,0)
 await db.query('update prospects set notes=null where id=$1',[id(10)])
 assert.equal((await db.query('select brief from precon_workspaces')).rows[0].brief.scope,'')
 await db.query("update precon_workspaces set brief=jsonb_set(brief,'{scope}',to_jsonb('Stale scope'::text)) where prospect_id=$1",[id(10)])
 assert.equal((await db.query('select brief from precon_workspaces')).rows[0].brief.scope,'')
 await db.query("select set_config('test.actor',$1,false)",[id(2)])
 for(const n of [2,3,4,5]) await db.query('insert into app_users values($1,$2)',[id(n),'Person '+n])
 await db.query("insert into roles values($1,'org_member','org')",[id(6)])
 for(const n of [2,3,4]) await db.query("insert into memberships values($1,$2,$3,'active')",[id(1),id(n),id(6)])
 await db.query("insert into project_members values($1,$2,$3,'active')",[id(1),id(7),id(3)])
 const insert=(task,users)=>db.query('insert into tasks values($1,$2,$3,$4,$5)',[id(task),id(1),id(7),'Review plans',{mentioned_user_ids:users}])
 await insert(11,[id(3),id(3)])
 assert.equal((await db.query('select * from notifications')).rows.length,1)
 assert.equal((await db.query('select * from outbox')).rows.length,1)
 assert.equal((await db.query('select payload from notifications')).rows[0].payload.href,`/tasks?task=${id(11)}`)
 await db.query('update tasks set metadata=$1 where id=$2',[{mentioned_user_ids:[id(3)],checklist:[]},id(11)])
 assert.equal((await db.query('select * from outbox')).rows.length,1)
 await assert.rejects(()=>insert(12,[id(4)]),/cannot access/)
 await assert.rejects(()=>insert(13,[id(5)]),/cannot access/)
 assert.equal((await db.query('select * from tasks')).rows.length,1)
 // Force enqueue failure: both the task and notification must roll back.
 await db.exec("alter table outbox add constraint fail_queue check (job_type <> 'deliver_notification') not valid")
 await assert.rejects(()=>insert(14,[id(3)]),/fail_queue/)
 assert.equal((await db.query('select * from tasks')).rows.length,1)
 assert.equal((await db.query('select * from notifications')).rows.length,1)
 await db.exec('alter table outbox drop constraint fail_queue')
 await db.query("insert into project_members values($1,$2,$3,'active')",[id(1),id(7),id(2)])
 await insert(15,[id(2)])
 assert.equal((await db.query('select * from outbox')).rows.length,1)
})
