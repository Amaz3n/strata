-- Workstream 06 Phases 3-4: safety records — incidents, toolbox talks, observations.

create table if not exists public.safety_incidents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  incident_number integer not null,
  occurred_at timestamptz not null,
  severity text not null check (severity in
    ('near_miss','first_aid','medical_treatment','lost_time','fatality')),
  classification text,
  location text,
  description text not null,
  involved_company_id uuid references public.companies(id),
  involved_person_name text,
  witness_names text,
  immediate_action text,
  root_cause text,
  is_osha_recordable boolean not null default false,
  reported_by uuid,
  status text not null default 'open' check (status in ('open','under_review','closed')),
  closed_at timestamptz,
  pdf_file_id uuid references public.files(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, incident_number)
);

create table if not exists public.toolbox_talks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  held_at date not null,
  topic text not null,
  notes text,
  presenter_name text,
  presenter_user_id uuid,
  attendee_count integer,
  attendees jsonb not null default '[]'::jsonb,
  file_id uuid references public.files(id),
  created_at timestamptz not null default now()
);

create table if not exists public.observations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  observation_number integer not null,
  kind text not null check (kind in ('safety','quality')),
  category text check (category is null or category in ('positive','at_risk','deficiency')),
  description text not null,
  location text,
  company_id uuid references public.companies(id),
  photo_file_id uuid references public.files(id),
  status text not null default 'open' check (status in ('open','resolved')),
  resolved_at timestamptz,
  due_date date,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (project_id, observation_number)
);

-- Deferred FK from the inspections migration.
alter table public.inspection_items
  add constraint inspection_items_observation_id_fkey
  foreign key (observation_id) references public.observations(id);

create index if not exists safety_incidents_org_project_idx on public.safety_incidents (org_id, project_id);
create index if not exists safety_incidents_project_number_idx on public.safety_incidents (project_id, incident_number desc);
create index if not exists toolbox_talks_org_project_idx on public.toolbox_talks (org_id, project_id, held_at desc);
create index if not exists observations_org_project_idx on public.observations (org_id, project_id);
create index if not exists observations_project_number_idx on public.observations (project_id, observation_number desc);

drop trigger if exists safety_incidents_set_updated_at on public.safety_incidents;
create trigger safety_incidents_set_updated_at before update on public.safety_incidents
  for each row execute function public.tg_set_updated_at();

alter table public.safety_incidents enable row level security;
alter table public.toolbox_talks enable row level security;
alter table public.observations enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array['safety_incidents','toolbox_talks','observations'] loop
    execute format('drop policy if exists %I_org_access on public.%I', table_name, table_name);
    execute format(
      'create policy %I_org_access on public.%I for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id))',
      table_name, table_name
    );
  end loop;
end $$;

create or replace function public.next_incident_number(p_project_id uuid)
returns integer language sql set search_path = public, pg_catalog as $$
  select coalesce(max(incident_number), 0) + 1
  from public.safety_incidents
  where project_id = p_project_id;
$$;

create or replace function public.next_observation_number(p_project_id uuid)
returns integer language sql set search_path = public, pg_catalog as $$
  select coalesce(max(observation_number), 0) + 1
  from public.observations
  where project_id = p_project_id;
$$;

grant all on table public.safety_incidents, public.toolbox_talks, public.observations
  to authenticated, service_role;
grant execute on function public.next_incident_number(uuid) to authenticated, service_role;
grant execute on function public.next_observation_number(uuid) to authenticated, service_role;

insert into public.permissions (key, description) values
  ('safety.write', 'Record safety incidents, toolbox talks, and observations')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select id, permission_key
from public.roles
cross join unnest(array['safety.write']) permission_key
where key in ('org_owner', 'org_admin', 'org_office_admin', 'org_project_lead', 'pm', 'field')
on conflict (role_id, permission_key) do nothing;
