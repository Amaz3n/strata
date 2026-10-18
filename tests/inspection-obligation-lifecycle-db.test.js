require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG=id(1),HOME=id(2),ACTOR=id(3),REVIEWER=id(4),ROLE=id(5),INSP=id(6),ITEM=id(7),SLOT=id(8),PUNCH=id(9),CLOSING=id(10)
async function setup(t) {
 const db = new PGlite();t.after(() => db.close())
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create table orgs(id uuid primary key);create table app_users(id uuid primary key);
 create table roles(id uuid primary key,key text);create table permissions(key text primary key,description text);
 create table role_permissions(role_id uuid references roles(id),permission_key text references permissions(key),primary key(role_id,permission_key));
 create table projects(id uuid primary key,org_id uuid references orgs(id),division_id uuid);
 create table memberships(id uuid primary key default gen_random_uuid(),org_id uuid references orgs(id),user_id uuid references app_users(id),role_id uuid references roles(id),status text,project_scope text default 'all',division_scope text default 'all');
 create table project_members(id uuid primary key default gen_random_uuid(),org_id uuid references orgs(id),project_id uuid references projects(id),user_id uuid references app_users(id),role_id uuid references roles(id),status text);
 create table platform_memberships(id uuid primary key default gen_random_uuid(),user_id uuid references app_users(id),role_id uuid references roles(id),status text,expires_at timestamptz);
 create table membership_permission_overrides(membership_id uuid references memberships(id),permission_key text,effect text,primary key(membership_id,permission_key));
 create table membership_divisions(membership_id uuid references memberships(id),division_id uuid,primary key(membership_id,division_id));
 create table inspections(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,inspection_number integer,template_id uuid,kind text,title text,status text default 'draft',result text,inspected_at timestamptz,inspector_user_id uuid,inspector_name text,location text,location_id uuid,company_id uuid,schedule_item_id uuid,notes text,metadata jsonb default '{}',pdf_file_id uuid,updated_at timestamptz default now(),unique(project_id,inspection_number));
 create table inspection_items(id uuid primary key default gen_random_uuid(),org_id uuid,inspection_id uuid,section text,prompt text,response_type text,response text,is_deficient boolean default false,note text,photo_file_id uuid,punch_item_id uuid,observation_id uuid,sort_order integer);
 create table files(id uuid primary key,org_id uuid,project_id uuid,archived_at timestamptz);
 create table punch_items(id uuid primary key,org_id uuid,project_id uuid,status text,notes text);
 create table schedule_items(id uuid primary key,org_id uuid,project_id uuid,status text,progress integer);
 create table closings(id uuid primary key,org_id uuid,project_id uuid,status text);
 create table events(id uuid primary key default gen_random_uuid(),org_id uuid,event_type text,entity_type text,entity_id uuid,payload jsonb,channel text);
 create table audit_log(id bigint generated always as identity primary key,org_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,before_data jsonb,after_data jsonb,source text);
 create function next_inspection_number(p uuid) returns integer language sql set search_path=public,pg_catalog as $$select coalesce(max(inspection_number),0)+1 from inspections where project_id=p$$;`)
 await db.query('insert into orgs values($1)',[ORG]);await db.query('insert into app_users values($1),($2)',[ACTOR,REVIEWER]);await db.query("insert into roles values($1,'pm')",[ROLE]);await db.exec("insert into permissions(key) values('inspection.write'),('project.read'),('org.admin'),('*'),('platform.org.access')")
 await db.query("insert into role_permissions values($1,'inspection.write'),($1,'project.read')",[ROLE]);await db.query("insert into memberships(org_id,user_id,role_id,status) values($1,$2,$4,'active'),($1,$3,$4,'active')",[ORG,ACTOR,REVIEWER,ROLE]);await db.query('insert into projects values($1,$2,$3)',[HOME,ORG,id(11)])
 await db.query("insert into inspections(id,org_id,project_id,inspection_number,kind,title,schedule_item_id) values($1,$2,$3,1,'quality','Final inspection',$4)",[INSP,ORG,HOME,SLOT]);await db.query("insert into inspection_items(id,org_id,inspection_id,prompt,response_type,response,sort_order) values($1,$2,$3,'Guardrails','yes_no','yes',0)",[ITEM,ORG,INSP]);await db.query("insert into schedule_items values($1,$2,$3,'in_progress',50)",[SLOT,ORG,HOME]);await db.query("insert into closings values($1,$2,$3,'scheduled')",[CLOSING,ORG,HOME])
 await db.exec(fs.readFileSync('supabase/migrations/20261005031540_inspection_obligation_lifecycle.sql','utf8'))
 const source = async (insp=INSP) => (await db.query('select inspection_review_source($1,$2) v',[ORG,insp])).rows[0].v
 const rpc = async (name,args) => { await db.exec('set role service_role');try{return (await db.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,args)).rows[0].v}finally{await db.exec('reset role')} }
 const complete = async (insp=INSP,body=null,actor=ACTOR) => rpc('complete_inspection_attempt',[ORG,HOME,insp,actor,JSON.stringify(body??await source(insp))])
 const mutate = async (body,key=id(100),actor=ACTOR) => rpc('mutate_inspection_obligation',[ORG,HOME,actor,key,JSON.stringify(body)])
 const create = async () => mutate({operation:'create',inspectionId:INSP,source:await source()})
 const close = () => db.exec("update closings set status='closed'")
 return {db,source,complete,mutate,create,close,rpc}
}
test('required pass waits for independent review; acceptance advances schedule and closing',async t=>{
 const h=await setup(t),o=await h.create();await h.complete()
 assert.equal((await h.db.query('select status from schedule_items')).rows[0].status,'in_progress')
 await assert.rejects(h.close(),/not been accepted/)
 const request={operation:'accept',obligationId:o.obligationId,inspectionId:INSP,source:await h.source(),reviewNote:'Reviewed original checklist and evidence'}
 await assert.rejects(h.mutate(request,id(101)),/independent reviewer/)
 await h.mutate(request,id(101),REVIEWER);await h.close()
 assert.equal((await h.db.query('select status from schedule_items')).rows[0].status,'completed')
 assert.equal((await h.db.query('select status from closings')).rows[0].status,'closed')
})
test('failure preserves original evidence through corrective punch work and accepted reinspection',async t=>{
 const h=await setup(t);await h.db.exec("update inspection_items set response='no',is_deficient=true")
 const o=await h.create();await h.complete();const original=await h.source()
 const request={operation:'reinspect',obligationId:o.obligationId,inspectionId:INSP,source:original,correctionLinks:[{failedItemId:ITEM,punchId:null}],correctionNote:'Guardrails repaired and photographed'}
 await assert.rejects(h.mutate(request,id(102)),/Resolve the linked corrective/)
 await h.db.query("insert into punch_items values($1,$2,$3,'resolved','Guardrails repaired')",[PUNCH,ORG,HOME]);await h.db.query('update inspection_items set punch_item_id=$1 where id=$2',[PUNCH,ITEM])
 const next=await h.mutate({...request,correctionLinks:[{failedItemId:ITEM,punchId:PUNCH}]},id(108));assert.equal(next.attemptNumber,2)
 assert.deepEqual(await h.source(),original)
 await h.db.query("update inspection_items set response='yes' where inspection_id=$1",[next.inspectionId]);await h.complete(next.inspectionId)
 await assert.rejects(h.mutate({operation:'accept',obligationId:o.obligationId,inspectionId:INSP,source:original,reviewNote:'Review earlier attempt'},id(103),REVIEWER),/newer attempt/)
 await h.mutate({operation:'accept',obligationId:o.obligationId,inspectionId:next.inspectionId,source:await h.source(next.inspectionId),reviewNote:'Accepted repair and verified new checklist'},id(103),REVIEWER)
 await h.close();assert.equal((await h.db.query('select result from inspections where id=$1',[INSP])).rows[0].result,'fail')
 assert.equal((await h.db.query('select count(*)::int n from inspection_completion_receipts')).rows[0].n,2)
})
test('legacy completion/status and completed evidence edits cannot bypass atomic owner',async t=>{
 const h=await setup(t)
 await assert.rejects(h.db.exec("update inspections set status='completed',result='pass'"),/original atomic receipt/)
 await h.complete()
 for(const sql of ["update inspection_items set response='no'","delete from inspection_items","update inspections set notes='Changed'","delete from inspections"])
  await assert.rejects(h.db.exec(sql),/immutable/)
 await assert.rejects(h.db.exec('delete from inspection_completion_receipts'),/history is immutable/)
})
test('request retry is exact and changed source or revoked permission fails without partial writes',async t=>{
 const h=await setup(t),source=await h.source();await h.db.exec("update inspection_items set response='no'")
 await assert.rejects(h.complete(INSP,source),/source changed/)
 assert.equal((await h.db.query('select count(*)::int n from inspection_completion_receipts')).rows[0].n,0)
 const request={operation:'create',inspectionId:INSP,source:await h.source()};const first=await h.mutate(request)
 assert.deepEqual(await h.mutate(request),first)
 await assert.rejects(h.mutate({...request,extra:true}),/different original request/)
 await h.db.exec("delete from role_permissions where permission_key='inspection.write'")
 await assert.rejects(h.complete(),/permission/)
})
test('failed schedule handoff rolls back completion, event, audit and receipt',async t=>{
 const h=await setup(t);await h.db.exec("update schedule_items set status='cancelled'")
 await assert.rejects(h.complete(),/scheduled work changed/)
 assert.equal((await h.db.query('select status from inspections')).rows[0].status,'draft')
 for(const table of ['events','audit_log','inspection_completion_receipts']) assert.equal((await h.db.query(`select count(*)::int n from ${table}`)).rows[0].n,0)
})
test('raw schedule completion cannot bypass an unaccepted obligation',async t=>{
 const h=await setup(t);await h.create();await h.complete()
 await assert.rejects(h.db.exec("update schedule_items set status='completed',progress=100"),/not been accepted/)
 assert.equal((await h.db.query('select status from schedule_items')).rows[0].status,'in_progress')
})
test('same-home scope and authenticated actor identity are enforced inside RPC',async t=>{
 const h=await setup(t);await h.db.exec(`set role authenticated;set test.actor='${ACTOR}'`)
 await assert.rejects(h.db.query('select read_inspection_obligations($1,$2,$3)',[ORG,HOME,REVIEWER]),/identity differs/)
 await h.db.exec('reset role;reset test.actor')
 await h.db.exec("update memberships set division_scope='assigned'")
 await assert.rejects(h.create(),/division access/)
})
test('rejected passing review can start a linked replacement without erasing the original attempt',async t=>{
 const h=await setup(t),o=await h.create();await h.complete()
 await h.mutate({operation:'reject',obligationId:o.obligationId,inspectionId:INSP,source:await h.source(),reviewNote:'Photographic evidence needs a further field visit'},id(104),REVIEWER)
 const next=await h.mutate({operation:'reinspect',obligationId:o.obligationId,inspectionId:INSP,source:await h.source(),correctionLinks:[],correctionNote:'New site visit with the required evidence'},id(105))
 assert.equal(next.attemptNumber,2)
 assert.equal((await h.db.query('select result from inspections where id=$1',[INSP])).rows[0].result,'pass')
 await assert.rejects(h.close(),/not been accepted/)
})
test('reopened corrective work and altered completion audit cannot satisfy closing',async t=>{
 const h=await setup(t);await h.db.exec("update inspection_items set is_deficient=true,response='no'")
 const o=await h.create();await h.complete();await h.db.query("insert into punch_items values($1,$2,$3,'resolved','Original repair')",[PUNCH,ORG,HOME]);await h.db.query('update inspection_items set punch_item_id=$1',[PUNCH])
 const next=await h.mutate({operation:'reinspect',obligationId:o.obligationId,inspectionId:INSP,source:await h.source(),correctionLinks:[{failedItemId:ITEM,punchId:PUNCH}],correctionNote:'Documented corrective work completed'},id(106))
 await h.db.query("update inspection_items set response='yes' where inspection_id=$1",[next.inspectionId]);await h.complete(next.inspectionId)
 await h.mutate({operation:'accept',obligationId:o.obligationId,inspectionId:next.inspectionId,source:await h.source(next.inspectionId),reviewNote:'Accepted independent verification evidence'},id(107),REVIEWER)
 await h.db.exec("update punch_items set status='open'");await assert.rejects(h.close(),/corrective work is reopened/)
 await h.db.exec("update punch_items set status='resolved';update audit_log set after_data='{}' where source='inspection_completion_transaction'")
 await assert.rejects(h.close(),/audit evidence changed/)
})
test('required-inspection discovery is bounded, scoped and resolves an off-page selected attempt',async t=>{
 const h=await setup(t)
 for(let n=200;n<225;n++) {
  await h.db.query("insert into inspections(id,org_id,project_id,inspection_number,kind,title) values($1,$2,$3,$4,'quality','Required test')",[id(n),ORG,HOME,n])
  await h.db.query('insert into inspection_obligations(id,org_id,project_id,source_inspection_id,title,created_by) values($1,$2,$3,$4,$5,$6)',[id(n+1000),ORG,HOME,id(n),'Required test',ACTOR])
  await h.db.query('insert into inspection_attempts(inspection_id,org_id,obligation_id,attempt_number,created_by) values($1,$2,$3,1,$4)',[id(n),ORG,id(n+1000),ACTOR])
 }
 const first=await h.rpc('read_inspection_obligations',[ORG,HOME,ACTOR,null,20,null])
 assert.equal(first.rows.length,20);assert.ok(first.nextCursor)
 const second=await h.rpc('read_inspection_obligations',[ORG,HOME,ACTOR,first.nextCursor,20,null])
 assert.equal(second.rows.length,5);assert.equal(second.nextCursor,null)
 const selected=await h.rpc('read_inspection_obligations',[ORG,HOME,ACTOR,null,20,id(224)])
 assert.equal(selected.rows.length,1);assert.equal(selected.rows[0].source_inspection_id,id(224))
 await assert.rejects(h.rpc('read_inspection_obligations',[ORG,HOME,ACTOR,null,51,null]),/page size/)
})
test('a fail response cannot become pass by clearing its deficiency flag',async t=>{
 const h=await setup(t);await h.db.exec("update inspection_items set response_type='pass_fail',response='fail',is_deficient=false")
 assert.equal((await h.complete()).result,'fail')
 assert.equal((await h.db.query('select status from schedule_items')).rows[0].status,'in_progress')
})
test('revoked tenant membership and project-only write grants do not bypass the original organization gate',async t=>{
 const h=await setup(t);await h.db.query("insert into project_members(org_id,project_id,user_id,role_id,status) values($1,$2,$3,$4,'active')",[ORG,HOME,ACTOR,ROLE])
 await h.db.query("update memberships set status='inactive' where user_id=$1",[ACTOR]);await assert.rejects(h.complete(),/no active organization membership/)
 assert.equal((await h.db.query('select count(*)::int n from inspection_completion_receipts')).rows[0].n,0)
})

test('plan provenance and observed location changes invalidate the reviewed completion source',async t=>{
 const h=await setup(t),source=await h.source()
 await h.db.exec("update inspections set metadata='{\"source_plan_version\":\"changed\"}',location='Moved field area'")
 await assert.rejects(h.complete(INSP,source),/source changed/)
 assert.equal((await h.db.query('select status from inspections')).rows[0].status,'draft')
})

test('reinspection rejects corrective association changes instead of substituting other resolved work',async t=>{
 const h=await setup(t);await h.db.exec("update inspection_items set is_deficient=true,response='no'")
 const o=await h.create();await h.complete();await h.db.query("insert into punch_items values($1,$2,$3,'resolved','Completed repair')",[PUNCH,ORG,HOME]);await h.db.query('update inspection_items set punch_item_id=$1',[PUNCH])
 await assert.rejects(h.mutate({operation:'reinspect',obligationId:o.obligationId,inspectionId:INSP,source:await h.source(),correctionLinks:[{failedItemId:ITEM,punchId:null}],correctionNote:'Earlier assignment reviewed before change'},id(120)),/corrective work links changed/)
 assert.equal((await h.db.query('select count(*)::int n from inspection_attempts')).rows[0].n,1)
})
test('failed response still requires its reviewed corrective punch association when the flag is false',async t=>{
 const h=await setup(t);await h.db.exec("update inspection_items set response_type='pass_fail',response='fail',is_deficient=false")
 const o=await h.create();await h.complete()
 await assert.rejects(h.mutate({operation:'reinspect',obligationId:o.obligationId,inspectionId:INSP,source:await h.source(),correctionLinks:[{failedItemId:ITEM,punchId:null}],correctionNote:'Corrected work awaiting linked resolution'},id(121)),/Resolve the linked corrective/)
})

test('inserting an already-closed record cannot bypass required inspection readiness',async t=>{
 const h=await setup(t);await h.create()
 await assert.rejects(h.db.query("insert into closings values($1,$2,$3,'closed')",[id(130),ORG,HOME]),/not been accepted/)
 assert.equal((await h.db.query('select count(*)::int n from closings')).rows[0].n,1)
})
