-- Field time and payroll (Arc Trade readiness TR03). Neutral names: builders use all of it.
--
-- 1. time_clock_sessions: one row per stretch of work on one job and cost code.
--    Clock in opens a row, a break pauses it, switching job closes it and opens
--    the next, clock out closes it and writes the hours to time_entries through
--    the service (lib/services/time-clock.ts). A worker has at most one open row.
-- 2. pay_periods: a closed pay period. Periods are computed from the company's
--    pay schedule (org_settings.settings.time_policy); a row exists once the
--    office closes one. Closing locks the period's approved entries.
-- 3. time_entries gains the lock stamp, its pay period, the clock session that
--    produced it, and reverses_time_entry_id. A locked entry never changes; a
--    correction is a reversing entry (negative hours) in the current period plus
--    a replacement entry that goes through approval like any other.
-- 4. labor_rates: effective-dated cost rate, burden and bill rate per worker,
--    so a raise starts on a date and past entries keep their rate. The
--    memberships columns stay as the current rate the roster lists.
-- 5. time.manage: record and change time for someone else. time.write alone now
--    means your own time. Every role that holds time.write today except Crew
--    member receives it, so nobody who enters crew time today loses it.

begin;

create table public.time_clock_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  worker_user_id uuid not null references public.app_users(id) on delete cascade,
  work_date date not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  break_started_at timestamptz,
  break_minutes integer not null default 0 check (break_minutes >= 0),
  source text not null default 'web' check (source in ('web', 'mobile')),
  start_location jsonb,
  end_location jsonb,
  time_entry_id uuid references public.time_entries(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at),
  check (ended_at is null or break_started_at is null)
);

create unique index time_clock_sessions_one_open_idx
  on public.time_clock_sessions (org_id, worker_user_id) where ended_at is null;
create index time_clock_sessions_org_project_idx on public.time_clock_sessions (org_id, project_id);
create index time_clock_sessions_worker_date_idx on public.time_clock_sessions (org_id, worker_user_id, work_date);
create index time_clock_sessions_cost_code_idx on public.time_clock_sessions (cost_code_id) where cost_code_id is not null;
create index time_clock_sessions_time_entry_idx on public.time_clock_sessions (time_entry_id) where time_entry_id is not null;

create trigger time_clock_sessions_set_updated_at before update on public.time_clock_sessions
  for each row execute function public.tg_set_updated_at();

alter table public.time_clock_sessions enable row level security;
-- Clock rows are written only through lib/services/time-clock.ts on the service
-- client, after its own permission checks. A member reads their own rows; reading
-- the crew's takes time.manage.
revoke insert, update, delete on public.time_clock_sessions from anon, authenticated;
create policy time_clock_sessions_read on public.time_clock_sessions for select
  using (
    ((select auth.role()) = 'service_role')
    or worker_user_id = (select auth.uid())
    or public.has_org_permission(org_id, 'time.manage')
  );
create policy time_clock_sessions_service_write on public.time_clock_sessions for all
  using ((select auth.role()) = 'service_role')
  with check ((select auth.role()) = 'service_role');
create policy time_clock_sessions_division_scope on public.time_clock_sessions as restrictive for all
  using ((org_id = any ((select public.member_unscoped_org_ids())::uuid[])) or (project_id in (select public.member_reachable_project_ids())))
  with check ((org_id = any ((select public.member_unscoped_org_ids())::uuid[])) or (project_id in (select public.member_reachable_project_ids())));

create table public.pay_periods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  status text not null default 'closed' check (status in ('closed')),
  closed_at timestamptz not null default now(),
  closed_by uuid references public.app_users(id) on delete set null,
  summary jsonb not null default '{}'::jsonb,
  books_payroll_import_id uuid references public.books_payroll_imports(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  unique (org_id, starts_on)
);
create index pay_periods_org_ends_idx on public.pay_periods (org_id, ends_on desc);
create index pay_periods_books_import_idx on public.pay_periods (books_payroll_import_id) where books_payroll_import_id is not null;

create trigger pay_periods_set_updated_at before update on public.pay_periods
  for each row execute function public.tg_set_updated_at();

