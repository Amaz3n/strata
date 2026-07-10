-- Dashboard rollup functions (July 2026 DB access review, phase 2).
--
-- getControlTowerData previously fetched every org invoice and every posted
-- job-cost entry to compute sums in JS. These functions do the aggregation in
-- SQL so the dashboard ships aggregates, not row sets, over the wire.
--
-- Semantics mirror the JS they replace (lib/services/dashboard.ts):
-- - dashboard_invoice_rollup: non-void invoices, minus reporting-excluded
--   projects (org-level invoices with NULL project_id always count).
--   * total/collected over all rows; overdue = status 'overdue' OR past due
--     with a positive balance.
--   * revenue_series: 12 calendar months keyed 'YYYY-MM' on
--     coalesce(issue_date, created_at).
--   * ar_aging buckets by (current_date - due_date) over positive balances.
-- - dashboard_budget_rollup: latest budget version total + posted job-cost sum
--   per requested project.
--
-- Both are called with the service-role client only; execute is revoked from
-- client-facing roles because they take an arbitrary org id.

create or replace function public.dashboard_invoice_rollup(
  p_org_id uuid,
  p_excluded_project_ids uuid[] default '{}'
)
returns jsonb
language sql
stable
set search_path = public
as $$
  with inv as (
    select
      coalesce(total_cents, 0)::bigint as total_cents,
      coalesce(balance_due_cents, 0)::bigint as balance_cents,
      status,
      due_date,
      coalesce(issue_date::timestamptz, created_at) as issued_at
    from invoices
    where org_id = p_org_id
      and status <> 'void'
      and (project_id is null or not (project_id = any (p_excluded_project_ids)))
  ),
  months as (
    select
      to_char(date_trunc('month', now()) - make_interval(months => g), 'YYYY-MM') as key,
      date_trunc('month', now()) - make_interval(months => g) as month_start
    from generate_series(11, 0, -1) as g
  ),
  series as (
    select m.key, coalesce(sum(i.total_cents), 0)::bigint as revenue_cents
    from months m
    left join inv i
      on i.issued_at >= m.month_start
     and i.issued_at < m.month_start + interval '1 month'
    group by m.key
  ),
  open_balances as (
    select balance_cents, due_date, (current_date - due_date) as days_overdue
    from inv
    where balance_cents > 0
  )
  select jsonb_build_object(
    'total_invoiced', (select coalesce(sum(total_cents), 0) from inv),
    'total_collected', (select coalesce(sum(total_cents - balance_cents), 0) from inv),
    'total_overdue', (
      select coalesce(sum(balance_cents) filter (
        where status = 'overdue'
           or (due_date is not null and due_date < now() and balance_cents > 0)
      ), 0)
      from inv
    ),
    'revenue_series', (
      select jsonb_agg(jsonb_build_object('key', key, 'revenue_cents', revenue_cents) order by key)
      from series
    ),
    'ar_aging', (
      select jsonb_build_object(
        'no_due_date', coalesce(sum(balance_cents) filter (where due_date is null), 0),
        'current', coalesce(sum(balance_cents) filter (where due_date is not null and days_overdue <= 0), 0),
        'one_to_thirty', coalesce(sum(balance_cents) filter (where days_overdue between 1 and 30), 0),
        'thirty_one_to_sixty', coalesce(sum(balance_cents) filter (where days_overdue between 31 and 60), 0),
        'sixty_one_to_ninety', coalesce(sum(balance_cents) filter (where days_overdue between 61 and 90), 0),
        'over_ninety', coalesce(sum(balance_cents) filter (where days_overdue > 90), 0)
      )
      from open_balances
    )
  );
$$;

create or replace function public.dashboard_budget_rollup(
  p_org_id uuid,
  p_project_ids uuid[]
)
returns table (project_id uuid, budget_cents bigint, actual_cents bigint)
language sql
stable
set search_path = public
as $$
  with latest_budget as (
    select distinct on (b.project_id)
      b.project_id,
      coalesce(b.total_cents, 0)::bigint as budget_cents
    from budgets b
    where b.org_id = p_org_id
      and b.project_id = any (p_project_ids)
    order by b.project_id, b.version desc nulls last
  ),
  actuals as (
    select j.project_id, coalesce(sum(j.cost_cents), 0)::bigint as actual_cents
    from job_cost_entries j
    where j.org_id = p_org_id
      and j.project_id = any (p_project_ids)
      and j.status = 'posted'
    group by j.project_id
  )
  select p.pid, coalesce(lb.budget_cents, 0), coalesce(a.actual_cents, 0)
  from unnest(p_project_ids) as p(pid)
  left join latest_budget lb on lb.project_id = p.pid
  left join actuals a on a.project_id = p.pid;
$$;

revoke execute on function public.dashboard_invoice_rollup(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.dashboard_budget_rollup(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.dashboard_invoice_rollup(uuid, uuid[]) to service_role;
grant execute on function public.dashboard_budget_rollup(uuid, uuid[]) to service_role;
