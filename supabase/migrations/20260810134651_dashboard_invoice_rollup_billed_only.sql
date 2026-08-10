-- dashboard_invoice_rollup: aggregate the BILLED invoice set, not "everything
-- but void".
--
-- The original function (20260710090000_dashboard_rollups.sql) filtered
-- `status <> 'void'`, which counted unsent `draft` and `saved` invoices as
-- receivables. `lib/financials/ledger-status.ts` settled that question for the
-- rest of the app: `sent | partial | paid | overdue` is the only definition of
-- billed, and it is what the projector posts, what `ar_control` ties out
-- against, and what `lib/services/reports/ar-aging.ts` sums. The dashboard was
-- the last surface still disagreeing, so a single saved $50k invoice made the
-- control tower's AR tile and the AR Aging report differ by $50k on adjacent
-- screens.
--
-- The payload gains `billed_only: true`. `lib/services/dashboard.ts` corrects
-- the older payload app-side when that marker is absent, so the desk is right
-- before this migration is deployed and is not double-corrected after; the
-- correction is deleted once this has shipped everywhere.
--
-- Everything else is unchanged: same reporting-project exclusion (org-level
-- invoices with a NULL project_id always count), same 12-month series keyed on
-- coalesce(issue_date, created_at), same aging buckets. Service-role only, as
-- before — the function takes an arbitrary org id, so execute stays revoked
-- from client-facing roles and RLS is not what protects it.

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
      and status in ('sent', 'partial', 'paid', 'overdue')
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
    'billed_only', true,
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

revoke execute on function public.dashboard_invoice_rollup(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.dashboard_invoice_rollup(uuid, uuid[]) to service_role;
