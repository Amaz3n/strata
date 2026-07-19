-- Workstream 07 Phases 1-3: service intake, SLA targets, visits, and photos.

alter table public.warranty_requests
  add column if not exists request_number integer,
  add column if not exists severity text not null default 'routine_30'
    check (severity in ('emergency','routine_30','routine_60')),
  add column if not exists category text,
  add column if not exists cost_code_id uuid references public.cost_codes(id),
  add column if not exists coverage_term_key text,
  add column if not exists coverage_status text not null default 'unclassified'
    check (coverage_status in ('unclassified','in_warranty','out_of_warranty','goodwill')),
  add column if not exists coverage_override_reason text,
  add column if not exists assigned_user_id uuid references public.app_users(id),
  add column if not exists first_response_due_at timestamptz,
  add column if not exists resolution_due_at timestamptz,
  add column if not exists first_responded_at timestamptz,
  add column if not exists source text not null default 'office'
    check (source in ('office','buyer_portal','mobile')),
  add column if not exists cost_dump_flag boolean not null default false,
  add column if not exists structural_claim boolean not null default false,
  add column if not exists structural_claim_number text,
  add column if not exists structural_claim_submitted_at timestamptz,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

with numbered as (
  select id, row_number() over (
    partition by project_id order by created_at nulls last, id
  )::integer as request_number
  from public.warranty_requests
  where request_number is null
)
update public.warranty_requests wr
set request_number = numbered.request_number
from numbered
where wr.id = numbered.id;

alter table public.warranty_requests alter column request_number set not null;

create unique index warranty_requests_project_number_idx
  on public.warranty_requests (project_id, request_number);
create index warranty_requests_org_open_idx
  on public.warranty_requests (org_id, status, resolution_due_at)
  where status in ('open','in_progress');
create index warranty_requests_assigned_user_idx
  on public.warranty_requests (assigned_user_id, resolution_due_at)
  where assigned_user_id is not null;
create index warranty_requests_cost_code_idx
  on public.warranty_requests (cost_code_id) where cost_code_id is not null;

create table public.warranty_request_photos (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  request_id uuid not null references public.warranty_requests(id) on delete cascade,
  file_id uuid not null references public.files(id) on delete cascade,
  caption text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (request_id, file_id)
);
create index warranty_request_photos_org_request_idx
  on public.warranty_request_photos (org_id, request_id, created_at);
create index warranty_request_photos_file_idx on public.warranty_request_photos (file_id);

create table public.warranty_service_visits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  request_id uuid not null references public.warranty_requests(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  visit_number integer not null check (visit_number > 0),
  assignee_kind text not null check (assignee_kind in ('tech','trade')),
  assigned_user_id uuid references public.app_users(id) on delete set null,
  assigned_company_id uuid references public.companies(id) on delete set null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled','confirmed','in_progress','completed','no_access','canceled')),
  outcome text check (outcome in ('resolved','needs_followup','needs_parts','not_warrantable')),
  outcome_note text,
  confirmed_at timestamptz,
  completed_at timestamptz,
  completed_by uuid references public.app_users(id) on delete set null,
  buyer_signoff_name text,
  buyer_signoff_at timestamptz,
  buyer_signature_file_id uuid references public.files(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_id, visit_number),
  check (window_end > window_start),
  check (
    (assignee_kind = 'tech' and assigned_user_id is not null and assigned_company_id is null)
    or (assignee_kind = 'trade' and assigned_company_id is not null and assigned_user_id is null)
  )
);
create index warranty_visits_org_window_idx
  on public.warranty_service_visits (org_id, window_start);
create index warranty_visits_request_idx
  on public.warranty_service_visits (request_id, visit_number);
create index warranty_visits_tech_day_idx
  on public.warranty_service_visits (assigned_user_id, window_start)
  where assignee_kind = 'tech';
create index warranty_visits_company_status_idx
  on public.warranty_service_visits (assigned_company_id, status)
  where assignee_kind = 'trade';

create table public.warranty_visit_photos (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  visit_id uuid not null references public.warranty_service_visits(id) on delete cascade,
  file_id uuid not null references public.files(id) on delete cascade,
  caption text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (visit_id, file_id)
);
create index warranty_visit_photos_org_visit_idx
  on public.warranty_visit_photos (org_id, visit_id, created_at);
create index warranty_visit_photos_file_idx on public.warranty_visit_photos (file_id);

create table public.warranty_sla_targets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  severity text not null check (severity in ('emergency','routine_30','routine_60')),
  first_response_hours integer not null check (first_response_hours > 0),
  resolution_days integer not null check (resolution_days > 0),
  unique (org_id, severity)
);
create index warranty_sla_targets_org_idx on public.warranty_sla_targets (org_id, severity);

drop trigger if exists warranty_service_visits_set_updated_at on public.warranty_service_visits;
create trigger warranty_service_visits_set_updated_at before update on public.warranty_service_visits
  for each row execute function public.tg_set_updated_at();

alter table public.warranty_request_photos enable row level security;
alter table public.warranty_service_visits enable row level security;
alter table public.warranty_visit_photos enable row level security;
alter table public.warranty_sla_targets enable row level security;

create policy warranty_request_photos_org_access on public.warranty_request_photos
  for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy warranty_service_visits_org_access on public.warranty_service_visits
  for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy warranty_visit_photos_org_access on public.warranty_visit_photos
  for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy warranty_sla_targets_org_access on public.warranty_sla_targets
  for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));

grant select, insert, update, delete on table
  public.warranty_request_photos,
  public.warranty_service_visits,
  public.warranty_visit_photos,
  public.warranty_sla_targets
to authenticated, service_role;

create or replace function public.next_warranty_request_number(p_project_id uuid)
returns integer
language sql
set search_path = public, pg_catalog
as $$
  select coalesce(max(request_number), 0) + 1
  from public.warranty_requests
  where project_id = p_project_id;
$$;

revoke all on function public.next_warranty_request_number(uuid) from public, anon;
grant execute on function public.next_warranty_request_number(uuid) to authenticated, service_role;

comment on table public.warranty_service_visits is
  'Service appointments dispatched to an internal technician or a trade, with completion and buyer sign-off.';
