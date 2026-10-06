const fs = require("node:fs");
const path = require("node:path");
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function createDatabase() {
  const { PGlite } = require(
    process.env.ARC_TEST_PGLITE_MODULE || "@electric-sql/pglite",
  );
  const db = new PGlite();
  await db.exec(`
 create role anon;create role authenticated;create role service_role;
 create table orgs(id uuid primary key);create table app_users(id uuid primary key,full_name text);
 create table projects(id uuid primary key,org_id uuid,name text);
 create table files(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,file_name text,storage_path text,mime_type text,size_bytes bigint,visibility text,category text,source text,uploaded_by uuid,archived_at timestamptz);
 create table drawing_sets(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,title text,set_type text,status text,processing_stage text,created_by uuid,source_file_id uuid,created_at timestamptz default now());
 create table drawing_revisions(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,drawing_set_id uuid,revision_label text,issuance_type text,total_pages integer,processed_pages integer,error_message text,status text,processing_stage text,issued_date date,issued_by text,received_from text,notes text,source_file_id uuid references files(id),created_by uuid,published_at timestamptz,published_by uuid,updated_at timestamptz default now(),created_at timestamptz default now());
 create unique index drawing_revisions_one_pending_draft_per_project on drawing_revisions(project_id) where status in('processing','draft');
 create table drawing_sheets(id uuid primary key,org_id uuid,project_id uuid,drawing_set_id uuid,sheet_number text not null,sheet_title text,discipline text,current_revision_id uuid references drawing_revisions(id),share_with_clients boolean default false,share_with_subs boolean default false,sort_order integer default 0,created_at timestamptz default now(),updated_at timestamptz default now());
 create unique index drawing_sheets_project_sheet_number_key on drawing_sheets(project_id,sheet_number);
 create table drawing_sheet_versions(id uuid primary key,org_id uuid,drawing_sheet_id uuid references drawing_sheets(id) on delete cascade,drawing_revision_id uuid references drawing_revisions(id) on delete cascade,page_index integer,extracted_metadata jsonb default '{}',tile_manifest jsonb,thumbnail_url text,tile_base_url text,image_width integer,image_height integer,tiles_base_path text,created_at timestamptz default now());
 create table drawing_pins(id uuid,org_id uuid,drawing_sheet_id uuid,status text,entity_type text);
 create table drawing_markups(id uuid,org_id uuid,drawing_sheet_id uuid);
 create function is_org_member(uuid) returns boolean language sql as $$select true$$;
 create table outbox(id bigint generated always as identity primary key,priority integer default 0,created_at timestamptz default now(),updated_at timestamptz default now(),org_id uuid,job_type text,payload jsonb,run_at timestamptz,status text default 'pending',retry_count integer default 0,last_error text,event_id uuid);
 create table events(id uuid default gen_random_uuid(),org_id uuid,event_type text,entity_type text,entity_id uuid,payload jsonb);
 create table audit_log(org_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,after_data jsonb,before_data jsonb);
 create function tg_set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;
 create function refresh_drawing_sheets_list() returns void language plpgsql as $$begin end$$;
 insert into orgs values('${id(1)}'),('${id(2)}'); insert into app_users(id) values('${id(3)}');
 insert into projects values('${id(4)}','${id(1)}','Fixture'),('${id(5)}','${id(2)}','Other');
 `);
  return db;
}
async function migrate(db, name) {
  await db.exec(
    fs.readFileSync(
      path.resolve(__dirname, "../../../supabase/migrations", name),
      "utf8",
    ),
  );
}
module.exports = { createDatabase, migrate, id };