alter table public.pay_periods enable row level security;
-- Every member reads the closed periods (entry dating checks them); only the
-- close function below, on the service client, writes one.
revoke insert, update, delete on public.pay_periods from anon, authenticated;
create policy pay_periods_read on public.pay_periods for select
  using (((select auth.role()) = 'service_role') or public.is_org_member(org_id));
create policy pay_periods_service_write on public.pay_periods for all
  using ((select auth.role()) = 'service_role')
  with check ((select auth.role()) = 'service_role');

alter table public.time_entries
  add column locked_at timestamptz,
  add column locked_by uuid references public.app_users(id) on delete set null,
  add column pay_period_id uuid references public.pay_periods(id) on delete set null,
  add column reverses_time_entry_id uuid references public.time_entries(id) on delete restrict;

alter table public.time_entries drop constraint time_entries_hours_check;
alter table public.time_entries add constraint time_entries_hours_check check (
  (hours > 0 and hours <= 24)
  or (hours < 0 and hours >= -24 and reverses_time_entry_id is not null)
);

create index time_entries_org_worker_date_idx on public.time_entries (org_id, worker_user_id, work_date);
create index time_entries_pay_period_idx on public.time_entries (pay_period_id) where pay_period_id is not null;
create unique index time_entries_one_reversal_idx on public.time_entries (reverses_time_entry_id) where reverses_time_entry_id is not null;

-- A locked entry is the payroll record. Only billing state may still move: the
-- billable cost link, and the client's approval of the cost on projects that need it
-- (client approval gates invoicing, not payroll). Foreign keys may still null a
-- reference (ON DELETE SET NULL) and cascades may still delete the entry with its
-- project or org; every economic column stays frozen. cost_cents is generated from
-- the frozen hours and rates and is not yet computed inside a BEFORE trigger.
create or replace function public.guard_locked_time_entry()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_loose text[] := array['billable_cost_id', 'updated_at', 'metadata', 'approved_by_client_at', 'approval_token_hash', 'approval_token_expires_at',
    'cost_cents', 'cost_code_id', 'budget_line_id', 'worker_user_id', 'worker_company_id', 'approved_by_pm_user_id', 'locked_by', 'pay_period_id'];
begin
  if old.status <> 'locked' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'A locked time entry cannot be deleted; correct it instead';
  end if;
  if (to_jsonb(new) - v_loose) is distinct from (to_jsonb(old) - v_loose)
     or (new.cost_code_id is not null and new.cost_code_id is distinct from old.cost_code_id)
     or (new.budget_line_id is not null and new.budget_line_id is distinct from old.budget_line_id)
     or (new.worker_user_id is not null and new.worker_user_id is distinct from old.worker_user_id)
     or (new.worker_company_id is not null and new.worker_company_id is distinct from old.worker_company_id)
     or (new.approved_by_pm_user_id is not null and new.approved_by_pm_user_id is distinct from old.approved_by_pm_user_id)
     or (new.locked_by is not null and new.locked_by is distinct from old.locked_by)
     or (new.pay_period_id is not null and new.pay_period_id is distinct from old.pay_period_id) then
    raise exception 'A locked time entry cannot change; correct it instead';
  end if;
  return new;
end $$;

create trigger time_entries_locked_guard before update or delete on public.time_entries
  for each row execute function public.guard_locked_time_entry();

create table public.labor_rates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  effective_on date not null,
  cost_rate_cents integer not null check (cost_rate_cents >= 0),
  burden_multiplier numeric not null default 1.0 check (burden_multiplier >= 1.0),
  bill_rate_cents integer not null default 0 check (bill_rate_cents >= 0),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id, effective_on)
);
create index labor_rates_user_idx on public.labor_rates (user_id);

create trigger labor_rates_set_updated_at before update on public.labor_rates
  for each row execute function public.tg_set_updated_at();

alter table public.labor_rates enable row level security;
-- Rates are payroll data: a worker reads their own history, and the people who
-- set or pay them read everyone's. Writes go through saveLaborRate on the service client.
revoke insert, update, delete on public.labor_rates from anon, authenticated;
create policy labor_rates_read on public.labor_rates for select
  using (
    ((select auth.role()) = 'service_role')
    or user_id = (select auth.uid())
    or public.has_org_permission(org_id, 'members.manage')
    or public.has_org_permission(org_id, 'time.close')
  );
create policy labor_rates_service_write on public.labor_rates for all
  using ((select auth.role()) = 'service_role')
  with check ((select auth.role()) = 'service_role');

