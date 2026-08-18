-- Warranty operations hardening.
--
-- Three defects and one gap, all in the same blast radius:
--
--  1. `affected_home_percent` divided each group's affected homes by the
--     org-wide closed-home count while computing a correct per-group
--     `closed_home_count` on the very next line. Every per-plan and per-trade
--     recurring-defect rate was understated by that group's share of volume,
--     which is exactly the number purchasing is supposed to act on.
--  2. Warranty cost counted trade backcharges only. A builder whose own
--     technicians do the work read as near-zero against the 0.7-1.0%-of-revenue
--     benchmark this analytic exists to report, so self-performed labor and
--     materials are now captured on the visit and included.
--  3. Requests with backcharges from two different trades were counted twice in
--     `request_count`, because the per-request grouping carried the backcharge
--     company. Costs are pre-aggregated per request now; one request counts once
--     and attributes to the trade that owns it.
--  4. The 30-day and 11-month courtesy inspections had no home in the schema.

alter table public.warranty_service_visits
  add column if not exists labor_hours numeric(6,2)
    check (labor_hours is null or (labor_hours >= 0 and labor_hours <= 24)),
  add column if not exists labor_rate_cents bigint
    check (labor_rate_cents is null or labor_rate_cents >= 0),
  add column if not exists internal_labor_cents bigint not null default 0
    check (internal_labor_cents >= 0),
  add column if not exists internal_material_cents bigint not null default 0
    check (internal_material_cents >= 0);

comment on column public.warranty_service_visits.internal_labor_cents is
  'Self-performed technician labor for this visit (labor_hours x labor_rate_cents). Counted as warranty cost and never recoverable from a trade.';
comment on column public.warranty_service_visits.internal_material_cents is
  'Materials consumed on this visit and paid by the builder.';

-- Dispatch conflict detection reads the live windows of a single assignee around
-- a candidate slot; the SLA sweep pages through overdue open requests.
create index if not exists warranty_service_visits_tech_window_idx
  on public.warranty_service_visits (org_id, assigned_user_id, window_start)
  where assigned_user_id is not null and status not in ('canceled', 'completed');
create index if not exists warranty_service_visits_trade_window_idx
  on public.warranty_service_visits (org_id, assigned_company_id, window_start)
  where assigned_company_id is not null and status not in ('canceled', 'completed');
create index if not exists warranty_requests_resolution_sweep_idx
  on public.warranty_requests (resolution_due_at)
  where status in ('open', 'in_progress');
create index if not exists warranty_requests_first_response_sweep_idx
  on public.warranty_requests (first_response_due_at)
  where status in ('open', 'in_progress') and first_responded_at is null;

-- One courtesy inspection per home per milestone, however often the generator
-- runs. The application checks first; this is the race guard.
create unique index if not exists warranty_requests_courtesy_milestone_idx
  on public.warranty_requests (org_id, project_id, (metadata ->> 'courtesy_milestone'))
  where (metadata ->> 'courtesy_milestone') is not null;

-- The org-wide variant was superseded by the scoped one in July 2026 and has no
-- caller left in the application; it only carried the same denominator bug.
drop function if exists public.warranty_defect_analysis(uuid, text, timestamptz, timestamptz);

