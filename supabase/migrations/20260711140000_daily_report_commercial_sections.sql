-- Workstream 08: commercial daily-report sections, automatic weather snapshots,
-- and subcontractor-authored day contributions.

create table if not exists public.daily_report_delays (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  daily_report_id uuid not null references public.daily_reports(id) on delete cascade,
  delay_type text not null check (delay_type in
    ('weather','owner','design','material','labor','equipment','utility','other')),
  description text not null,
  hours_lost numeric check (hours_lost is null or hours_lost >= 0),
  affected_trades text,
  schedule_item_id uuid references public.schedule_items(id) on delete set null,
  potential_claim boolean not null default false,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.daily_report_equipment (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  daily_report_id uuid not null references public.daily_reports(id) on delete cascade,
  description text not null,
  company text,
  count integer not null default 1 check (count > 0),
  hours_used numeric check (hours_used is null or hours_used >= 0),
  idle boolean not null default false,
  notes text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.daily_report_visitors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  daily_report_id uuid not null references public.daily_reports(id) on delete cascade,
  name text not null,
  company text,
  purpose text,
  time_in text,
  time_out text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.daily_report_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  daily_report_id uuid not null references public.daily_reports(id) on delete cascade,
  description text not null,
  supplier text,
  quantity text,
  ticket_number text,
  received_by text,
  notes text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.daily_reports
  add column if not exists weather_auto jsonb,
  add column if not exists created_via_portal boolean not null default false,
  add column if not exists portal_company_id uuid references public.companies(id) on delete set null;

alter table public.daily_report_manpower
  add column if not exists portal_company_id uuid references public.companies(id) on delete set null;

alter table public.daily_logs
  add column if not exists created_via_portal boolean not null default false,
  add column if not exists portal_company_id uuid references public.companies(id) on delete set null;

alter table public.portal_access_tokens
  add column if not exists can_submit_daily_logs boolean not null default false;

create index if not exists daily_report_delays_org_project_idx
  on public.daily_report_delays (org_id, project_id, created_at desc);
create index if not exists daily_report_delays_report_idx
  on public.daily_report_delays (daily_report_id);
create index if not exists daily_report_delays_schedule_item_idx
  on public.daily_report_delays (schedule_item_id) where schedule_item_id is not null;
create index if not exists daily_report_delays_claim_idx
  on public.daily_report_delays (org_id, project_id, potential_claim, created_at desc);
create index if not exists daily_report_equipment_org_project_idx
  on public.daily_report_equipment (org_id, project_id);
create index if not exists daily_report_equipment_report_idx
  on public.daily_report_equipment (daily_report_id);
create index if not exists daily_report_visitors_org_project_idx
  on public.daily_report_visitors (org_id, project_id);
create index if not exists daily_report_visitors_report_idx
  on public.daily_report_visitors (daily_report_id);
create index if not exists daily_report_deliveries_org_project_idx
  on public.daily_report_deliveries (org_id, project_id);
create index if not exists daily_report_deliveries_report_idx
  on public.daily_report_deliveries (daily_report_id);
create index if not exists daily_report_manpower_portal_company_idx
  on public.daily_report_manpower (portal_company_id) where portal_company_id is not null;
create index if not exists daily_logs_portal_company_idx
  on public.daily_logs (org_id, project_id, portal_company_id, log_date desc)
  where portal_company_id is not null;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'daily_report_delays',
    'daily_report_equipment',
    'daily_report_visitors',
    'daily_report_deliveries'
  ] loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', table_name, table_name);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I for each row execute function public.tg_set_updated_at()',
      table_name, table_name
    );
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists %I_access on public.%I', table_name, table_name);
    execute format(
      'create policy %I_access on public.%I for all to authenticated using (public.is_org_member(org_id) and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))) with check (public.is_org_member(org_id) and (public.is_project_member(project_id) or public.is_org_admin_member(org_id)))',
      table_name, table_name
    );
  end loop;
end $$;

grant all on table
  public.daily_report_delays,
  public.daily_report_equipment,
  public.daily_report_visitors,
  public.daily_report_deliveries
to authenticated, service_role;
