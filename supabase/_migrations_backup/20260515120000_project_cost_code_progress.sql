-- Job-cost forecast and WIP (Phase D)
create type progress_basis as enum ('manual', 'cost_to_cost', 'schedule_linked');

create table if not exists project_cost_code_progress (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  cost_code_id uuid not null references cost_codes(id) on delete cascade,
  percent_complete numeric,
  basis progress_basis not null default 'manual',
  estimate_remaining_cents integer,
  notes text,
  recorded_by_user_id uuid not null,
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, project_id, cost_code_id)
);

create index if not exists project_cost_code_progress_project_idx on project_cost_code_progress(project_id);
create index if not exists project_cost_code_progress_org_idx on project_cost_code_progress(org_id);

create trigger project_cost_code_progress_updated_at 
before update on project_cost_code_progress 
for each row execute function public.tg_set_updated_at();

-- Add RLS policies
alter table project_cost_code_progress enable row level security;

create policy "Users can view progress in their org"
  on project_cost_code_progress for select
  using (org_id = (select auth.jwt() ->> 'org_id')::uuid);

create policy "Users can insert progress in their org"
  on project_cost_code_progress for insert
  with check (org_id = (select auth.jwt() ->> 'org_id')::uuid);

create policy "Users can update progress in their org"
  on project_cost_code_progress for update
  using (org_id = (select auth.jwt() ->> 'org_id')::uuid)
  with check (org_id = (select auth.jwt() ->> 'org_id')::uuid);

create policy "Users can delete progress in their org"
  on project_cost_code_progress for delete
  using (org_id = (select auth.jwt() ->> 'org_id')::uuid);
