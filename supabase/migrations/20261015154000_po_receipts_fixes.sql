-- A back-ordered line reads by its promised date, not as short.
--
-- list_po_delivery_queue classed a line short whenever its active shortage had a
-- reason other than late, so a back-order (which restarts the clock on a new
-- date) still read short until delivered. Short now means a shortage nobody has
-- answered yet (status open); once purchasing back-orders it the line is
-- expected, late or partial by the promised date. Same signature.

create or replace function public.list_po_delivery_queue(
  p_org_id uuid,
  p_division_ids uuid[],
  p_member_user_id uuid,
  p_community_id uuid,
  p_project_id uuid,
  p_commitment_id uuid,
  p_state text,
  p_today date,
  p_limit integer,
  p_offset integer
)
returns table (
  line_id uuid,
  commitment_id uuid,
  project_id uuid,
  project_name text,
  po_title text,
  contract_number text,
  vendor_name text,
  cost_code_id uuid,
  description text,
  unit text,
  ordered numeric,
  received numeric,
  outstanding numeric,
  needed_by date,
  expected_date date,
  days_late integer,
  state text,
  shortage_id uuid,
  shortage_status text,
  shortage_reason text,
  backorder_date date,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select
      l.id as line_id, c.id as commitment_id, c.project_id, pr.name as project_name, c.title as po_title,
      c.contract_number, co.name as vendor_name, l.cost_code_id, l.description, l.unit,
      l.quantity as ordered,
      public.po_line_received_quantity(l.id) as received,
      l.quantity - public.po_line_received_quantity(l.id) as outstanding,
      l.needed_by,
      coalesce(case when act.status = 'backordered' then act.backorder_date end, l.needed_by) as expected_date,
      c.status as po_status,
      act.id as shortage_id, act.status as shortage_status, act.reason as shortage_reason, act.backorder_date,
      exists (
        select 1 from public.po_shortages f
        where f.commitment_line_id = l.id and f.status in ('vpo', 'accepted_short', 'cancelled')
      ) as closed_out
    from public.commitment_lines l
    join public.commitments c on c.id = l.commitment_id and c.org_id = l.org_id
    join public.projects pr on pr.id = c.project_id and pr.org_id = c.org_id
    left join public.companies co on co.id = c.company_id
    left join lateral (
      select s.id, s.status, s.reason, s.backorder_date from public.po_shortages s
      where s.commitment_line_id = l.id and s.status in ('open', 'backordered') limit 1
    ) act on true
    where l.org_id = p_org_id and l.needed_by is not null
      and c.commitment_type = 'purchase_order' and c.status in ('approved', 'complete')
      and (p_project_id is null or c.project_id = p_project_id)
      and (p_commitment_id is null or c.id = p_commitment_id)
      and (p_division_ids is null or pr.division_id = any (p_division_ids))
      and (p_member_user_id is null or exists (
        select 1 from public.project_members pm
        where pm.org_id = p_org_id and pm.project_id = pr.id and pm.user_id = p_member_user_id and pm.status = 'active'
      ))
      and (p_community_id is null or exists (
        select 1 from public.lots lo
        where lo.org_id = p_org_id and lo.project_id = pr.id and lo.community_id = p_community_id
      ))
  ),
  classified as (
    select b.*,
      case
        when b.outstanding <= 0 then 'received'
        when b.closed_out or b.po_status = 'complete' then 'closed'
        when b.shortage_status = 'open' and b.shortage_reason <> 'late' then 'short'
        when b.expected_date < coalesce(p_today, current_date) then 'late'
        when b.received > 0 then 'partial'
        else 'expected'
      end as state
    from base b
  )
  select x.line_id, x.commitment_id, x.project_id, x.project_name, x.po_title, x.contract_number, x.vendor_name,
    x.cost_code_id, x.description, x.unit, x.ordered, x.received, x.outstanding, x.needed_by, x.expected_date,
    case when x.outstanding > 0 then greatest(coalesce(p_today, current_date) - x.expected_date, 0) else 0 end as days_late,
    x.state, x.shortage_id, x.shortage_status, x.shortage_reason, x.backorder_date,
    count(*) over () as total_count
  from classified x
  where case coalesce(p_state, 'open')
    when 'all' then true
    when 'open' then x.state in ('expected', 'late', 'partial', 'short')
    else x.state = p_state
  end
  order by x.expected_date, x.project_name, x.line_id
  limit greatest(least(coalesce(p_limit, 50), 200), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.list_po_delivery_queue(uuid, uuid[], uuid, uuid, uuid, uuid, text, date, integer, integer) from public, anon, authenticated;
grant execute on function public.list_po_delivery_queue(uuid, uuid[], uuid, uuid, uuid, uuid, text, date, integer, integer) to service_role;

