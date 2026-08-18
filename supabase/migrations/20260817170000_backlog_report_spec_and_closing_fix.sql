-- Backlog report correctness.
--
-- Two defects in get_sales_backlog_report:
--
-- 1. The `specs` CTE counted any lot carrying a project that had no live
--    reservation and no ACTIVE purchase agreement. A settled home whose lot is
--    already `closed`, and any home sold without first passing through a hold,
--    therefore reappeared as available spec inventory — the sales manager sees
--    houses to sell that are already somebody's home.
--
-- 2. `agreements` left-joined `closings` unfiltered. Cancelled closings are
--    retained rows, so a project that had one cancelled and one live closing
--    fanned out into multiple agreement rows and double-counted backlog units
--    and backlog value. The join now takes only the live closing per project.

begin;

create or replace function public.get_sales_backlog_report(p_org_id uuid, p_division_id uuid default null::uuid)
returns table(
  community_id uuid, community_name text, division_id uuid, lead_units bigint, spec_units bigint,
  hold_units bigint, reserved_units bigint, backlog_units bigint, backlog_value_cents bigint,
  scheduled_30d_units bigint, closed_units_ytd bigint, closed_value_ytd_cents bigint,
  avg_days_agreement_to_close numeric, cancellation_count bigint, cancellation_rate numeric,
  incentive_spend_cents bigint, incentive_percent_of_price numeric
)
language sql
stable
set search_path to 'public', 'pg_catalog'
as $function$
  with community_scope as (
    select c.id, c.name, c.division_id
    from public.communities c
    where c.org_id = p_org_id
      and c.archived_at is null
      and (p_division_id is null or c.division_id = p_division_id)
  ), live_closings as (
    -- One closing per project: cancelled closings are kept for history and must
    -- not multiply the agreement rows they join to.
    select distinct on (cl.project_id) cl.project_id, cl.status, cl.actual_date, cl.scheduled_date, cl.settlement
    from public.closings cl
    where cl.org_id = p_org_id and cl.status <> 'cancelled'
    order by cl.project_id, cl.created_at desc
  ), leads as (
    select p.community_id, count(*) lead_units
    from public.prospects p
    where p.org_id = p_org_id
      and p.community_id is not null
      and p.status in ('new','contacted','qualified','pricing','estimate_sent','changes_requested','client_approved','executed')
    group by p.community_id
  ), agreements as (
    select l.community_id, ct.id, ct.total_cents, ct.status, ct.signed_at,
      coalesce(
        (ct.snapshot #>> '{purchase_agreement,pricing,incentivesCents}')::bigint,
        (ct.snapshot #>> '{purchase_agreement,pricing,incentives_cents}')::bigint,
        0
      ) incentives_cents,
      cl.status closing_status, cl.actual_date, cl.scheduled_date,
      coalesce((cl.settlement->>'final_price_cents')::bigint, ct.total_cents::bigint, 0) final_price_cents
    from public.contracts ct
    join public.lots l on l.org_id = ct.org_id and l.project_id = ct.project_id
    left join live_closings cl on cl.project_id = ct.project_id
    where ct.org_id = p_org_id and ct.contract_type = 'purchase_agreement'
  ), reservation_rollup as (
    select r.community_id,
      count(*) filter (where r.status = 'hold') hold_units,
      count(*) filter (where r.status = 'reserved') reserved_units,
      count(*) filter (where r.status in ('released','expired')) cancellation_count,
      count(*) total_reservations
    from public.lot_reservations r where r.org_id = p_org_id group by r.community_id
  ), agreement_rollup as (
    select a.community_id,
      count(*) filter (where a.status = 'active' and coalesce(a.closing_status, '') <> 'closed') backlog_units,
      coalesce(sum(a.total_cents) filter (where a.status = 'active' and coalesce(a.closing_status, '') <> 'closed'), 0)::bigint backlog_value_cents,
      count(*) filter (where a.closing_status in ('scheduled','cleared_to_close') and a.scheduled_date between current_date and current_date + 30) scheduled_30d_units,
      count(*) filter (where a.closing_status = 'closed' and a.actual_date >= date_trunc('year', current_date)::date) closed_units_ytd,
      coalesce(sum(a.final_price_cents) filter (where a.closing_status = 'closed' and a.actual_date >= date_trunc('year', current_date)::date), 0)::bigint closed_value_ytd_cents,
      round(avg(a.actual_date - a.signed_at::date) filter (where a.closing_status = 'closed' and a.signed_at is not null), 1) avg_days,
      coalesce(sum(a.incentives_cents) filter (where a.status = 'active' or a.closing_status = 'closed'), 0)::bigint incentive_spend,
      coalesce(sum(a.total_cents) filter (where a.status = 'active' or a.closing_status = 'closed'), 0)::bigint agreement_value
    from agreements a group by a.community_id
  ), specs as (
    select l.community_id, count(*) spec_units
    from public.lots l
    where l.org_id = p_org_id and l.project_id is not null
      and l.status <> 'closed'
      and not exists (
        select 1 from public.lot_reservations r
        where r.org_id = l.org_id and r.lot_id = l.id and r.status in ('hold','reserved','converted')
      )
      and not exists (
        select 1 from public.contracts ct
        where ct.org_id = l.org_id and ct.project_id = l.project_id
          and ct.contract_type = 'purchase_agreement' and ct.status = 'active'
      )
      and not exists (
        select 1 from public.closings cl
        where cl.org_id = l.org_id and cl.project_id = l.project_id and cl.status = 'closed'
      )
    group by l.community_id
  )
  select cs.id, cs.name, cs.division_id,
    coalesce(ld.lead_units, 0),
    coalesce(s.spec_units, 0), coalesce(rr.hold_units, 0), coalesce(rr.reserved_units, 0),
    coalesce(ar.backlog_units, 0), coalesce(ar.backlog_value_cents, 0),
    coalesce(ar.scheduled_30d_units, 0), coalesce(ar.closed_units_ytd, 0),
    coalesce(ar.closed_value_ytd_cents, 0), ar.avg_days,
    coalesce(rr.cancellation_count, 0),
    case when coalesce(rr.total_reservations, 0) = 0 then 0
      else round(rr.cancellation_count::numeric * 100 / rr.total_reservations, 2) end,
    coalesce(ar.incentive_spend, 0),
    case when coalesce(ar.agreement_value, 0) = 0 then 0
      else round(ar.incentive_spend::numeric * 100 / ar.agreement_value, 2) end
  from community_scope cs
  left join leads ld on ld.community_id = cs.id
  left join specs s on s.community_id = cs.id
  left join reservation_rollup rr on rr.community_id = cs.id
  left join agreement_rollup ar on ar.community_id = cs.id
  order by cs.name;
$function$;

-- Incentive usage is counted by containment against the agreement pricing
-- snapshot so `max_uses` can be enforced without a denormalised counter.
create index if not exists contracts_snapshot_gin_idx on public.contracts using gin (snapshot jsonb_path_ops);

commit;
