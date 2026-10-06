const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`
const ORG=id(1), ACTOR=id(2), ROLE=id(3), DIV=id(4), COMM=id(5), COMP=id(6), OTHER=id(7), HOME=id(20)
const sql = 'supabase/migrations/20261005105415_trade_lookahead_database_workspace.sql'
async function fixture(t) {
  const db = new PGlite(); t.after(()=>db.close())
  // Explicit partial-schema fixture, not full-chain/JWT/RLS or multi-session acceptance.
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table app_users(id uuid primary key);create table permissions(key text primary key);create table roles(id uuid primary key);
    create table role_permissions(role_id uuid references roles,permission_key text);
    create table memberships(id uuid primary key,org_id uuid,user_id uuid,role_id uuid references roles,status text,project_scope text default 'all',division_scope text default 'all');
    create table membership_permission_overrides(membership_id uuid references memberships,permission_key text,effect text);
    create table membership_divisions(membership_id uuid references memberships,division_id uuid);
    create table platform_memberships(user_id uuid,role_id uuid references roles,status text,expires_at timestamptz);
    create table projects(id uuid primary key,org_id uuid,division_id uuid,property_type text,status text);
    create table project_members(org_id uuid,project_id uuid,user_id uuid,role_id uuid,status text);
    create table communities(id uuid primary key,org_id uuid,name text);
    create table lots(id uuid primary key,org_id uuid,project_id uuid,community_id uuid,lot_number text,block text);
    create table companies(id uuid primary key,org_id uuid,name text);
    create table schedule_items(id uuid primary key,org_id uuid,project_id uuid,name text,trade text,status text,start_date date,end_date date,cost_code_id uuid);
    create table schedule_assignments(id uuid primary key,org_id uuid,project_id uuid,schedule_item_id uuid,company_id uuid,confirmed_at timestamptz);
    create table commitments(id uuid primary key,org_id uuid,project_id uuid,company_id uuid,commitment_type text);
    create table commitment_lines(id uuid primary key,org_id uuid,commitment_id uuid,cost_code_id uuid);`)
  await db.query('insert into app_users values($1),($2)',[ACTOR,OTHER])
  await db.query('insert into roles values($1),($2)',[ROLE,OTHER])
  await db.exec("insert into permissions values('start.read'),('project.read');")
  await db.query("insert into role_permissions values($1,'start.read'),($1,'project.read')",[ROLE])
  await db.query("insert into memberships(id,org_id,user_id,role_id,status) values($1,$2,$3,$4,'active')",[ACTOR,ORG,ACTOR,ROLE])
  await db.query("insert into projects values($1,$2,$3,'production','active'),($4,$2,$5,'production','active'),($6,$5,$3,'production','active'),($7,$2,$3,'commercial','active')",[HOME,ORG,DIV,id(21),OTHER,id(22),id(23)])
  await db.query("insert into communities values($1,$2,'Community'),($3,$2,'Other community')",[COMM,ORG,OTHER])
  await db.query("insert into lots values($1,$2,$3,$4,'47',null),($5,$2,$6,$7,'48',null)",[id(30),ORG,HOME,COMM,id(31),id(21),OTHER])
  await db.query("insert into companies values($1,$2,'Partner'),($3,$2,'Other partner')",[COMP,ORG,OTHER])
  for (let i=0;i<117;i++) await db.query("insert into schedule_items values($1,$2,$3,$4,$5,'planned',current_date,current_date+1,$6)",[id(100+i),ORG,HOME,`Task ${i}`,`G${String(i).padStart(3,'0')}`,id(9)])
  for (let i=0;i<116;i++) await db.query("insert into schedule_items values($1,$2,$3,$4,'G116','planned',current_date,current_date+1,$5)",[id(400+i),ORG,HOME,`Extra ${i}`,id(9)])
  await db.query("insert into schedule_assignments select id,org_id,project_id,id,$1,case when name='Task 116' then now() end from schedule_items",[COMP])
  await db.exec(fs.readFileSync(sql,'utf8'))
  async function read(options={}, actor=ACTOR, role='authenticated') {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor??''])
    await db.exec(`set role ${role}`)
    try {return (await db.query('select public.read_trade_lookahead_workspace($1,$2,$3,$4,$5,$6,$7,$8,$9) v',[ORG,options.actor??ACTOR,options.weeks??3,options.division??DIV,options.community??null,options.q??'',options.page??1,options.group??null,options.itemPage??1])).rows[0].v}
    finally {await db.exec('reset role')}
  }
  return {db,read}
}
test('database workspace returns complete group counts with bounded later group and selected task pages',async t=>{
  const h=await fixture(t), group=JSON.stringify([COMP,'G116'])
  const pages=[];for(const page of [1,2,3]) pages.push(await h.read({page}))
  assert.deepEqual(pages.map(p=>p.rows.length),[50,50,17]);assert.ok(pages.every(p=>p.total===117))
  assert.equal(new Set(pages.flatMap(p=>p.rows.map(r=>r.key))).size,117)
  assert.ok(pages.flatMap(p=>p.rows).every(r=>!Object.hasOwn(r,'items')))
  const tasks=[];for(const itemPage of [1,2,3]) tasks.push(await h.read({group,itemPage,q:'missing'}))
  assert.ok(tasks.every(p=>p.total===0 && p.selected.itemCount===117 && p.selected.confirmedCount===1))
  assert.deepEqual(tasks.map(p=>p.selected.items.length),[50,50,17])
  assert.equal(new Set(tasks.flatMap(p=>p.selected.items.map(r=>r.scheduleItemId))).size,117)
})
test('current actor, permission, explicit deny and RPC grants fail closed',async t=>{
  const h=await fixture(t)
  await assert.rejects(h.read({},OTHER),/authenticated actor mismatch/)
  await assert.rejects(h.read({},null),/authenticated actor mismatch/)
  await assert.rejects(h.read({},ACTOR,'anon'),/permission denied/)
  await assert.rejects(h.read({},ACTOR,'service_role'),/permission denied/)
  await h.db.query("insert into membership_permission_overrides values($1,'start.read','deny')",[ACTOR])
  await assert.rejects(h.read(),/read permission denied/)
  await h.db.exec('delete from membership_permission_overrides')
  await h.db.exec("update memberships set status='inactive'")
  await assert.rejects(h.read(),/read permission denied/)
  assert.equal((await h.db.query("select has_function_privilege('authenticated','public.trade_workspace_readable_homes(uuid,uuid,uuid,uuid)','execute') v")).rows[0].v,false)
})
test('assigned homes and divisions narrow current source before grouping',async t=>{
  const h=await fixture(t)
  await h.db.exec("update memberships set project_scope='assigned'")
  assert.equal((await h.read()).total,0)
  await h.db.query("insert into project_members values($1,$2,$3,$4,'active')",[ORG,HOME,ACTOR,ROLE])
  assert.equal((await h.read()).total,117)
  await h.db.exec("update memberships set division_scope='assigned'")
  assert.equal((await h.read()).total,0)
  await h.db.query('insert into membership_divisions values($1,$2)',[ACTOR,DIV])
  assert.equal((await h.read({community:COMM})).total,117)
  assert.equal((await h.read({division:OTHER})).total,0)
  assert.equal((await h.read({community:OTHER})).total,0)
  await h.db.exec("update project_members set status='inactive'")
  assert.equal((await h.read()).total,0)
})
test('fallback uses the original PO parent, explicit assignments win, ambiguous vendors stay unassigned',async t=>{
  const h=await fixture(t)
  await h.db.exec('delete from schedule_assignments')
  await h.db.query("insert into commitments values($1,$2,$3,$4,'purchase_order')",[id(50),ORG,HOME,COMP])
  await h.db.query('insert into commitment_lines values($1,$2,$3,$4)',[id(51),ORG,id(50),id(9)])
  assert.equal((await h.read()).rows[0].companyId,COMP)
  await h.db.query("insert into commitments values($1,$2,$3,$4,'purchase_order')",[id(52),ORG,HOME,OTHER])
  await h.db.query('insert into commitment_lines values($1,$2,$3,$4)',[id(53),ORG,id(52),id(9)])
  assert.ok((await h.read()).rows.every(r=>r.companyId===null))
  await h.db.query('insert into schedule_assignments values($1,$2,$3,$4,$5,now())',[id(70),ORG,HOME,id(100),COMP])
  assert.equal((await h.read({q:'Partner'})).total,1)
  assert.equal((await h.read({q:'Partner'})).rows[0].confirmedCount,1)
})
test('foreign assignment and duplicate lot evidence fail instead of being counted or silently omitted',async t=>{
  const h=await fixture(t)
  await h.db.query('update schedule_assignments set project_id=$1 where schedule_item_id=$2',[id(21),id(100)])
  await assert.rejects(h.read(),/assignment source belongs to another/)
  await h.db.query('update schedule_assignments set project_id=$1',[HOME])
  await h.db.query("insert into lots values($1,$2,$3,$4,'duplicate',null)",[id(32),ORG,HOME,COMM])
  await assert.rejects(h.read(),/multiple lot sources/)
})
test('search is literal, changed selection is unavailable and query bounds reject',async t=>{
  const h=await fixture(t)
  assert.equal((await h.read({q:'G11'})).total,7)
  assert.equal((await h.read({q:'%'})).total,0)
  const missing=await h.read({group:JSON.stringify([OTHER,'foreign'])})
  assert.equal(missing.selected,null);assert.equal(missing.selectedUnavailable,true)
  await assert.rejects(h.read({weeks:5}),/Invalid trade workspace query/)
  await assert.rejects(h.read({page:1000001}),/Invalid trade workspace query/)
})
