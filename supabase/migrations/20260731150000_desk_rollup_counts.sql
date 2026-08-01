-- Desk rollup counters.
--
-- The sidebar's review badges were four unbounded `select project_id` row-pulls
-- counted in JS on every render. This replaces them with a trigger-maintained
-- counter table: exact, transactional, no refresh cadence, no extension
-- dependency, and no materialized view (the one MV in this system refreshes
-- non-concurrently and has already caused an ACCESS EXCLUSIVE incident — that
-- pattern is deliberately not copied here).
--
-- NOT covered here, on purpose: the "ready to bill — draws" badge. Its predicate
-- is `status = 'pending' and due_date <= today`, which is time-relative — the
-- count changes at midnight without any row being written, so no write-triggered
-- counter can stay correct. That badge stays a live query, which is safe because
-- it is already bounded by status and date.

create table public.desk_rollup_counts (
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null check (kind in ('review_time','review_expenses','review_bills','review_costs')),
  count integer not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (org_id, project_id, kind)
);

create index desk_rollup_counts_org_kind_idx
  on public.desk_rollup_counts (org_id, kind)
  where count > 0;

alter table public.desk_rollup_counts enable row level security;

create policy desk_rollup_counts_read on public.desk_rollup_counts for select to authenticated
  using (public.has_org_permission(org_id, 'invoice.read'));

grant select on public.desk_rollup_counts to authenticated;
grant all on public.desk_rollup_counts to service_role;

-- The predicates, written exactly once. The trigger, the backfill and the drift
-- verifier all call this, so they cannot disagree. These mirror the filters in
-- lib/services/navigation-badges.ts.
create or replace function public.desk_rollup_is_counted(p_kind text, p_row jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_catalog
as $$
  select case p_kind
    when 'review_time'     then (p_row->>'status') in ('submitted','pm_approved')
    when 'review_expenses' then (p_row->>'status') in ('draft','submitted')
    when 'review_bills'    then (p_row->>'status') = 'pending'
    when 'review_costs'    then (p_row->>'status') = 'open'
                            and (p_row->>'is_billable')::boolean is true
    else false
  end;
$$;

create or replace function public.tg_desk_rollup_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_kind text := tg_argv[0];
  v_old jsonb;
  v_new jsonb;
  v_old_counted boolean := false;
  v_new_counted boolean := false;
  v_old_org uuid;
  v_old_project uuid;
  v_new_org uuid;
  v_new_project uuid;
  v_moved boolean;
begin
  if tg_op in ('UPDATE','DELETE') then
    v_old := to_jsonb(old);
    v_old_counted := public.desk_rollup_is_counted(v_kind, v_old);
    v_old_org := (v_old->>'org_id')::uuid;
    v_old_project := (v_old->>'project_id')::uuid;
  end if;

  if tg_op in ('INSERT','UPDATE') then
    v_new := to_jsonb(new);
    v_new_counted := public.desk_rollup_is_counted(v_kind, v_new);
    v_new_org := (v_new->>'org_id')::uuid;
    v_new_project := (v_new->>'project_id')::uuid;
  end if;

  -- A row that changed project (or org) has to leave the old bucket even when
  -- it still counts.
  v_moved := v_new_org is distinct from v_old_org
          or v_new_project is distinct from v_old_project;

  if v_old_counted and v_old_project is not null and (not v_new_counted or v_moved) then
    insert into public.desk_rollup_counts (org_id, project_id, kind, count)
    values (v_old_org, v_old_project, v_kind, 0)
    on conflict (org_id, project_id, kind) do update
      set count = greatest(0, public.desk_rollup_counts.count - 1),
          updated_at = now();
  end if;

  if v_new_counted and v_new_project is not null and (not v_old_counted or v_moved) then
    insert into public.desk_rollup_counts (org_id, project_id, kind, count)
    values (v_new_org, v_new_project, v_kind, 1)
    on conflict (org_id, project_id, kind) do update
      set count = public.desk_rollup_counts.count + 1,
          updated_at = now();
  end if;

  return null;
end;
$$;

create trigger time_entries_desk_rollup
  after insert or update or delete on public.time_entries
  for each row execute function public.tg_desk_rollup_sync('review_time');

create trigger project_expenses_desk_rollup
  after insert or update or delete on public.project_expenses
  for each row execute function public.tg_desk_rollup_sync('review_expenses');

create trigger vendor_bills_desk_rollup
  after insert or update or delete on public.vendor_bills
  for each row execute function public.tg_desk_rollup_sync('review_bills');

create trigger billable_costs_desk_rollup
  after insert or update or delete on public.billable_costs
  for each row execute function public.tg_desk_rollup_sync('review_costs');

-- Live truth, from the same predicate the triggers use. Used by the backfill
-- below and by the drift verifier.
create or replace function public.desk_rollup_live()
returns table (org_id uuid, project_id uuid, kind text, count integer)
language sql
stable
set search_path = public, pg_catalog
as $$
  select t.org_id, t.project_id, 'review_time'::text, count(*)::integer
  from public.time_entries t
  where t.project_id is not null
    and public.desk_rollup_is_counted('review_time', to_jsonb(t))
  group by t.org_id, t.project_id
  union all
  select e.org_id, e.project_id, 'review_expenses'::text, count(*)::integer
  from public.project_expenses e
  where e.project_id is not null
    and public.desk_rollup_is_counted('review_expenses', to_jsonb(e))
  group by e.org_id, e.project_id
  union all
  select b.org_id, b.project_id, 'review_bills'::text, count(*)::integer
  from public.vendor_bills b
  where b.project_id is not null
    and public.desk_rollup_is_counted('review_bills', to_jsonb(b))
  group by b.org_id, b.project_id
  union all
  select c.org_id, c.project_id, 'review_costs'::text, count(*)::integer
  from public.billable_costs c
  where c.project_id is not null
    and public.desk_rollup_is_counted('review_costs', to_jsonb(c))
  group by c.org_id, c.project_id;
$$;

-- Backfill from current data.
insert into public.desk_rollup_counts (org_id, project_id, kind, count)
select org_id, project_id, kind, count from public.desk_rollup_live()
on conflict (org_id, project_id, kind) do update
  set count = excluded.count, updated_at = now();

-- Drift verifier. A trigger bug must be detectable, so this is meant to be run
-- nightly and alerted on: any row it returns is a discrepancy between the stored
-- counter and the live predicate.
create or replace function public.desk_rollup_drift()
returns table (org_id uuid, project_id uuid, kind text, stored_count integer, live_count integer)
language sql
stable
set search_path = public, pg_catalog
as $$
  select
    coalesce(s.org_id, l.org_id),
    coalesce(s.project_id, l.project_id),
    coalesce(s.kind, l.kind),
    coalesce(s.count, 0),
    coalesce(l.count, 0)
  from public.desk_rollup_counts s
  full outer join public.desk_rollup_live() l
    on l.org_id = s.org_id and l.project_id = s.project_id and l.kind = s.kind
  where coalesce(s.count, 0) is distinct from coalesce(l.count, 0);
$$;

grant execute on function public.desk_rollup_drift() to service_role;
grant execute on function public.desk_rollup_live() to service_role;
