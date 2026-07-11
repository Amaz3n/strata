-- Workstream 05: project document suite (formatted numbering, meetings, transmittals).

alter table public.orgs
  add column if not exists document_numbering jsonb not null default '{}'::jsonb;

create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  meeting_number integer not null,
  series text not null default 'oac' check (series in ('oac', 'sub', 'safety', 'custom')),
  title text not null,
  held_at timestamptz,
  location text,
  status text not null default 'draft' check (status in ('draft', 'finalized')),
  finalized_at timestamptz,
  pdf_file_id uuid references public.files(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, series, meeting_number)
);

create table if not exists public.meeting_attendees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  contact_id uuid references public.contacts(id),
  user_id uuid references public.app_users(id),
  display_name text not null,
  company_name text,
  email text,
  present boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.meeting_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  item_number text not null,
  first_meeting_id uuid references public.meetings(id),
  carried_from_item_id uuid references public.meeting_items(id),
  topic text not null,
  discussion text,
  status text not null default 'open' check (status in ('open', 'closed', 'info')),
  ball_in_court text,
  due_date date,
  task_id uuid references public.tasks(id),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.transmittals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  transmittal_number integer not null,
  subject text not null,
  purpose text not null default 'for_review'
    check (purpose in ('for_review', 'for_approval', 'for_record', 'for_construction', 'as_requested')),
  notes text,
  sent_at timestamptz,
  sent_by uuid references public.app_users(id),
  pdf_file_id uuid references public.files(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, transmittal_number)
);

create table if not exists public.transmittal_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  transmittal_id uuid not null references public.transmittals(id) on delete cascade,
  file_id uuid references public.files(id),
  entity_type text check (entity_type is null or entity_type in ('drawing_sheet', 'submittal', 'rfi', 'file')),
  entity_id uuid,
  description text not null,
  copies integer not null default 1 check (copies > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.transmittal_recipients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  transmittal_id uuid not null references public.transmittals(id) on delete cascade,
  contact_id uuid references public.contacts(id),
  email text not null,
  display_name text not null,
  company_name text,
  share_link_id uuid references public.file_share_links(id),
  first_viewed_at timestamptz,
  first_downloaded_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists meetings_org_project_idx on public.meetings (org_id, project_id);
create index if not exists meetings_project_series_number_idx on public.meetings (project_id, series, meeting_number desc);
create index if not exists meeting_attendees_org_meeting_idx on public.meeting_attendees (org_id, meeting_id);
create index if not exists meeting_items_org_project_idx on public.meeting_items (org_id, project_id);
create index if not exists meeting_items_meeting_idx on public.meeting_items (meeting_id, sort_order);
create index if not exists transmittals_org_project_idx on public.transmittals (org_id, project_id);
create index if not exists transmittal_items_org_transmittal_idx on public.transmittal_items (org_id, transmittal_id);
create index if not exists transmittal_recipients_org_transmittal_idx on public.transmittal_recipients (org_id, transmittal_id);
create index if not exists transmittal_recipients_share_link_idx on public.transmittal_recipients (share_link_id) where share_link_id is not null;

drop trigger if exists meetings_set_updated_at on public.meetings;
create trigger meetings_set_updated_at before update on public.meetings
  for each row execute function public.tg_set_updated_at();
drop trigger if exists meeting_items_set_updated_at on public.meeting_items;
create trigger meeting_items_set_updated_at before update on public.meeting_items
  for each row execute function public.tg_set_updated_at();
drop trigger if exists transmittals_set_updated_at on public.transmittals;
create trigger transmittals_set_updated_at before update on public.transmittals
  for each row execute function public.tg_set_updated_at();

alter table public.meetings enable row level security;
alter table public.meeting_attendees enable row level security;
alter table public.meeting_items enable row level security;
alter table public.transmittals enable row level security;
alter table public.transmittal_items enable row level security;
alter table public.transmittal_recipients enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array['meetings','meeting_attendees','meeting_items','transmittals','transmittal_items','transmittal_recipients'] loop
    execute format('drop policy if exists %I_org_access on public.%I', table_name, table_name);
    execute format(
      'create policy %I_org_access on public.%I for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id))',
      table_name, table_name
    );
  end loop;
end $$;

create or replace function public.next_meeting_number(p_project_id uuid, p_series text)
returns integer language sql set search_path = public, pg_catalog as $$
  select coalesce(max(meeting_number), 0) + 1
  from public.meetings
  where project_id = p_project_id and series = p_series;
$$;

create or replace function public.next_transmittal_number(p_project_id uuid)
returns integer language sql set search_path = public, pg_catalog as $$
  select coalesce(max(transmittal_number), 0) + 1
  from public.transmittals
  where project_id = p_project_id;
$$;

grant all on table public.meetings, public.meeting_attendees, public.meeting_items,
  public.transmittals, public.transmittal_items, public.transmittal_recipients
  to authenticated, service_role;
grant execute on function public.next_meeting_number(uuid, text) to authenticated, service_role;
grant execute on function public.next_transmittal_number(uuid) to authenticated, service_role;

insert into public.permissions (key, description) values
  ('meeting.write', 'Create, edit, and finalize project meeting minutes'),
  ('transmittal.write', 'Create and send project transmittals')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select id, permission_key
from public.roles
cross join unnest(array['meeting.write', 'transmittal.write']) permission_key
where key in ('org_owner', 'org_admin', 'org_office_admin', 'org_project_lead', 'pm')
on conflict (role_id, permission_key) do nothing;

