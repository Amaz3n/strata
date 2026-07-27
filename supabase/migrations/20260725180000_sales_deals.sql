-- Sales deals: one row per buyer deal for the production Sales board.
--
-- A production sale is a single lifecycle — inquiry → working → lot on hold →
-- under contract → building → closing → closed — but it is stored across four
-- tables (prospects, lot_reservations, contracts, closings). The Sales page used
-- to show those as four sibling tabs. This function joins them into the one row
-- a sales consultant actually thinks about, with the stage OBSERVED from real
-- state rather than set from a dropdown, so it can never go stale.
--
-- Anchoring rules (no deal is counted twice):
--   1. A live reservation (hold/reserved/converted) anchors the deal and absorbs
--      its prospect. Released/expired reservations do NOT anchor — the buyer is
--      shopping again, so their prospect keeps the deal.
--   2. A prospect with no live reservation anchors its own deal.
--   3. A project with a purchase agreement but no live reservation anchors a
--      deal (imported backlog, direct spec sales).
--
-- Next-action derivation deliberately lives in TypeScript, not here: it is a
-- pure function of these columns and is far easier to test and tune there.

create or replace function public.get_sales_deals(
  p_org_id uuid,
  p_division_id uuid default null,
  p_community_id uuid default null,
  p_include_closed boolean default true,
  p_limit integer default 500,
  p_deal_id text default null
) returns table (
  deal_id text,
  prospect_id uuid,
  reservation_id uuid,
  contract_id uuid,
  closing_id uuid,
  project_id uuid,
  lot_id uuid,
  community_id uuid,
  community_name text,
  division_id uuid,
  lot_label text,
  plan_name text,
  plan_beds numeric,
  plan_baths numeric,
  plan_sqft integer,
  buyer_name text,
  buyer_phone text,
  buyer_email text,
  owner_user_id uuid,
  source text,
  stage text,
  stage_rank integer,
  price_cents bigint,
  hold_expires_at timestamptz,
  next_follow_up_at timestamptz,
  contract_status text,
  contract_signed_at timestamptz,
  closing_status text,
  closing_scheduled_date date,
  closing_actual_date date,
  open_gate_count bigint,
  is_open boolean,
  created_at timestamptz,
  updated_at timestamptz
) language sql stable security invoker set search_path = public, pg_catalog as $$
  with live_res as (
    select r.id as res_id, r.prospect_id, r.lot_id, r.community_id, l.project_id
    from public.lot_reservations r
    join public.lots l on l.org_id = r.org_id and l.id = r.lot_id
    where r.org_id = p_org_id
      and r.status in ('hold', 'reserved', 'converted')
  ), agreements as (
    select ct.project_id
    from public.contracts ct
    where ct.org_id = p_org_id
      and ct.contract_type = 'purchase_agreement'
      and ct.status = 'active'
  ), anchors as (
    select
      'r:' || lr.res_id::text as deal_id,
      lr.prospect_id,
      lr.res_id as reservation_id,
      lr.lot_id,
      lr.community_id,
      lr.project_id
    from live_res lr

    union all

    select
      'p:' || p.id::text,
      p.id,
      null::uuid,
      null::uuid,
      p.community_id,
      null::uuid
    from public.prospects p
    where p.org_id = p_org_id
      and not exists (select 1 from live_res lr where lr.prospect_id = p.id)

    union all

    select distinct
      'j:' || a.project_id::text,
      null::uuid,
      null::uuid,
      l.id,
      l.community_id,
      a.project_id
    from agreements a
    join public.lots l on l.org_id = p_org_id and l.project_id = a.project_id
    where not exists (select 1 from live_res lr where lr.project_id = a.project_id)
  )
  select
    a.deal_id,
    a.prospect_id,
    a.reservation_id,
    ct.id as contract_id,
    cl.id as closing_id,
    a.project_id,
    a.lot_id,
    a.community_id,
    c.name as community_name,
    c.division_id,
    case
      when l.id is null then null
      when nullif(btrim(coalesce(l.block, '')), '') is not null then l.block || '-' || l.lot_number
      else l.lot_number
    end as lot_label,
    hp.name as plan_name,
    hp.beds as plan_beds,
    hp.baths as plan_baths,
    coalesce(hp.heated_sqft, hp.total_sqft) as plan_sqft,
    coalesce(bc.full_name, pc.full_name, p.name, 'Buyer') as buyer_name,
    coalesce(bc.phone, pc.phone) as buyer_phone,
    coalesce(bc.email::text, pc.email) as buyer_email,
    p.owner_user_id,
    p.source,
    stage.value as stage,
    stage.rank as stage_rank,
    coalesce(
      nullif(cl.settlement ->> 'final_price_cents', '')::bigint,
      ct.total_cents::bigint,
      r.asking_price_cents,
      l.asking_price_override_cents
    ) as price_cents,
    case when r.status = 'hold' then r.expires_at end as hold_expires_at,
    p.next_follow_up_at,
    ct.status as contract_status,
    ct.signed_at as contract_signed_at,
    cl.status as closing_status,
    cl.scheduled_date as closing_scheduled_date,
    cl.actual_date as closing_actual_date,
    coalesce(gates.open_count, 0) as open_gate_count,
    stage.rank between 1 and 6 as is_open,
    coalesce(r.created_at, p.created_at, ct.created_at) as created_at,
    greatest(
      coalesce(r.updated_at, '-infinity'::timestamptz),
      coalesce(p.updated_at, '-infinity'::timestamptz),
      coalesce(cl.updated_at, '-infinity'::timestamptz)
    ) as updated_at
  from anchors a
  left join public.prospects p on p.org_id = p_org_id and p.id = a.prospect_id
  left join public.lot_reservations r on r.org_id = p_org_id and r.id = a.reservation_id
  left join public.lots l on l.org_id = p_org_id and l.id = a.lot_id
  left join public.communities c on c.org_id = p_org_id and c.id = a.community_id
  left join public.house_plans hp on hp.org_id = p_org_id and hp.id = l.house_plan_id
  left join public.contacts bc on bc.org_id = p_org_id and bc.id = r.buyer_contact_id
  left join lateral (
    select ct2.*
    from public.contracts ct2
    where ct2.org_id = p_org_id
      and ct2.project_id = a.project_id
      and ct2.contract_type = 'purchase_agreement'
    order by (ct2.status = 'active') desc, ct2.signed_at desc nulls last
    limit 1
  ) ct on a.project_id is not null
  left join lateral (
    select cl2.*
    from public.closings cl2
    where cl2.org_id = p_org_id
      and cl2.project_id = a.project_id
      and cl2.status <> 'cancelled'
    limit 1
  ) cl on a.project_id is not null
  left join lateral (
    select pc2.*
    from public.prospect_contacts pc2
    where pc2.org_id = p_org_id
      and pc2.prospect_id = a.prospect_id
    order by pc2.is_primary desc, pc2.created_at
    limit 1
  ) pc on a.prospect_id is not null
  left join lateral (
    select count(*) as open_count
    from public.closing_checklist_items i
    where i.org_id = p_org_id
      and i.closing_id = cl.id
      and i.is_gate
      and i.status = 'open'
  ) gates on cl.id is not null
  cross join lateral (
    select
      case
        when cl.status = 'closed' then 'closed'
        when cl.status in ('scheduled', 'cleared_to_close') then 'closing'
        when ct.status = 'active' and l.status = 'started' then 'building'
        when ct.status = 'active' then 'contract'
        when r.status in ('reserved', 'converted') then 'contract'
        when r.status = 'hold' then 'hold'
        when p.status::text = 'lost' then 'lost'
        -- A won prospect with no reservation was converted through the
        -- residential estimate flow; it is sold, not still being worked.
        when p.status::text = 'won' then 'contract'
        when p.status::text = 'new' then 'inquiry'
        else 'working'
      end as value,
      case
        when cl.status = 'closed' then 7
        when cl.status in ('scheduled', 'cleared_to_close') then 6
        when ct.status = 'active' and l.status = 'started' then 5
        when ct.status = 'active' then 4
        when r.status in ('reserved', 'converted') then 4
        when r.status = 'hold' then 3
        when p.status::text = 'lost' then 0
        when p.status::text = 'won' then 4
        when p.status::text = 'new' then 1
        else 2
      end as rank
  ) stage
  where (p_deal_id is null or a.deal_id = p_deal_id)
    and (p_community_id is null or a.community_id = p_community_id)
    and (p_division_id is null or c.division_id = p_division_id or a.community_id is null)
    and (p_include_closed or stage.rank between 1 and 6)
  order by stage.rank between 1 and 6 desc, stage.rank, coalesce(r.created_at, p.created_at, ct.created_at) desc
  limit greatest(p_limit, 1);
$$;

revoke all on function public.get_sales_deals(uuid, uuid, uuid, boolean, integer, text) from public, anon;
grant execute on function public.get_sales_deals(uuid, uuid, uuid, boolean, integer, text) to authenticated, service_role;

comment on function public.get_sales_deals(uuid, uuid, uuid, boolean, integer, text) is
  'One row per production sales deal, joining prospects, lot reservations, purchase agreements and closings into a single observed-stage lifecycle. Powers the Sales board.';
