-- Control tower rollup (September 2026).
--
-- The custom-builder home page used to make ~30 PostgREST round trips per
-- load, in dependency chains four deep: org context → reporting exclusions →
-- per-table row slices → bands → the KPI strip, which awaited every one of
-- them. Nothing painted until the slowest chain finished, and the watchlist
-- re-read the same tables a second time under its own context.
--
-- This function answers the whole desk in one round trip: the position of
-- every active job (schedule, tasks, RFIs, submittals, change orders, punch,
-- closeout, AR, AP, budget, POC), the org money position, the decision-queue
-- candidates, and the seven-day field lookahead with its collisions. Ranking
-- and severity stay in application code (`lib/control-tower/*`, pure and
-- tested); SQL only aggregates.
--
-- Definitions are the shared ones, restated because SQL cannot import:
-- - billed invoices: sent | partial | paid | overdue (`BILLED_INVOICE_STATUSES`)
-- - payable bills: approved | partial | paid (`PAYABLE_VENDOR_BILL_STATUSES`),
--   outstanding = total − held retainage − paid, floored at zero
--   (`payableOutstandingCents`)
-- - a project's POC position is its latest snapshot: as_of desc, created_at
--   desc, id desc (`orderPocSnapshotsLatestFirst`)
-- `tests/control-tower.test.js` binds each of these to its TypeScript twin.
--
-- Reporting-excluded projects are dropped from everything; org-level invoices
-- with no project still count, exactly as `dashboard_invoice_rollup` does.
-- `p_project_ids` is the caller's authorization scope — a division-scoped
-- membership passes the projects it may see, null means the whole org — and
-- is never client-originated. Service-role only, like the other rollups: the
-- function takes an arbitrary org id, so grants, not RLS, protect it.

