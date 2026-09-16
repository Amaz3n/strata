// Optional isolated PostgreSQL regression test (no live database needed).
// npm install --prefix /tmp/arc-db-test --no-save @electric-sql/pglite
// PGLITE_MODULE_PATH=/tmp/arc-db-test/node_modules/@electric-sql/pglite node scripts/qa/verify-office-documents.mjs
import { createRequire } from 'node:module'
const { PGlite } = createRequire(import.meta.url)(process.env.PGLITE_MODULE_PATH || '@electric-sql/pglite')
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const db = new PGlite()
await db.exec(`
create role anon; create role authenticated; create role service_role; create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.actor',true),'')::uuid $$;
create table orgs(id uuid primary key); create table app_users(id uuid primary key);
create function public.has_org_permission(org_id uuid, permission text) returns boolean language sql stable as $$
select org_id::text = current_setting('test.org',true) and (permission = 'docs.read' or current_setting('test.write',true) = 'true') $$;
create table files(id uuid primary key default gen_random_uuid(), org_id uuid, project_id uuid, prospect_id uuid, folder_path text, archived_at timestamptz, category text, due_at timestamptz);
grant usage on schema public, auth to authenticated;
grant select,insert,update,delete on files to authenticated;
alter table files enable row level security;
create policy file_read on files for select to authenticated using (has_org_permission(org_id,'docs.read'));
create policy file_write on files for update to authenticated using (has_org_permission(org_id,'docs.upload')) with check(has_org_permission(org_id,'docs.upload'));
insert into orgs values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
insert into app_users values ('00000000-0000-0000-0000-000000000003');
set test.org = '00000000-0000-0000-0000-000000000001'; set test.actor = '00000000-0000-0000-0000-000000000003'; set test.write = 'true';
`)
await db.exec(readFileSync(new URL('../../supabase/migrations/20260916121723_organization_documents.sql', import.meta.url),'utf8'))
const org='00000000-0000-0000-0000-000000000001', other='00000000-0000-0000-0000-000000000002'
await db.query(`insert into org_document_folders(org_id,path) values ($1,'/Office'),($1,'/Office/Empty'),($1,'/Target'),($2,'/Secret')`,[org,other])
await db.query(`insert into files(org_id,project_id,prospect_id,folder_path,archived_at) values
($1,null,null,'/Office',null),($1,null,null,'/Office/Nested',null),($1,null,null,'/Office/Trash',now()),
($1,$2,null,'/Office',null),($1,null,$2,'/Office',null),($2,null,null,'/Office',null)`,[org,other])
await db.exec('set role authenticated')
assert.deepEqual((await db.query('select * from office_document_counts($1)', [org])).rows.map(r=>[r.category,Number(r.file_count)]), [['other',2],['all',2],['trash',1],['expiring',0]])
let rows=(await db.query('select * from list_office_document_children($1,null)',[org])).rows
assert.deepEqual(rows.map(r=>[r.path,Number(r.item_count)]),[['/Office',2],['/Target',0]])
assert.equal((await db.query('select * from org_document_folders where org_id=$1',[other])).rows.length,0)
assert.equal((await db.query('select * from list_office_document_children($1,null)',[other])).rows.length,0)
await assert.rejects(db.query('select mutate_office_document_folder($1,$2,$3)',[org,'/Office','/Target']),/already exists/)
assert.equal((await db.query('select mutate_office_document_folder($1,$2,$3) n',[org,'/Office','/Renamed'])).rows[0].n,3)
rows=(await db.query('select project_id,prospect_id,folder_path from files where org_id=$1',[org])).rows
assert.equal(rows.filter(r=>r.folder_path.startsWith('/Renamed')).length,3)
assert.equal(rows.filter(r=>r.folder_path==='/Office').length,2)
await assert.rejects(db.query('select mutate_office_document_folder($1,$2)',[org,'/Renamed']),/not empty/)
await db.query('select mutate_office_document_folder($1,$2)',[org,'/Renamed/Empty'])
await db.exec("set test.write = 'false'")
await assert.rejects(db.query('select mutate_office_document_folder($1,$2)',[org,'/Target']),/Forbidden/)
await assert.rejects(db.query("insert into org_document_folders(org_id,path) values($1,'/Denied')",[org]),/row-level security/)
await db.exec("set test.write = 'true'")
await assert.rejects(db.query('select mutate_office_document_folder($1,$2)',[other,'/Secret']),/Forbidden/)
console.log('PASS: SQL migration, folder counts, empty folders, atomic rename, collisions, archived files, project/prospect isolation, tenant isolation, read-only denial')
await db.close()