-- Today's member rates become the first history row, effective from the earliest
-- time entry so existing entries keep the rate they were priced at.
insert into public.labor_rates (org_id, user_id, effective_on, cost_rate_cents, burden_multiplier, bill_rate_cents)
select m.org_id, m.user_id,
  coalesce((select min(t.work_date) from public.time_entries t where t.org_id = m.org_id and t.worker_user_id = m.user_id), current_date),
  coalesce(m.labor_cost_rate_cents, 0), greatest(coalesce(m.labor_burden_multiplier, 1.0), 1.0), coalesce(m.labor_bill_rate_cents, 0)
from public.memberships m
where coalesce(m.labor_cost_rate_cents, 0) > 0 or coalesce(m.labor_bill_rate_cents, 0) > 0
on conflict (org_id, user_id, effective_on) do nothing;

insert into public.permissions (key, description) values
  ('time.manage', 'Record and change time for other workers'),
  ('time.close', 'Close pay periods and export payroll hours')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select rp.role_id, 'time.manage'
from public.role_permissions rp
join public.roles r on r.id = rp.role_id
-- Crew clock only themselves: the crew member role and the project field seat
-- crew are assigned through (field, crew) hold time.write, and neither may act for others.
where rp.permission_key = 'time.write' and r.key not in ('org_crew_member', 'field', 'crew')
on conflict (role_id, permission_key) do nothing;

-- Closing a period is a payroll decision: the roles that manage payroll today.
insert into public.role_permissions (role_id, permission_key)
select rp.role_id, 'time.close' from public.role_permissions rp where rp.permission_key = 'payroll.write'
on conflict (role_id, permission_key) do nothing;

-- Closing a period is one transaction: refuse overlap and unfinished work, record
-- the period, lock its approved entries. Service role only; closePayPeriod
-- (lib/services/timesheets.ts) checks time.close first.
create or replace function public.close_pay_period(
  p_org_id uuid,
  p_closed_by uuid,
  p_starts_on date,
  p_ends_on date,
  p_summary jsonb,
  p_import_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_period public.pay_periods;
  v_waiting integer;
  v_names text;
  v_locked integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('pay_period:' || p_org_id::text, 0));
  if exists (select 1 from public.pay_periods where org_id = p_org_id and starts_on = p_starts_on) then
    raise exception 'This pay period is already closed.';
  end if;
  if exists (select 1 from public.pay_periods where org_id = p_org_id and starts_on <= p_ends_on and ends_on >= p_starts_on) then
    raise exception 'This pay period overlaps one that is already closed.';
  end if;

  select count(*) into v_waiting from public.time_entries
  where org_id = p_org_id and work_date between p_starts_on and p_ends_on and status in ('draft', 'submitted');
  if v_waiting > 0 then
    raise exception '% % still waiting for approval. Approve or send them back first.', v_waiting, case when v_waiting = 1 then 'entry is' else 'entries are' end;
  end if;

  select string_agg(distinct coalesce(u.full_name, u.email, 'A worker'), ', ') into v_names
  from public.time_clock_sessions s
  left join public.app_users u on u.id = s.worker_user_id
  where s.org_id = p_org_id and s.ended_at is null and s.work_date between p_starts_on and p_ends_on;
  if v_names is not null then
    raise exception 'Still clocked in: %. Clock them out before closing the period.', v_names;
  end if;

  insert into public.pay_periods (org_id, starts_on, ends_on, closed_at, closed_by, summary, books_payroll_import_id)
  values (p_org_id, p_starts_on, p_ends_on, now(), p_closed_by, coalesce(p_summary, '{}'::jsonb), p_import_id)
  returning * into v_period;

  update public.time_entries
  set status = 'locked', locked_at = v_period.closed_at, locked_by = p_closed_by, pay_period_id = v_period.id
  where org_id = p_org_id and work_date between p_starts_on and p_ends_on and status in ('pm_approved', 'client_approved');
  get diagnostics v_locked = row_count;

  return jsonb_build_object('period', to_jsonb(v_period), 'locked', v_locked);
end $$;

revoke all on function public.close_pay_period(uuid, uuid, date, date, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.close_pay_period(uuid, uuid, date, date, jsonb, uuid) to service_role;

commit;
