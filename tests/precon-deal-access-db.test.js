const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
let PGlite
try { ({ PGlite } = require(process.env.ARC_TEST_PGLITE_MODULE || '@electric-sql/pglite')) } catch {}
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

test('deal Data API writes enforce project scope, explicit denies and closed state', {skip: !PGlite}, async t => {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table public.memberships(id uuid primary key,org_id uuid,user_id uuid,role_id uuid,status text,project_scope text);
    create table public.role_permissions(role_id uuid,permission_key text);
    create table public.membership_permission_overrides(membership_id uuid,permission_key text,effect text);
    create table public.project_members(org_id uuid,project_id uuid,user_id uuid,role_id uuid,status text);
    create table public.projects(id uuid primary key,org_id uuid,prospect_id uuid,phase text);
    create table public.prospects(id uuid primary key,org_id uuid,name text,status text,owner_user_id uuid,notes text,lost_reason text,lost_at timestamptz,won_at timestamptz,updated_at timestamptz default now());
    create table public.prospect_contacts(id uuid primary key,org_id uuid,prospect_id uuid references public.prospects(id) on delete cascade,full_name text,email text);
    create function public.is_org_member(tenant uuid) returns boolean language sql stable security definer as $$select exists(select 1 from public.memberships where org_id=tenant and user_id=auth.uid() and status='active')$$;
    alter table public.prospects enable row level security;
    alter table public.prospect_contacts enable row level security;
    grant usage on schema public,auth to authenticated,anon,service_role;
    grant all on all tables in schema public to authenticated,anon,service_role;
    insert into public.memberships values('${id(1)}','${id(10)}','${id(20)}','${id(30)}','active','assigned');
    insert into public.role_permissions values('${id(30)}','org.member'),('${id(30)}','project.manage');
    insert into public.prospects(id,org_id,name,status) values('${id(40)}','${id(10)}','Unlinked','new'),('${id(41)}','${id(10)}','Linked','pricing');
    insert into public.projects values('${id(50)}','${id(10)}','${id(41)}','precon');
    insert into public.prospect_contacts values('${id(60)}','${id(10)}','${id(41)}','Owner','owner@example.test');
  `)
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261001121630_precon_deal_mutation_guards.sql'),'utf8'))
  const asUser = async () => { await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${id(20)}',false)`) }
  const admin = async sql => { await db.exec('reset role'); await db.exec(sql); await asUser() }
  await asUser()
  await t.test('unlinked deal can be edited but RLS-hidden project does not look unlinked', async () => {
    assert.equal((await db.query(`update public.prospects set notes='Allowed' where id='${id(40)}' returning id`)).rows.length,1)
    assert.equal((await db.query(`update public.prospects set notes='Denied' where id='${id(41)}' returning id`)).rows.length,0)
    assert.equal((await db.query(`update public.prospect_contacts set email='changed@example.test' where id='${id(60)}' returning id`)).rows.length,0)
  })
  await t.test('assigned project manager can edit while explicit deny wins', async () => {
    await admin(`insert into public.project_members values('${id(10)}','${id(50)}','${id(20)}','${id(30)}','active')`)
    assert.equal((await db.query(`update public.prospects set notes='Managed' where id='${id(41)}' returning id`)).rows.length,1)
    await admin(`insert into public.membership_permission_overrides values('${id(1)}','project.manage','deny')`)
    assert.equal((await db.query(`update public.prospects set notes='Denied' where id='${id(41)}' returning id`)).rows.length,0)
    await admin('delete from public.membership_permission_overrides')
  })
  await t.test('deleting an authorized unlinked inquiry also deletes its contacts', async () => {
    await db.exec(`insert into public.prospect_contacts values('${id(61)}','${id(10)}','${id(40)}','Inquirer',null)`)
    await db.exec(`delete from public.prospects where id='${id(40)}'`)
    assert.equal((await db.query(`select id from public.prospect_contacts where id='${id(61)}'`)).rows.length,0)
    await db.exec(`insert into public.prospects(id,org_id,name,status) values('${id(40)}','${id(10)}','Unlinked','new')`)
  })
  await t.test('tenant or deal reassignment and inactive owner cannot bypass guards', async () => {
    await assert.rejects(db.query(`update public.prospects set org_id='${id(11)}' where id='${id(41)}'`), /identity/)
    await assert.rejects(db.query(`update public.prospect_contacts set prospect_id='${id(40)}' where id='${id(60)}'`), /cannot be moved/)
    await assert.rejects(db.query(`update public.prospects set owner_user_id='${id(99)}' where id='${id(41)}'`), /active team member/)
  })
  await t.test('lost deals permit only a clean reopen, then delivery makes records historical', async () => {
    await admin(`update public.prospects set status='lost',lost_reason='Timing' where id='${id(41)}'`)
    await assert.rejects(db.query(`update public.prospects set notes='Changed' where id='${id(41)}'`), /Reopen/)
    await assert.rejects(db.query(`update public.prospect_contacts set email=null where id='${id(60)}'`), /Reopen/)
    await assert.rejects(db.query(`update public.prospects set status='contacted',lost_reason=null,notes='Changed' where id='${id(41)}'`), /Reopen/)
    await db.exec(`update public.prospects set status='contacted',lost_reason=null,lost_at=null where id='${id(41)}'`)
    await admin(`update public.projects set phase='delivery' where id='${id(50)}'`)
    await assert.rejects(db.query(`update public.prospects set notes='Changed' where id='${id(41)}'`), /closed/)
    await assert.rejects(db.query(`delete from public.prospect_contacts where id='${id(60)}'`), /closed/)
  })
  await t.test('system lifecycle writes work but public access cannot write or invoke the trigger', async () => {
    await db.exec('set role service_role')
    await db.exec(`update public.prospects set status='won' where id='${id(41)}'`)
    await db.exec('set role anon')
    await assert.rejects(db.query(`select * from public.prospects`), /permission denied/)
    await db.exec('set role authenticated')
    const result = await db.query(`select has_function_privilege('authenticated','arc_private.guard_deal_mutation()','execute') allowed`)
    assert.equal(result.rows[0].allowed,false)
  })
})
