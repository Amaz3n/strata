const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const org = id(1), actor = id(2), project = id(3), otherOrg = id(4), otherActor = id(5), otherProject = id(6), first = id(10), second = id(11), foreign = id(12)
async function fixture(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table orgs(id uuid primary key); create table app_users(id uuid primary key);
    create table files(id uuid primary key,org_id uuid not null,project_id uuid,file_name text,
      folder_path text,share_with_clients boolean not null default true,share_with_subs boolean not null default false,
      archived_at timestamptz,updated_at timestamptz not null default now(),visibility text default 'private');
    create table project_file_folder_permissions(id uuid default gen_random_uuid(),org_id uuid,project_id uuid,path text,share_with_clients boolean,share_with_subs boolean,unique(org_id,project_id,path));
    create table project_file_folders(id uuid default gen_random_uuid(),org_id uuid,project_id uuid,path text,created_by uuid,unique(org_id,project_id,path));
    create table audit_log(id bigint generated always as identity,org_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,before_data jsonb,after_data jsonb,source text);
    create table events(id uuid default gen_random_uuid(),org_id uuid,event_type text,entity_type text,entity_id uuid,payload jsonb);
    create table outbox(id bigint generated always as identity,org_id uuid,job_type text,payload jsonb);
    create function touch_file() returns trigger language plpgsql as $$begin new.updated_at=now(); return new; end$$;
    create trigger files_set_updated_at before update on files for each row execute function touch_file();
    grant usage on schema public to anon,authenticated,service_role;
    grant all on all tables in schema public to service_role;
    grant all on all sequences in schema public to service_role;
  `)
  await db.query('insert into orgs values($1),($2)', [org, otherOrg])
  await db.query('insert into app_users values($1),($2)', [actor, otherActor])
  await db.query(`insert into files(id,org_id,project_id,file_name,folder_path) values($1,$2,$3,'a.pdf','/Original'),($4,$2,$3,'b.pdf','/Original'),($5,$6,$7,'foreign.pdf','/Original')`, [first,org,project,second,foreign,otherOrg,otherProject])
  await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261003004906_document_mutation_undo.sql'), 'utf8'))
  const mutate = async (ids=[first,second], kind='move', folder='/Target', scopes=Object.fromEntries(ids.map(fileId => [fileId,project]))) =>
    (await db.query('select mutate_documents($1,$2,$3,$4,$5,$6,true) result', [org,actor,ids,scopes,kind,folder])).rows[0].result
  const undo = async (receiptId, owner=actor) => (await db.query('select undo_document_mutation($1,$2,$3) result',[org,owner,receiptId])).rows[0].result
  const rows = async () => (await db.query('select * from files order by id')).rows
  return { db, mutate, undo, rows }
}

test('atomic move adopts folder sharing; undo restores original flags without changing visibility and is idempotent', async t => {
  const f = await fixture(t)
  await f.db.query('insert into project_file_folder_permissions(org_id,project_id,path,share_with_clients,share_with_subs) values($1,$2,$3,false,true)',[org,project,'/Target'])
  const moved = await f.mutate()
  assert.ok(moved.receiptId)
  assert.equal(moved.files.length,2)
  assert.deepEqual(moved.projectIds,[project])
  assert.equal((await f.rows())[0].share_with_clients,false)
  assert.equal((await f.rows())[0].share_with_subs,true)
  assert.equal((await f.rows())[0].visibility,'private')
  assert.equal((await f.db.query('select * from project_file_folders')).rows.length,1)
  const restored = await f.undo(moved.receiptId)
  assert.equal(restored.receiptId,null)
  assert.equal((await f.rows())[0].folder_path,'/Original')
  assert.equal((await f.rows())[0].share_with_clients,true)
  assert.equal((await f.rows())[0].share_with_subs,false)
  assert.deepEqual(await f.undo(moved.receiptId),restored)
  for (const table of ['audit_log','events','outbox']) assert.equal((await f.db.query(`select * from ${table}`)).rows.length,4)
})

test('unknown or foreign IDs deny the complete selection without mutating valid IDs or writing receipts', async t => {
  const f = await fixture(t)
  for(const bad of [id(99),foreign]) await assert.rejects(f.mutate([first,bad]),/unavailable/)
  assert.equal((await f.rows())[0].folder_path,'/Original')
  assert.equal((await f.db.query('select * from document_mutation_receipts')).rows.length,0)
  assert.equal((await f.db.query('select * from audit_log')).rows.length,0)
})

test('changed project scope fails closed after the service permission check', async t => {
  const f = await fixture(t)
  await assert.rejects(f.mutate([first,second],'move','/Target',{[first]:project,[second]:otherProject}),/scope changed/)
  await assert.rejects(f.mutate([first],'move','/Target',{}),/scope changed/)
  assert.equal((await f.rows())[0].folder_path,'/Original')
})

test('noop and duplicate selections do not write audit entries, change sharing or create receipts', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.mutate([first,first],'move','/Original'),{receiptId:null,projectIds:[],files:[]})
  assert.deepEqual(await f.mutate([]),{receiptId:null,projectIds:[],files:[]})
  assert.equal((await f.db.query('select * from audit_log')).rows.length,0)
  const moved=await f.mutate([first,first])
  assert.equal(moved.files.length,1)
})

test('undo conflicts are all-or-nothing when any row changes afterward', async t => {
  const f = await fixture(t)
  const moved=await f.mutate()
  await f.db.query("update files set file_name='newer.pdf' where id=$1",[second])
  await assert.rejects(f.undo(moved.receiptId),/newer work/)
  assert.equal((await f.rows())[0].folder_path,'/Target')
  assert.equal((await f.rows())[1].file_name,'newer.pdf')
  assert.equal((await f.db.query('select undone_at from document_mutation_receipts')).rows[0].undone_at,null)
  assert.equal((await f.db.query('select * from audit_log')).rows.length,2)
})

test('receipts reject another actor and expired undo windows', async t => {
  const f = await fixture(t)
  const moved=await f.mutate()
  await assert.rejects(f.undo(moved.receiptId,otherActor),/unavailable/)
  await f.db.query("update document_mutation_receipts set expires_at=now()-interval '1 second' where id=$1",[moved.receiptId])
  await assert.rejects(f.undo(moved.receiptId),/expired/)
  assert.equal((await f.rows())[0].folder_path,'/Target')
})

test('archive and restore preserve sharing and undo their exact prior archived state', async t => {
  const f = await fixture(t)
  const archived=await f.mutate([first,second],'archive')
  const archivedAt=(await f.rows())[0].archived_at
  assert.ok(archivedAt)
  assert.equal((await f.rows())[0].share_with_clients,true)
  assert.equal((await f.mutate([first,second],'archive')).receiptId,null)
  const restored=await f.mutate([first,second],'restore')
  assert.equal((await f.rows())[0].archived_at,null)
  await f.undo(restored.receiptId)
  assert.deepEqual((await f.rows())[0].archived_at,archivedAt)
  await assert.rejects(f.undo(archived.receiptId),/newer work/)
})

test('RPCs and receipt storage are inaccessible to ordinary API roles', async t => {
  const f = await fixture(t)
  for(const role of ['anon','authenticated']) {
    await f.db.exec(`set role ${role}`)
    await assert.rejects(f.mutate(),/permission denied/)
    await assert.rejects(f.undo(id(100)),/permission denied/)
    await assert.rejects(f.db.query('select * from document_mutation_receipts'),/permission denied/)
    await f.db.exec('reset role')
  }
  await f.db.exec('set role service_role')
  assert.ok((await f.mutate()).receiptId)
})

test('an audit failure rolls back every file, event and receipt in the transaction', async t => {
  const f=await fixture(t)
  await f.db.exec(`create function fail_second_audit() returns trigger language plpgsql as $$begin if new.entity_id='${second}'::uuid then raise exception 'Audit unavailable'; end if; return new; end$$;
    create trigger audit_failure before insert on audit_log for each row execute function fail_second_audit();`)
  await assert.rejects(f.mutate(),/Audit unavailable/)
  assert.equal((await f.rows())[0].folder_path,'/Original')
  assert.equal((await f.rows())[1].folder_path,'/Original')
  for(const table of ['audit_log','events','outbox','document_mutation_receipts']) assert.equal((await f.db.query(`select * from ${table}`)).rows.length,0)
})
