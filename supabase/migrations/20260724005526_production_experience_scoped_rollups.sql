-- Workstream 10 production-experience rollups.
--
-- Warranty analytics previously accepted only an organization id, which meant a
-- division-scoped service could not safely request plan/company/cost-code groups.
-- This service-role RPC accepts the already-authorized project-id intersection.

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
  with request_base as (
    select
      wr.id,
      wr.project_id,
      wr.category,
      coalesce(wr.assigned_company_id, wb.company_id) as company_id,
      wr.cost_code_id,
      l.community_id,
      l.house_plan_version_id,
      hpv.house_plan_id,
      coalesce(sum(wb.amount_cents), 0)::bigint as remediation_cost_cents,
      coalesce(sum(wb.recovered_cents), 0)::bigint as recovered_cents,
      case p_group_by
        when 'community' then l.community_id::text
        when 'company' then coalesce(wr.assigned_company_id, wb.company_id)::text
        when 'cost_code' then wr.cost_code_id::text
        when 'plan_version' then l.house_plan_version_id::text
        when 'plan' then hpv.house_plan_id::text
      end as group_id
    from public.warranty_requests wr
    left join public.warranty_backcharges wb
      on wb.org_id = wr.org_id and wb.warranty_request_id = wr.id
    left join public.lots l on l.org_id = wr.org_id and l.project_id = wr.project_id
    left join public.house_plan_versions hpv
      on hpv.org_id = wr.org_id and hpv.id = l.house_plan_version_id
    where wr.org_id = p_org_id
      and (p_project_ids is null or wr.project_id = any (p_project_ids))
      and (p_from is null or wr.created_at >= p_from)
      and (p_to is null or wr.created_at < p_to)
      and p_group_by in ('community','company','cost_code','plan_version','plan')
    group by wr.id, wr.project_id, wr.category, wr.assigned_company_id,
      wb.company_id, wr.cost_code_id, l.community_id, l.house_plan_version_id,
      hpv.house_plan_id
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
  )
  select
    t.group_id,
    t.group_name,
    t.request_count,
    t.affected_home_count,
    (
      select count(*)
      from scoped_closed cl
      where case p_group_by
        when 'community' then cl.community_id::text = t.group_id
        when 'plan_version' then cl.house_plan_version_id::text = t.group_id
        when 'plan' then cl.house_plan_id::text = t.group_id
        else true
      end
    )::bigint as closed_home_count,
    round(
      t.affected_home_count * 100.0
      / nullif((select count(*) from scoped_closed), 0),
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

-- Home stat bands must return aggregates at the 200-active-home design case.
-- The server supplies an authorization-scoped project/community set; the
-- function never accepts a client-originated scope.
create or replace function public.production_home_stat_rollup(
  p_org_id uuid,
  p_project_ids uuid[],
  p_community_ids uuid[],
  p_week_start date,
  p_month_start date,
  p_month_end date
)
returns jsonb
language sql
stable
set search_path = public, pg_catalog
as $$
  with scoped_projects as (
    select p.id, p.end_date
    from public.projects p
    where p.org_id = p_org_id
      and p.id = any (p_project_ids)
  ), start_stats as (
    select
      count(*) filter (
        where sp.status = 'released' and sp.target_week = p_week_start
      )::bigint as starts_released
    from public.start_packages sp
    where sp.org_id = p_org_id
      and sp.project_id = any (p_project_ids)
  ), slot_stats as (
    select coalesce(sum(crs.target_starts), 0)::bigint as starts_target
    from public.community_release_slots crs
    where crs.org_id = p_org_id
      and crs.community_id = any (p_community_ids)
      and crs.week_start = p_week_start
  ), closing_stats as (
    select
      count(*) filter (where cl.status = 'scheduled')::bigint as scheduled,
      count(*) filter (
        where cl.status in ('cleared_to_close', 'closed')
      )::bigint as cleared,
      coalesce(
        sum(coalesce((cl.settlement->>'final_price_cents')::bigint, 0)),
        0
      )::bigint as value_cents
    from public.closings cl
    where cl.org_id = p_org_id
      and cl.project_id = any (p_project_ids)
      and cl.scheduled_date between p_month_start and p_month_end
      and cl.status <> 'cancelled'
  ), cycle_stats as (
    select round(avg(p.end_date - sp.actual_start_date))::bigint as average_days
    from public.start_packages sp
    join scoped_projects p on p.id = sp.project_id
    where sp.org_id = p_org_id
      and sp.status = 'released'
      and sp.actual_start_date is not null
      and p.end_date is not null
  ), vpo_stats as (
    select coalesce(sum(cco.total_cents), 0)::bigint as week_cents
    from public.commitment_change_orders cco
    where cco.org_id = p_org_id
      and cco.project_id = any (p_project_ids)
      and cco.reason_code_id is not null
      and cco.status in ('draft', 'sent', 'approved', 'executed')
      and cco.created_at >= p_week_start::timestamptz
      and cco.created_at < (p_week_start + 7)::timestamptz
  ), direct_cost_stats as (
    select coalesce(sum(jce.cost_cents), 0)::bigint as direct_cost_cents
    from public.job_cost_entries jce
    where jce.org_id = p_org_id
      and jce.project_id = any (p_project_ids)
      and jce.status = 'posted'
  )
  select jsonb_build_object(
    'starts_released', (select starts_released from start_stats),
    'starts_target', (select starts_target from slot_stats),
    'closings_scheduled', (select scheduled from closing_stats),
    'closings_cleared', (select cleared from closing_stats),
    'closing_value_cents', (select value_cents from closing_stats),
    'under_construction', cardinality(p_project_ids),
    'average_cycle_days', (select average_days from cycle_stats),
    'vpo_week_cents', (select week_cents from vpo_stats),
    'direct_cost_cents', (select direct_cost_cents from direct_cost_stats)
  );
$$;

revoke all on function public.production_home_stat_rollup(
  uuid,
  uuid[],
  uuid[],
  date,
  date,
  date
) from public, anon, authenticated;
grant execute on function public.production_home_stat_rollup(
  uuid,
  uuid[],
  uuid[],
  date,
  date,
  date
) to service_role;
