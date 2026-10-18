import fs from 'node:fs'
export const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
export async function setupAreaAcceptance(exec) {
await exec(`create role anon; create role authenticated; create role service_role;
create table drawing_sheets(id uuid primary key,org_id uuid,current_revision_id uuid);
create table drawing_sheet_versions(id uuid primary key,org_id uuid,drawing_sheet_id uuid,drawing_revision_id uuid);
create table takeoff_conditions(id uuid primary key,org_id uuid);
create table drawing_markups(id uuid primary key,org_id uuid,drawing_sheet_id uuid,sheet_version_id uuid,condition_id uuid,data jsonb,label text,quantity numeric,uom text,created_by uuid,is_private boolean,share_with_clients boolean,share_with_subs boolean);
insert into drawing_sheets values('${id(3)}','${id(1)}','${id(5)}');
insert into drawing_sheet_versions values('${id(4)}','${id(1)}','${id(3)}','${id(5)}');
insert into takeoff_conditions values('${id(6)}','${id(1)}');`)
await exec(fs.readFileSync('supabase/migrations/20260927004537_takeoff_area_atomic_acceptance.sql','utf8'))
}
