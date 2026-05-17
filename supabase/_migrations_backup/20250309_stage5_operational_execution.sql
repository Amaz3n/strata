-- Stage 5: Operational execution gaps

alter table schedule_items add column if not exists inspection_checklist jsonb;
alter table schedule_items add column if not exists inspection_result text;
alter table schedule_items add column if not exists inspected_by uuid references app_users(id);
alter table schedule_items add column if not exists inspected_at timestamptz;

alter table punch_items add column if not exists schedule_item_id uuid references schedule_items(id);
alter table punch_items add column if not exists created_from_inspection boolean default false;
alter table punch_items add column if not exists verification_required boolean default false;
alter table punch_items add column if not exists verified_at timestamptz;
alter table punch_items add column if not exists verified_by uuid references app_users(id);
alter table punch_items add column if not exists verification_notes text;

create table if not exists decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  project_id uuid not null references projects(id),
  title text not null,
  description text,
  status text default 'requested',
  due_date date,
  approved_at timestamptz,
  approved_by uuid references app_users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists decisions_org_project_idx on decisions (org_id, project_id, status);