create or replace function public.control_tower_rollup(
  p_org_id uuid,
  p_project_ids uuid[] default null,
  p_today date default current_date,
  p_window_days integer default 7
)
returns jsonb
language sql
stable
set search_path = public, pg_catalog
as $$
  with scope as (
    select
      p.id,
      p.name,
      p.status::text as status,
      p.start_date,
      p.end_date,
      p.client_id,
      p.total_contract_value_cents,
      (p.status in ('active', 'on_hold') and p.phase = 'delivery') as is_active
    from public.projects p
    where p.org_id = p_org_id
      and not p.excluded_from_reporting
      and (p_project_ids is null or p.id = any (p_project_ids))
  ),
  active as (
    select * from scope where is_active
  ),
  active_ids as (
    select coalesce(array_agg(id), '{}'::uuid[]) as ids from active
  ),
  -- Everything the invoice rollup must leave out: reporting-excluded projects
  -- plus every project outside the caller's scope.
  invoice_exclusions as (
    select coalesce(array_agg(p.id), '{}'::uuid[]) as ids
    from public.projects p
    where p.org_id = p_org_id
      and (
        p.excluded_from_reporting
        or (p_project_ids is not null and not (p.id = any (p_project_ids)))
      )
  ),
  sched as (
    select
      s.project_id,
      count(*) filter (where s.status <> 'cancelled') as total,
      count(*) filter (where s.status = 'completed') as completed,
      count(*) filter (where s.status not in ('completed', 'cancelled')) as open,
      count(*) filter (where s.status = 'at_risk') as at_risk,
      count(*) filter (where s.status = 'blocked') as blocked,
      count(*) filter (
        where coalesce(s.is_critical_path, false) and s.status in ('at_risk', 'blocked')
      ) as critical_behind,
      count(*) filter (
        where s.status not in ('completed', 'cancelled') and s.end_date < p_today
      ) as overdue,
      count(*) filter (
        where s.status not in ('completed', 'cancelled')
          and s.end_date >= p_today
          and s.end_date < p_today + p_window_days
      ) as due_window
    from public.schedule_items s
    where s.org_id = p_org_id
      and s.project_id in (select id from active)
    group by s.project_id
  ),
  current_phase as (
    select distinct on (s.project_id) s.project_id, s.phase
    from public.schedule_items s
    where s.org_id = p_org_id
      and s.project_id in (select id from active)
      and s.status not in ('completed', 'cancelled')
      and nullif(btrim(s.phase), '') is not null
      and s.start_date <= p_today
      and coalesce(s.end_date, s.start_date) >= p_today
    order by s.project_id, s.start_date, s.name
  ),
  next_milestone as (
    select distinct on (s.project_id)
      s.project_id,
      s.name,
      s.item_type,
      coalesce(s.start_date, s.end_date) as on_date
    from public.schedule_items s
    where s.org_id = p_org_id
      and s.project_id in (select id from active)
      and s.status not in ('completed', 'cancelled')
      and s.item_type in ('milestone', 'inspection', 'handoff', 'delivery')
      and coalesce(s.start_date, s.end_date) >= p_today
    order by s.project_id, coalesce(s.start_date, s.end_date), s.name
  ),
  tasks_agg as (
    select
      t.project_id,
      count(*) as open,
      count(*) filter (where t.due_date < p_today) as overdue,
      count(*) filter (
        where t.due_date >= p_today and t.due_date < p_today + p_window_days
      ) as due_window
    from public.tasks t
    where t.org_id = p_org_id
      and t.status::text <> 'done'
      and (t.project_id is null or t.project_id in (select id from active))
    group by t.project_id
  ),
  rfis_agg as (
    select
      r.project_id,
      count(*) as open,
      count(*) filter (where r.due_date < p_today) as overdue
    from public.rfis r
    where r.org_id = p_org_id
      and r.status = 'open'
      and r.project_id in (select id from scope)
    group by r.project_id
  ),
  submittals_agg as (
    select s.project_id, count(*) as pending
    from public.submittals s
    where s.org_id = p_org_id
      and s.status in ('pending', 'submitted', 'in_review')
      and s.project_id in (select id from scope)
    group by s.project_id
  ),
  cos_agg as (
    select
      c.project_id,
      count(*) as pending,
      coalesce(sum(abs(c.total_cents)), 0)::bigint as pending_cents
    from public.change_orders c
    where c.org_id = p_org_id
      and c.status = 'pending'
      and c.project_id in (select id from scope)
    group by c.project_id
  ),
  punch_agg as (
    select
      p.project_id,
      count(*) as open,
      count(*) filter (where p.severity in ('high', 'urgent')) as urgent
    from public.punch_items p
    where p.org_id = p_org_id
      and p.status in ('open', 'in_progress')
      and p.project_id in (select id from scope)
    group by p.project_id
  ),
  closeout_agg as (
    select c.project_id, count(*) as missing
    from public.closeout_items c
    where c.org_id = p_org_id
      and c.status = 'missing'
      and c.project_id in (select id from active)
    group by c.project_id
  ),
  ar_agg as (
    select
      i.project_id,
      coalesce(sum(i.balance_due_cents) filter (where i.balance_due_cents > 0), 0)::bigint as open_cents,
      coalesce(sum(i.balance_due_cents) filter (
        where i.balance_due_cents > 0 and (i.status = 'overdue' or i.due_date < p_today)
      ), 0)::bigint as overdue_cents
    from public.invoices i
    where i.org_id = p_org_id
      and i.status in ('sent', 'partial', 'paid', 'overdue')
      and i.project_id in (select id from scope)
    group by i.project_id
  ),
  bills as (
    select
      b.id,
      b.project_id,
      b.company_id,
      b.status,
      b.bill_number,
      b.created_at,
      b.due_date,
      coalesce(b.total_cents, 0)::bigint as total_cents,
      greatest(
        0,
        coalesce(b.total_cents, 0)
          - greatest(0, coalesce(b.retainage_cents, 0) - coalesce(b.retainage_released_cents, 0))
          - coalesce(b.paid_cents, 0)
      )::bigint as outstanding_cents
    from public.vendor_bills b
    where b.org_id = p_org_id
      and b.project_id in (select id from scope)
  ),
  ap_agg as (
    select
      project_id,
      coalesce(sum(outstanding_cents) filter (
        where status in ('approved', 'partial', 'paid')
      ), 0)::bigint as unpaid_cents,
      count(*) filter (
        where status in ('approved', 'partial', 'paid') and outstanding_cents > 0
      ) as unpaid_count,
      count(*) filter (where status = 'pending') as pending_count,
      coalesce(sum(total_cents) filter (where status = 'pending'), 0)::bigint as pending_cents
    from bills
    group by project_id
  ),
  ready_agg as (
    select c.project_id, coalesce(sum(c.billable_cents), 0)::bigint as cents
    from public.billable_costs c
    where c.org_id = p_org_id
      and c.status = 'open'
      and c.is_billable
      and c.project_id in (select id from scope)
    group by c.project_id
  ),
  budget_agg as (
    select *
    from public.dashboard_budget_rollup(p_org_id, (select ids from active_ids))
  ),
  poc_latest as (
    select distinct on (ps.project_id)
      ps.project_id,
      ps.as_of,
      ps.percent_complete,
      ps.over_under_cents
    from public.poc_snapshots ps
    where ps.org_id = p_org_id
      and ps.project_id in (select id from active)
    order by ps.project_id, ps.as_of desc, ps.created_at desc, ps.id desc
  ),
  project_rows as (
    select
      a.id,
      a.name,
      a.status,
      a.start_date,
      a.end_date,
      a.total_contract_value_cents as contract_cents,
      ct.full_name as client_name,
      cp.phase as current_phase,
      nm.name as next_milestone_name,
      nm.item_type as next_milestone_type,
      nm.on_date as next_milestone_date,
      coalesce(sc.total, 0) as sched_total,
      coalesce(sc.completed, 0) as sched_completed,
      coalesce(sc.open, 0) as sched_open,
      coalesce(sc.at_risk, 0) as sched_at_risk,
      coalesce(sc.blocked, 0) as sched_blocked,
      coalesce(sc.critical_behind, 0) as sched_critical_behind,
      coalesce(sc.overdue, 0) as sched_overdue,
      coalesce(sc.due_window, 0) as sched_due_window,
      coalesce(ta.open, 0) as tasks_open,
      coalesce(ta.overdue, 0) as tasks_overdue,
      coalesce(ta.due_window, 0) as tasks_due_window,
      coalesce(rf.open, 0) as rfis_open,
      coalesce(rf.overdue, 0) as rfis_overdue,
      coalesce(su.pending, 0) as submittals_pending,
      coalesce(co.pending, 0) as cos_pending,
      coalesce(co.pending_cents, 0) as cos_pending_cents,
      coalesce(pu.open, 0) as punch_open,
      coalesce(pu.urgent, 0) as punch_urgent,
      coalesce(cl.missing, 0) as closeout_missing,
      coalesce(ar.open_cents, 0) as ar_open_cents,
      coalesce(ar.overdue_cents, 0) as ar_overdue_cents,
      coalesce(ap.unpaid_cents, 0) as ap_unpaid_cents,
      coalesce(ap.unpaid_count, 0) as ap_unpaid_count,
      coalesce(ap.pending_count, 0) as ap_pending_count,
      coalesce(rd.cents, 0) as ready_to_bill_cents,
      coalesce(bu.budget_cents, 0) as budget_cents,
      coalesce(bu.actual_cents, 0) as actual_cents,
      pl.as_of as poc_as_of,
      pl.percent_complete as poc_percent_complete,
      pl.over_under_cents as poc_over_under_cents
    from active a
    left join public.contacts ct on ct.id = a.client_id and ct.org_id = p_org_id
    left join current_phase cp on cp.project_id = a.id
    left join next_milestone nm on nm.project_id = a.id
    left join sched sc on sc.project_id = a.id
    left join tasks_agg ta on ta.project_id = a.id
    left join rfis_agg rf on rf.project_id = a.id
    left join submittals_agg su on su.project_id = a.id
    left join cos_agg co on co.project_id = a.id
    left join punch_agg pu on pu.project_id = a.id
    left join closeout_agg cl on cl.project_id = a.id
    left join ar_agg ar on ar.project_id = a.id
    left join ap_agg ap on ap.project_id = a.id
    left join ready_agg rd on rd.project_id = a.id
    left join budget_agg bu on bu.project_id = a.id
    left join poc_latest pl on pl.project_id = a.id
  ),
  -- Decision candidates. Each source is capped oldest-first so the rows that
  -- have waited longest always travel; the uncapped totals are in `counts`.
  decision_candidates as (
    (
      select
        'change_order' as kind, c.id, c.project_id, c.title, c.created_at,
        null::date as due_date, c.total_cents::bigint as cents, c.days_impact as days,
        null::text as priority, c.co_number::text as reference
      from public.change_orders c
      where c.org_id = p_org_id
        and c.status = 'pending'
        and c.project_id in (select id from scope)
      order by c.created_at
      limit 40
    )
    union all
    (
      select
        'rfi', r.id, r.project_id, r.subject, r.created_at,
        r.due_date, r.cost_impact_cents::bigint, r.schedule_impact_days,
        r.priority, r.rfi_number::text
      from public.rfis r
      where r.org_id = p_org_id
        and r.status = 'open'
        and r.project_id in (select id from scope)
      order by r.created_at
      limit 40
    )
    union all
    (
      select
        'submittal', s.id, s.project_id, s.title, s.created_at,
        s.due_date, null::bigint, s.lead_time_days,
        null::text, s.submittal_number::text
      from public.submittals s
      where s.org_id = p_org_id
        and s.status in ('pending', 'submitted', 'in_review')
        and s.project_id in (select id from scope)
      order by s.created_at
      limit 40
    )
    union all
    (
      select
        'vendor_bill', b.id, b.project_id,
        coalesce(cm.name, 'Vendor bill') || coalesce(' · #' || nullif(b.bill_number, ''), ''),
        b.created_at, b.due_date, b.total_cents, null::integer,
        null::text, b.bill_number
      from bills b
      left join public.companies cm on cm.id = b.company_id and cm.org_id = p_org_id
      where b.status = 'pending'
      order by b.created_at
      limit 40
    )
    union all
    (
      select
        'punch_item', p.id, p.project_id, p.title, p.created_at,
        p.due_date, null::bigint, null::integer,
        p.severity, null::text
      from public.punch_items p
      where p.org_id = p_org_id
        and p.status in ('open', 'in_progress')
        and p.severity in ('high', 'urgent')
        and p.project_id in (select id from scope)
      order by p.created_at
      limit 40
    )
  ),
  lookahead_items as (
    (
      select
        'schedule_start' as kind, s.id::text || ':start' as id, s.project_id,
        s.name as title, s.start_date as on_date, s.item_type, s.trade,
        s.status, coalesce(s.is_critical_path, false) as is_critical_path
      from public.schedule_items s
      where s.org_id = p_org_id
        and s.project_id in (select id from active)
        and s.status not in ('completed', 'cancelled')
        and s.start_date >= p_today
        and s.start_date < p_today + p_window_days
    )
    union all
    (
      select
        'schedule_finish', s.id::text || ':finish', s.project_id,
        s.name, s.end_date, s.item_type, s.trade,
        s.status, coalesce(s.is_critical_path, false)
      from public.schedule_items s
      where s.org_id = p_org_id
        and s.project_id in (select id from active)
        and s.status not in ('completed', 'cancelled')
        and s.end_date >= p_today
        and s.end_date < p_today + p_window_days
        and (s.start_date is null or s.start_date <> s.end_date)
    )
    union all
    (
      select
        'task_due', t.id::text || ':task', t.project_id,
        t.title, t.due_date, null::text, null::text,
        t.status::text, false
      from public.tasks t
      where t.org_id = p_org_id
        and t.status::text <> 'done'
        and (t.project_id is null or t.project_id in (select id from active))
        and t.due_date >= p_today
        and t.due_date < p_today + p_window_days
    )
  ),
  -- Every open item active on each day of the window, for the collision scan.
  day_items as (
    select
      d.day::date as day,
      s.id,
      s.project_id,
      nullif(btrim(s.trade), '') as trade,
      s.assigned_to
    from generate_series(p_today, p_today + (p_window_days - 1), interval '1 day') as d(day)
    join public.schedule_items s
      on s.org_id = p_org_id
      and s.project_id in (select id from active)
      and s.status not in ('completed', 'cancelled')
      and s.start_date is not null
      and s.start_date <= d.day::date
      and coalesce(s.end_date, s.start_date) >= d.day::date
  ),
  trade_overlaps as (
    select day, trade, count(distinct project_id) as projects
    from day_items
    where trade is not null
    group by day, trade
    having count(distinct project_id) >= 2
  ),
  assignee_overlaps as (
    select day, assigned_to, count(distinct project_id) as projects
    from day_items
    where assigned_to is not null
    group by day, assigned_to
    having count(distinct project_id) >= 2
  ),
  day_stats as (
    select
      di.day,
      count(*) as active_items,
      count(distinct di.project_id) as project_count,
      (
        select coalesce(
          jsonb_agg(jsonb_build_object('trade', t.trade, 'projects', t.projects) order by t.projects desc, t.trade),
          '[]'::jsonb
        )
        from trade_overlaps t
        where t.day = di.day
      ) as trade_overlaps,
      (
        select coalesce(
          jsonb_agg(jsonb_build_object('assignee', a.assigned_to, 'projects', a.projects) order by a.projects desc),
          '[]'::jsonb
        )
        from assignee_overlaps a
        where a.day = di.day
      ) as assignee_overlaps
    from day_items di
    group by di.day
  ),
  counts as (
    select
      (select count(*) from active) as active_projects,
      (select coalesce(sum(due_window), 0) from tasks_agg) as tasks_due_window,
      (select coalesce(sum(overdue), 0) from tasks_agg) as tasks_overdue,
      (select coalesce(sum(due_window), 0) from sched) as sched_due_window,
      (select coalesce(sum(overdue), 0) from sched) as sched_overdue,
      (select coalesce(sum(pending), 0) from cos_agg) as cos_pending,
      (select coalesce(sum(open), 0) from rfis_agg) as rfis_open,
      (select coalesce(sum(pending), 0) from submittals_agg) as submittals_pending,
      (select coalesce(sum(pending_count), 0) from ap_agg) as bills_pending,
      (select coalesce(sum(open), 0) from punch_agg) as punch_open,
      (select coalesce(sum(urgent), 0) from punch_agg) as punch_urgent
  ),
  money as (
    select
      public.dashboard_invoice_rollup(p_org_id, (select ids from invoice_exclusions)) as invoice_rollup,
      (select coalesce(sum(unpaid_cents), 0) from ap_agg) as unpaid_bills_cents,
      (select coalesce(sum(unpaid_count), 0) from ap_agg) as unpaid_bills_count,
      (select coalesce(sum(pending_cents), 0) from ap_agg) as pending_bills_cents,
      (select coalesce(sum(pending_count), 0) from ap_agg) as pending_bills_count,
      (select coalesce(sum(cents), 0) from ready_agg) as ready_to_bill_cents,
      (select count(*) from ready_agg where cents > 0) as ready_to_bill_projects
  ),
  overdue_invoices as (
    select
      i.id,
      i.invoice_number,
      i.project_id,
      s.name as project_name,
      coalesce(i.balance_due_cents, 0)::bigint as balance_cents,
      i.due_date,
      greatest(0, p_today - i.due_date) as days_overdue
    from public.invoices i
    left join scope s on s.id = i.project_id
    where i.org_id = p_org_id
      and i.status in ('sent', 'partial', 'paid', 'overdue')
      and coalesce(i.balance_due_cents, 0) > 0
      and (i.status = 'overdue' or i.due_date < p_today)
      and (i.project_id is null or s.id is not null)
    order by i.due_date asc nulls last, i.balance_due_cents desc
    limit 8
  ),
  wip as (
    select
      max(pl.as_of) as as_of,
      count(*) as project_count,
      coalesce(sum(pl.over_under_cents), 0)::bigint as net_cents,
      coalesce(sum(pl.over_under_cents) filter (where pl.over_under_cents > 0), 0)::bigint as over_billed_cents,
      coalesce(sum(-pl.over_under_cents) filter (where pl.over_under_cents < 0), 0)::bigint as under_billed_cents,
      (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'project_id', x.project_id,
              'project_name', x.name,
              'over_under_cents', x.over_under_cents,
              'percent_complete', x.percent_complete
            )
            order by x.over_under_cents
          ),
          '[]'::jsonb
        )
        from (
          select pl2.project_id, a.name, pl2.over_under_cents, pl2.percent_complete
          from poc_latest pl2
          join active a on a.id = pl2.project_id
          where pl2.over_under_cents < 0
          order by pl2.over_under_cents
          limit 5
        ) x
      ) as most_under_billed
    from poc_latest pl
  )
  select jsonb_build_object(
    'today', p_today,
    'window_days', p_window_days,
    'projects_by_status', (
      select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb)
      from (select status, count(*) as n from scope group by status) x
    ),
    'counts', (select to_jsonb(c) from counts c),
    'money', (select to_jsonb(m) from money m),
    'overdue_invoices', (
      select coalesce(jsonb_agg(to_jsonb(o) order by o.days_overdue desc, o.balance_cents desc), '[]'::jsonb)
      from overdue_invoices o
    ),
    'wip', (select to_jsonb(w) from wip w),
    'projects', (
      select coalesce(jsonb_agg(to_jsonb(r) order by r.name), '[]'::jsonb)
      from project_rows r
    ),
    'decisions', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'kind', d.kind,
            'id', d.id,
            'project_id', d.project_id,
            'project_name', s.name,
            'title', d.title,
            'reference', d.reference,
            'created_at', d.created_at,
            'due_date', d.due_date,
            'cents', d.cents,
            'days', d.days,
            'priority', d.priority
          )
          order by d.created_at
        ),
        '[]'::jsonb
      )
      from decision_candidates d
      left join scope s on s.id = d.project_id
    ),
    'lookahead', jsonb_build_object(
      'items', (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'kind', li.kind,
              'id', li.id,
              'project_id', li.project_id,
              'project_name', s.name,
              'title', li.title,
              'date', li.on_date,
              'item_type', li.item_type,
              'trade', li.trade,
              'status', li.status,
              'is_critical_path', li.is_critical_path
            )
            order by li.on_date, li.is_critical_path desc, li.title
          ),
          '[]'::jsonb
        )
        from (
          select * from lookahead_items
          order by on_date, is_critical_path desc, title
          limit 150
        ) li
        left join scope s on s.id = li.project_id
      ),
      'days', (
        select coalesce(jsonb_agg(to_jsonb(ds) order by ds.day), '[]'::jsonb)
        from day_stats ds
      )
    )
  );
$$;

revoke all on function public.control_tower_rollup(uuid, uuid[], date, integer)
  from public, anon, authenticated;
grant execute on function public.control_tower_rollup(uuid, uuid[], date, integer)
  to service_role;
