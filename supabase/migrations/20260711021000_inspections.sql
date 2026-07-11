-- Workstream 06 Phase 2: checklist template library + inspections engine
-- (one engine serving safety and quality).

create table if not exists public.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  name text not null,
  kind text not null check (kind in ('safety','quality')),
  trade text,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.checklist_template_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  template_id uuid not null references public.checklist_templates(id) on delete cascade,
  section text,
  prompt text not null,
  response_type text not null default 'pass_fail'
    check (response_type in ('pass_fail','yes_no','text','number')),
  sort_order integer not null default 0
);

create table if not exists public.inspections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  inspection_number integer not null,
  template_id uuid references public.checklist_templates(id),
  kind text not null check (kind in ('safety','quality')),
  title text not null,
  status text not null default 'draft'
    check (status in ('draft','in_progress','completed')),
  result text check (result in ('pass','fail','partial')),
  inspected_at timestamptz,
  inspector_user_id uuid,
  inspector_name text,
  location text,
  company_id uuid references public.companies(id),
  notes text,
  pdf_file_id uuid references public.files(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, inspection_number)
);

create table if not exists public.inspection_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  inspection_id uuid not null references public.inspections(id) on delete cascade,
  section text,
  prompt text not null,
  response_type text not null default 'pass_fail'
    check (response_type in ('pass_fail','yes_no','text','number')),
  response text,
  is_deficient boolean not null default false,
  note text,
  photo_file_id uuid references public.files(id),
  punch_item_id uuid references public.punch_items(id),
  observation_id uuid,  -- FK added once observations table exists (safety records migration)
  sort_order integer not null default 0
);

create index if not exists checklist_templates_org_idx on public.checklist_templates (org_id, kind);
create index if not exists checklist_template_items_org_template_idx on public.checklist_template_items (org_id, template_id, sort_order);
create index if not exists inspections_org_project_idx on public.inspections (org_id, project_id);
create index if not exists inspections_project_number_idx on public.inspections (project_id, inspection_number desc);
create index if not exists inspection_items_org_inspection_idx on public.inspection_items (org_id, inspection_id, sort_order);

drop trigger if exists checklist_templates_set_updated_at on public.checklist_templates;
create trigger checklist_templates_set_updated_at before update on public.checklist_templates
  for each row execute function public.tg_set_updated_at();
drop trigger if exists inspections_set_updated_at on public.inspections;
create trigger inspections_set_updated_at before update on public.inspections
  for each row execute function public.tg_set_updated_at();

alter table public.checklist_templates enable row level security;
alter table public.checklist_template_items enable row level security;
alter table public.inspections enable row level security;
alter table public.inspection_items enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array['checklist_templates','checklist_template_items','inspections','inspection_items'] loop
    execute format('drop policy if exists %I_org_access on public.%I', table_name, table_name);
    execute format(
      'create policy %I_org_access on public.%I for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id))',
      table_name, table_name
    );
  end loop;
end $$;

create or replace function public.next_inspection_number(p_project_id uuid)
returns integer language sql set search_path = public, pg_catalog as $$
  select coalesce(max(inspection_number), 0) + 1
  from public.inspections
  where project_id = p_project_id;
$$;

grant all on table public.checklist_templates, public.checklist_template_items,
  public.inspections, public.inspection_items
  to authenticated, service_role;
grant execute on function public.next_inspection_number(uuid) to authenticated, service_role;

insert into public.permissions (key, description) values
  ('inspection.write', 'Run safety and quality inspections and manage checklist templates')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select id, permission_key
from public.roles
cross join unnest(array['inspection.write']) permission_key
where key in ('org_owner', 'org_admin', 'org_office_admin', 'org_project_lead', 'pm', 'field')
on conflict (role_id, permission_key) do nothing;
