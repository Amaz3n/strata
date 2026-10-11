-- Variance analysis reads the report window as an exclusive timestamp range,
-- the same [start, end) the division-scoped TypeScript path uses
-- (utcReportDateRange), instead of casting approved_at to a date in the session
-- timezone. The old (uuid, date, date) signature is dropped: nothing else calls it.

drop function if exists public.get_variance_analysis(uuid, date, date);

create function public.get_variance_analysis(
  p_org_id uuid,
  p_start timestamptz,
  p_end_exclusive timestamptz
) returns table (
  dimension text,
  dimension_id text,
  dimension_label text,
  net_variance_cents bigint,
  absolute_variance_cents bigint,
  incidence bigint,
  direct_cost_budget_cents bigint,
  variance_rate numeric
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with approved_vpos as (
    select
      cco.id,
      cco.project_id,
      cco.reason_code_id,
      cco.total_cents::bigint,
      cco.approved_at,
      c.company_id,
      l.community_id,
      l.house_plan_id,
      coalesce(l.division_id, p.division_id) as division_id
    from public.commitment_change_orders cco
    join public.commitments c on c.id = cco.commitment_id and c.org_id = cco.org_id
    join public.projects p on p.id = cco.project_id and p.org_id = cco.org_id
    left join public.lots l on l.project_id = p.id and l.org_id = p.org_id
    where cco.org_id = p_org_id
      and cco.status = 'approved'
      and cco.reason_code_id is not null
      and cco.approved_at >= p_start
      and cco.approved_at < p_end_exclusive
  ),
  project_budgets as (
    select distinct on (b.project_id)
      b.project_id, coalesce(b.total_cents, 0)::bigint as budget_cents
    from public.budgets b
    where b.org_id = p_org_id
    order by b.project_id, b.version desc
  ),
  superintendent as (
    select distinct on (pm.project_id)
      pm.project_id, pm.user_id, coalesce(u.full_name, u.email::text, 'Unassigned') as label
    from public.project_members pm
    join public.roles r on r.id = pm.role_id and r.key = 'field'
    join public.app_users u on u.id = pm.user_id
    where pm.org_id = p_org_id and pm.status = 'active'
    order by pm.project_id, pm.created_at
  ),
  expanded as (
    select 'reason'::text dimension, v.reason_code_id::text dimension_id,
      coalesce(rc.label, 'Unclassified')::text dimension_label, v.*
    from approved_vpos v left join public.variance_reason_codes rc on rc.id = v.reason_code_id
    union all
    select 'community', v.community_id::text, coalesce(cm.name, 'No community'), v.*
    from approved_vpos v left join public.communities cm on cm.id = v.community_id
    union all
    select 'plan', v.house_plan_id::text, coalesce(hp.name, 'No plan'), v.*
    from approved_vpos v left join public.house_plans hp on hp.id = v.house_plan_id
    union all
    select 'division', v.division_id::text, coalesce(d.name, 'Main'), v.*
    from approved_vpos v left join public.divisions d on d.id = v.division_id
    union all
    select 'vendor', v.company_id::text, coalesce(co.name, 'No vendor'), v.*
    from approved_vpos v left join public.companies co on co.id = v.company_id
    union all
    select 'superintendent', s.user_id::text, coalesce(s.label, 'Unassigned'), v.*
    from approved_vpos v left join superintendent s on s.project_id = v.project_id
    union all
    select 'month', to_char(v.approved_at at time zone 'UTC', 'YYYY-MM'), to_char(v.approved_at at time zone 'UTC', 'Mon YYYY'), v.*
    from approved_vpos v
  ),
  grouped_vpo as (
    select
      e.dimension,
      coalesce(e.dimension_id, '') as dimension_id,
      e.dimension_label,
      sum(e.total_cents)::bigint as net_variance_cents,
      sum(abs(e.total_cents))::bigint as absolute_variance_cents,
      count(*)::bigint as incidence
    from expanded e
    group by e.dimension, coalesce(e.dimension_id, ''), e.dimension_label
  ),
  covered_projects as (
    select distinct e.dimension, coalesce(e.dimension_id, '') as dimension_id,
      e.dimension_label, e.project_id
    from expanded e
  ),
  grouped_budget as (
    select cp.dimension, cp.dimension_id, cp.dimension_label,
      coalesce(sum(pb.budget_cents), 0)::bigint as direct_cost_budget_cents
    from covered_projects cp
    left join project_budgets pb on pb.project_id = cp.project_id
    group by cp.dimension, cp.dimension_id, cp.dimension_label
  )
  select g.dimension, g.dimension_id, g.dimension_label, g.net_variance_cents,
    g.absolute_variance_cents, g.incidence, b.direct_cost_budget_cents,
    case when b.direct_cost_budget_cents = 0 then 0::numeric
      else g.absolute_variance_cents::numeric / b.direct_cost_budget_cents end
  from grouped_vpo g
  join grouped_budget b using (dimension, dimension_id, dimension_label)
  order by g.dimension, g.absolute_variance_cents desc, g.dimension_label;
$$;

grant execute on function public.get_variance_analysis(uuid, timestamptz, timestamptz) to authenticated, service_role;
