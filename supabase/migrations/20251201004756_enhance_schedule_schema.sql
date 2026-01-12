-- Enhanced Schedule Schema for Construction Management
-- Adds resource assignments, baselines, and advanced scheduling features

-- 1. Add new columns to schedule_items for advanced scheduling
alter table schedule_items 
  add column if not exists phase text,
  add column if not exists trade text,
  add column if not exists location text,
  add column if not exists planned_hours numeric,
  add column if not exists actual_hours numeric,
  add column if not exists constraint_type text default 'asap',
  add column if not exists constraint_date date,
  add column if not exists is_critical_path boolean default false,
  add column if not exists float_days integer default 0,
  add column if not exists color text,
  add column if not exists sort_order integer default 0;

-- 2. Add dependency type and lag to schedule_dependencies
alter table schedule_dependencies 
  add column if not exists dependency_type text default 'FS',
  add column if not exists lag_days integer default 0;

-- Add comment explaining dependency types
comment on column schedule_dependencies.dependency_type is 'FS=Finish-to-Start, SS=Start-to-Start, FF=Finish-to-Finish, SF=Start-to-Finish';

-- 3. Create schedule_assignments table for resource management
create table if not exists schedule_assignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  schedule_item_id uuid not null references schedule_items(id) on delete cascade,
  -- Polymorphic assignment: user OR contact OR company
  user_id uuid references app_users(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  company_id uuid references companies(id) on delete set null,
  -- Assignment details
  role text default 'assigned',
  planned_hours numeric,
  actual_hours numeric default 0,
  hourly_rate_cents integer,
  notes text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- At least one assignee must be set
  constraint schedule_assignments_has_assignee check (
    user_id is not null or contact_id is not null or company_id is not null
  )
);

create index if not exists schedule_assignments_org_idx on schedule_assignments (org_id);
create index if not exists schedule_assignments_project_idx on schedule_assignments (project_id);
create index if not exists schedule_assignments_item_idx on schedule_assignments (schedule_item_id);
create index if not exists schedule_assignments_user_idx on schedule_assignments (user_id) where user_id is not null;
create index if not exists schedule_assignments_company_idx on schedule_assignments (company_id) where company_id is not null;

create trigger schedule_assignments_set_updated_at 
  before update on schedule_assignments 
  for each row execute function public.tg_set_updated_at();

-- 4. Create schedule_baselines table for tracking original plan vs actual
create table if not exists schedule_baselines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  description text,
  snapshot_at timestamptz not null default now(),
  items jsonb not null default '[]'::jsonb,
  is_active boolean default false,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now()
);

create index if not exists schedule_baselines_org_idx on schedule_baselines (org_id);
create index if not exists schedule_baselines_project_idx on schedule_baselines (project_id);
create unique index if not exists schedule_baselines_active_idx on schedule_baselines (project_id) where is_active = true;

-- 5. Create schedule_templates table for reusable schedules
create table if not exists schedule_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  description text,
  project_type text, -- matches project_work_type: new_construction, remodel, etc.
  property_type text, -- residential, commercial
  items jsonb not null default '[]'::jsonb,
  is_public boolean default false,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists schedule_templates_org_idx on schedule_templates (org_id);
create trigger schedule_templates_set_updated_at 
  before update on schedule_templates 
  for each row execute function public.tg_set_updated_at();

-- 6. Enable RLS on new tables
alter table schedule_assignments enable row level security;
alter table schedule_baselines enable row level security;
alter table schedule_templates enable row level security;

-- 7. Create RLS policies
create policy "schedule_assignments_access" on schedule_assignments
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "schedule_baselines_access" on schedule_baselines
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "schedule_templates_access" on schedule_templates
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));;
