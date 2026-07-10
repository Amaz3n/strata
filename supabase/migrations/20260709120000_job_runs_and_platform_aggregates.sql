-- Cron heartbeat: every scheduled job records a row per run so the platform
-- Ops page can detect jobs that silently stop running (see the GET/POST cron
-- incident). Service-role only: RLS enabled with no policies.
create table if not exists public.job_runs (
  id bigint generated always as identity primary key,
  job_name text not null,
  status text not null check (status in ('success', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  http_status integer,
  error text
);

create index if not exists job_runs_job_started_idx on public.job_runs (job_name, started_at desc);
create index if not exists job_runs_started_idx on public.job_runs (started_at);

alter table public.job_runs enable row level security;

-- Platform aggregates. The JS client caps selects at 1000 rows, so summing
-- file sizes or grouping events client-side under-reports; these run the
-- aggregation in Postgres. Invoked with the service role from platform pages.

create or replace function public.platform_storage_by_org(p_org_ids uuid[] default null)
returns table (org_id uuid, total_bytes bigint)
language sql
stable
security definer
set search_path = public
as $$
  select f.org_id, coalesce(sum(f.size_bytes), 0)::bigint
  from files f
  where f.archived_at is null
    and (p_org_ids is null or f.org_id = any (p_org_ids))
  group by f.org_id
$$;

create or replace function public.platform_upload_bytes_since(p_since timestamptz)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(f.size_bytes), 0)::bigint
  from files f
  where f.created_at >= p_since
$$;

create or replace function public.platform_monthly_signups(p_months integer default 6)
returns table (month_start date, signup_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select date_trunc('month', u.created_at)::date, count(*)::bigint
  from app_users u
  where u.created_at >= date_trunc('month', now()) - make_interval(months => p_months - 1)
  group by 1
  order by 1
$$;

create or replace function public.platform_events_by_org(p_org_ids uuid[], p_since timestamptz)
returns table (org_id uuid, event_count bigint, last_event_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select e.org_id, count(*)::bigint, max(e.created_at)
  from events e
  where e.org_id = any (p_org_ids)
    and e.created_at >= p_since
  group by e.org_id
$$;

revoke execute on function public.platform_storage_by_org(uuid[]) from anon, authenticated;
revoke execute on function public.platform_upload_bytes_since(timestamptz) from anon, authenticated;
revoke execute on function public.platform_monthly_signups(integer) from anon, authenticated;
revoke execute on function public.platform_events_by_org(uuid[], timestamptz) from anon, authenticated;