create or replace function public.warranty_defect_analysis_scoped(
  p_org_id uuid,
  p_group_by text,
  p_project_ids uuid[] default null,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  group_id text,
  group_name text,
  request_count bigint,
  affected_home_count bigint,
  closed_home_count bigint,
  affected_home_percent numeric,
  remediation_cost_cents bigint,
  recovered_cents bigint,
  average_cost_cents bigint,
  top_categories jsonb
)
language sql
stable
set search_path = public, pg_catalog
as $$
  with request_backcharges as (
    select
      wb.warranty_request_id,
      sum(wb.amount_cents)::bigint as backcharge_cents,
      sum(wb.recovered_cents)::bigint as recovered_cents
    from public.warranty_backcharges wb
    where wb.org_id = p_org_id
    group by wb.warranty_request_id
  ), request_backcharge_company as (
    select distinct on (wb.warranty_request_id)
      wb.warranty_request_id,
      wb.company_id
    from public.warranty_backcharges wb
    where wb.org_id = p_org_id
    order by wb.warranty_request_id, wb.created_at
  ), request_internal as (
    select
      v.request_id,
      sum(coalesce(v.internal_labor_cents, 0) + coalesce(v.internal_material_cents, 0))::bigint as internal_cents
    from public.warranty_service_visits v
    where v.org_id = p_org_id
      and v.status = 'completed'
    group by v.request_id
  ), request_base as (
    select
      wr.id,
      wr.project_id,
      wr.category,
      coalesce(wr.assigned_company_id, rbc.company_id) as company_id,
      wr.cost_code_id,
      l.community_id,
      l.house_plan_version_id,
      hpv.house_plan_id,
      (coalesce(rb.backcharge_cents, 0) + coalesce(ri.internal_cents, 0))::bigint as remediation_cost_cents,
      coalesce(rb.recovered_cents, 0)::bigint as recovered_cents,
      case p_group_by
        when 'community' then l.community_id::text
        when 'company' then coalesce(wr.assigned_company_id, rbc.company_id)::text
        when 'cost_code' then wr.cost_code_id::text
        when 'plan_version' then l.house_plan_version_id::text
        when 'plan' then hpv.house_plan_id::text
      end as group_id
    from public.warranty_requests wr
    left join request_backcharges rb on rb.warranty_request_id = wr.id
    left join request_backcharge_company rbc on rbc.warranty_request_id = wr.id
    left join request_internal ri on ri.request_id = wr.id
    left join public.lots l on l.org_id = wr.org_id and l.project_id = wr.project_id
    left join public.house_plan_versions hpv
      on hpv.org_id = wr.org_id and hpv.id = l.house_plan_version_id
    where wr.org_id = p_org_id
      and (p_project_ids is null or wr.project_id = any (p_project_ids))
      and (p_from is null or wr.created_at >= p_from)
      and (p_to is null or wr.created_at < p_to)
      and p_group_by in ('community','company','cost_code','plan_version','plan')
      -- Scheduled courtesy walks are a ritual, not a reported defect.
      and (wr.metadata ->> 'courtesy_milestone') is null
  ), names as (
    select rb.*,
      case p_group_by
        when 'community' then c.name
        when 'company' then co.name
        when 'cost_code' then concat_ws(' — ', cc.code, cc.name)
        when 'plan_version' then concat_ws(
          ' — ',
          hp.code,
          coalesce(hpv.label, 'Version ' || hpv.version_number::text)
        )
        when 'plan' then concat_ws(' — ', hp.code, hp.name)
      end as group_name
    from request_base rb
    left join public.communities c
      on p_group_by = 'community' and c.id::text = rb.group_id
    left join public.companies co
      on p_group_by = 'company' and co.id::text = rb.group_id
    left join public.cost_codes cc
      on p_group_by = 'cost_code' and cc.id::text = rb.group_id
    left join public.house_plan_versions hpv
      on p_group_by = 'plan_version' and hpv.id::text = rb.group_id
    left join public.house_plans hp
      on hp.id = coalesce(
        hpv.house_plan_id,
        case
          when p_group_by = 'plan' and rb.group_id is not null
            then rb.group_id::uuid
        end
      )
    where rb.group_id is not null
  ), totals as (
    select
      n.group_id,
      max(n.group_name) as group_name,
      count(*) as request_count,
      count(distinct n.project_id) as affected_home_count,
      sum(n.remediation_cost_cents)::bigint as remediation_cost_cents,
      sum(n.recovered_cents)::bigint as recovered_cents
    from names n
    group by n.group_id
  ), categories as (
    select
      group_id,
      coalesce(
        jsonb_agg(
          jsonb_build_object('category', category, 'count', category_count)
          order by category_count desc, category
        ) filter (where category_rank <= 3),
        '[]'::jsonb
      ) as top_categories
    from (
      select
        group_id,
        coalesce(category, 'Uncategorized') as category,
        count(*) as category_count,
        row_number() over (
          partition by group_id
          order by count(*) desc, coalesce(category, 'Uncategorized')
        ) as category_rank
      from names
      group by group_id, coalesce(category, 'Uncategorized')
    ) ranked
    group by group_id
  ), scoped_closed as (
    select
      cl.project_id,
      l.community_id,
      l.house_plan_version_id,
      hpv.house_plan_id
    from public.closings cl
    left join public.lots l
      on l.org_id = cl.org_id and l.project_id = cl.project_id
    left join public.house_plan_versions hpv
      on hpv.org_id = cl.org_id and hpv.id = l.house_plan_version_id
    where cl.org_id = p_org_id
      and cl.status = 'closed'
      and (p_project_ids is null or cl.project_id = any (p_project_ids))
  ), group_closed as (
    select
      t.group_id,
      (
        select count(*)
        from scoped_closed cl
        where case p_group_by
          when 'community' then cl.community_id::text = t.group_id
          when 'plan_version' then cl.house_plan_version_id::text = t.group_id
          when 'plan' then cl.house_plan_id::text = t.group_id
          else true
        end
      )::bigint as closed_home_count
    from totals t
  )
  select
    t.group_id,
    t.group_name,
    t.request_count,
    t.affected_home_count,
    gc.closed_home_count,
    -- The rate this group failed at, against this group's own volume. Dividing
    -- by org-wide closings understated every plan by its share of the business.
    round(
      t.affected_home_count * 100.0 / nullif(gc.closed_home_count, 0),
      2
    ) as affected_home_percent,
    t.remediation_cost_cents,
    t.recovered_cents,
    case
      when t.request_count = 0 then 0
      else (t.remediation_cost_cents / t.request_count)::bigint
    end as average_cost_cents,
    c.top_categories
  from totals t
  join categories c using (group_id)
  join group_closed gc using (group_id)
  order by t.request_count desc, t.group_name;
