-- Daily Reports: one canonical day-document per project per date.
--
-- Prior model: free-floating daily_logs grouped by date only at render time.
-- New model: a daily_reports row is the record for (project, date). It owns the
-- day-level conditions (weather, day type) and the lifecycle (draft -> submitted).
-- Existing daily_logs become *contributions* to that report (narrative + typed
-- entries + photos + author attribution), linked via daily_report_id.
--
-- Non-destructive: existing logs are preserved and back-linked to a report that
-- is created per distinct (project_id, log_date). Backfilled reports land as
-- 'draft' — retroactively stamping them 'submitted' would fabricate a record we
-- cannot stand behind. Submission happens going forward.

create table if not exists public.daily_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  report_date date not null,
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  -- Day-level conditions. jsonb mirrors daily_logs.weather so the same client
  -- shape works: { conditions, temperature, notes }.
  weather jsonb,
  -- work_day | rain_day | weekend | holiday | no_work — drives delay-claim rollups.
  day_type text check (day_type in ('work_day', 'rain_day', 'weekend', 'holiday', 'no_work')),
  submitted_at timestamptz,
  submitted_by uuid references public.app_users(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, report_date)
);

create index if not exists daily_reports_org_project_idx on public.daily_reports(org_id, project_id);
create index if not exists daily_reports_project_date_idx on public.daily_reports(project_id, report_date desc);
create index if not exists daily_reports_status_idx on public.daily_reports(org_id, status);

drop trigger if exists daily_reports_set_updated_at on public.daily_reports;
create trigger daily_reports_set_updated_at
before update on public.daily_reports
for each row execute function public.tg_set_updated_at();

alter table public.daily_reports enable row level security;

drop policy if exists daily_reports_access on public.daily_reports;
create policy daily_reports_access on public.daily_reports
for all
using (
  auth.role() = 'service_role'
  or (
    public.is_org_member(org_id)
    and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))
  )
)
with check (
  auth.role() = 'service_role'
  or (
    public.is_org_member(org_id)
    and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))
  )
);

-- Manpower: one row per crew/company present on the day. Headcount + hours is the
-- first thing an owner or a cost report asks for; it was previously absent.
create table if not exists public.daily_report_manpower (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  daily_report_id uuid not null references public.daily_reports(id) on delete cascade,
  company text,
  trade text,
  workers integer check (workers is null or workers >= 0),
  hours numeric check (hours is null or hours >= 0),
  notes text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists daily_report_manpower_report_idx on public.daily_report_manpower(daily_report_id);
create index if not exists daily_report_manpower_org_project_idx on public.daily_report_manpower(org_id, project_id);

drop trigger if exists daily_report_manpower_set_updated_at on public.daily_report_manpower;
create trigger daily_report_manpower_set_updated_at
before update on public.daily_report_manpower
for each row execute function public.tg_set_updated_at();

alter table public.daily_report_manpower enable row level security;

drop policy if exists daily_report_manpower_access on public.daily_report_manpower;
create policy daily_report_manpower_access on public.daily_report_manpower
for all
using (
  auth.role() = 'service_role'
  or (
    public.is_org_member(org_id)
    and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))
  )
)
with check (
  auth.role() = 'service_role'
  or (
    public.is_org_member(org_id)
    and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))
  )
);

-- Link existing logs to their day report.
alter table public.daily_logs
  add column if not exists daily_report_id uuid references public.daily_reports(id) on delete set null;

create index if not exists daily_logs_daily_report_idx on public.daily_logs(daily_report_id);

-- Backfill: one draft report per distinct (project_id, log_date), carrying the
-- first non-null weather seen that day and the earliest author as created_by.
insert into public.daily_reports (org_id, project_id, report_date, status, weather, created_by, created_at)
select
  l.org_id,
  l.project_id,
  l.log_date,
  'draft',
  (array_remove(array_agg(l.weather order by l.created_at) filter (where l.weather is not null), null))[1],
  (array_agg(l.created_by order by l.created_at) filter (where l.created_by is not null))[1],
  min(l.created_at)
from public.daily_logs l
group by l.org_id, l.project_id, l.log_date
on conflict (project_id, report_date) do nothing;

update public.daily_logs l
set daily_report_id = r.id
from public.daily_reports r
where l.daily_report_id is null
  and r.project_id = l.project_id
  and r.report_date = l.log_date;

grant all on table public.daily_reports to anon, authenticated, service_role;
grant all on table public.daily_report_manpower to anon, authenticated, service_role;
