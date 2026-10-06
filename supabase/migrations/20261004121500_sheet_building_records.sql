-- Sheet building records: what the recognition engine found on ONE sheet
-- revision — rooms, walls, openings and the building reconstruction — stored
-- once and read by both the area takeoff ("Fill rooms") and the 3D model
-- interpretation, which previously each ran the engine and kept separate
-- results (a derived storage cache and the model draft respectively).
--
-- One row per (sheet_version_id, engine_version). `input_key` fingerprints the
-- source evidence the engine read (vectors, text, evidence, scale, image size);
-- a recalibration or new evidence replaces the row's content. `record.runs`
-- holds one engine run per caller-chosen policy (finish policy × whether visual
-- recognition ran), all from that same evidence. Only completed recognition is
-- ever stored; a partial run stays retryable. See
-- lib/drawings/sheet-building-record.ts and lib/services/sheet-building-records.ts.
--
-- Derived data, written by whoever ran the engine: a member running the area
-- takeoff (takeoff.read — the same people who already persist the derived
-- detection cache in drawing storage) or the model interpretation outbox job
-- (service role). No deletes: rows go with their sheet version. No new RBAC keys.

create table if not exists public.sheet_building_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  sheet_version_id uuid not null references public.drawing_sheet_versions(id) on delete cascade,
  engine_version text not null,
  input_key text not null,
  record jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sheet_building_records_version_key unique (sheet_version_id, engine_version)
);

create index if not exists sheet_building_records_org_project_idx
  on public.sheet_building_records (org_id, project_id);
create index if not exists sheet_building_records_sheet_version_idx
  on public.sheet_building_records (sheet_version_id);

drop trigger if exists sheet_building_records_set_updated_at on public.sheet_building_records;
create trigger sheet_building_records_set_updated_at
  before update on public.sheet_building_records
  for each row execute function public.tg_set_updated_at();

alter table public.sheet_building_records enable row level security;

drop policy if exists sheet_building_records_read on public.sheet_building_records;
create policy sheet_building_records_read on public.sheet_building_records
  for select to authenticated
  using (public.has_org_permission(org_id, 'takeoff.read'));

drop policy if exists sheet_building_records_insert on public.sheet_building_records;
create policy sheet_building_records_insert on public.sheet_building_records
  for insert to authenticated
  with check (public.has_org_permission(org_id, 'takeoff.read'));

drop policy if exists sheet_building_records_update on public.sheet_building_records;
create policy sheet_building_records_update on public.sheet_building_records
  for update to authenticated
  using (public.has_org_permission(org_id, 'takeoff.read'))
  with check (public.has_org_permission(org_id, 'takeoff.read'));

revoke all on table public.sheet_building_records from anon, authenticated;
grant select, insert, update on table public.sheet_building_records to authenticated;
grant all on table public.sheet_building_records to service_role;