$$;

revoke all on function public.warranty_defect_analysis_scoped(
  uuid,
  text,
  uuid[],
  timestamptz,
  timestamptz
) from public, anon, authenticated;
grant execute on function public.warranty_defect_analysis_scoped(
  uuid,
  text,
  uuid[],
  timestamptz,
  timestamptz
) to service_role;

create or replace function public.warranty_cost_summary(p_org_id uuid, p_community_id uuid default null)
returns table (
  community_id uuid,
  community_name text,
  warranty_cost_cents bigint,
  recovered_cents bigint,
  net_cost_cents bigint,
  closed_revenue_cents bigint,
  cost_percent numeric
)
language sql
stable
set search_path = public, pg_catalog
as $$
  with project_backcharges as (
    select
      wb.project_id,
      sum(wb.amount_cents)::bigint as cost_cents,
      sum(wb.recovered_cents)::bigint as recovered_cents
    from public.warranty_backcharges wb
    where wb.org_id = p_org_id
    group by wb.project_id
  ), project_internal as (
    select
      v.project_id,
      sum(coalesce(v.internal_labor_cents, 0) + coalesce(v.internal_material_cents, 0))::bigint as internal_cents
    from public.warranty_service_visits v
    where v.org_id = p_org_id
      and v.status = 'completed'
    group by v.project_id
  ), community_costs as (
    select
      c.id as community_id,
      c.name as community_name,
      -- Total spend, not just what a trade was billed for. Self-performed work
      -- is real money and is what the industry benchmark measures.
      (coalesce(sum(pb.cost_cents), 0) + coalesce(sum(iv.internal_cents), 0))::bigint as warranty_cost_cents,
      coalesce(sum(pb.recovered_cents), 0)::bigint as recovered_cents
    from public.communities c
    left join public.lots l on l.org_id = c.org_id and l.community_id = c.id
    left join project_backcharges pb on pb.project_id = l.project_id
    left join project_internal iv on iv.project_id = l.project_id
    where c.org_id = p_org_id and (p_community_id is null or c.id = p_community_id)
    group by c.id, c.name
  ), revenue as (
    select cl.community_id,
      sum(coalesce((cl.settlement->>'final_price_cents')::bigint, i.total_cents::bigint, 0))::bigint closed_revenue_cents
    from public.closings cl
    left join public.invoices i on i.org_id = cl.org_id and i.id = cl.closing_invoice_id
    where cl.org_id = p_org_id and cl.status = 'closed'
    group by cl.community_id
  )
  select cc.community_id, cc.community_name, cc.warranty_cost_cents, cc.recovered_cents,
    (cc.warranty_cost_cents - cc.recovered_cents)::bigint net_cost_cents,
    coalesce(r.closed_revenue_cents, 0)::bigint closed_revenue_cents,
    case when coalesce(r.closed_revenue_cents, 0) > 0
      then round((cc.warranty_cost_cents - cc.recovered_cents) * 100.0 / r.closed_revenue_cents, 3)
      else null end cost_percent
  from community_costs cc left join revenue r on r.community_id = cc.community_id
  order by cc.community_name;
$$;

revoke all on function public.warranty_cost_summary(uuid, uuid) from public, anon;
grant execute on function public.warranty_cost_summary(uuid, uuid) to authenticated, service_role;
