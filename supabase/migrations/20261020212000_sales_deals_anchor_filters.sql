-- get_sales_deals at first-builder size (EP13, review C-M4).
--
-- The sales board's read built every deal the organization ever had (ten years
-- of closed homes included), joined each one's contacts, plan and closing gates,
-- and only then filtered by division, community and open-or-closed and applied
-- its row cap: 0.8-1.2 s for a 500-home builder's open board, most of it spent
-- on deals the board was about to drop. Now the anchor-only filters (deal id,
-- community, division, and for an open board the homes whose every live closing
-- is closed and the lost prospects) run first, the stage is computed from the
-- five rows that decide it, the board is ordered and capped there, and the
-- display joins run only for the rows kept. Results are unchanged: every row an
-- anchor filter drops is one the old final WHERE dropped too.

create or replace function public.get_sales_deals(p_org_id uuid, p_division_id uuid DEFAULT NULL::uuid, p_community_id uuid DEFAULT NULL::uuid, p_include_closed boolean DEFAULT true, p_limit integer DEFAULT 500, p_deal_id text DEFAULT NULL::text, p_include_communityless boolean DEFAULT true)
 RETURNS TABLE(deal_id text, prospect_id uuid, reservation_id uuid, contract_id uuid, closing_id uuid, project_id uuid, lot_id uuid, community_id uuid, community_name text, division_id uuid, lot_label text, plan_name text, plan_beds numeric, plan_baths numeric, plan_sqft integer, buyer_name text, buyer_phone text, buyer_email text, owner_user_id uuid, source text, stage text, stage_rank integer, price_cents bigint, hold_expires_at timestamp with time zone, next_follow_up_at timestamp with time zone, contract_status text, contract_signed_at timestamp with time zone, closing_status text, closing_scheduled_date date, closing_actual_date date, open_gate_count bigint, is_open boolean, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
as $function$
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
  ), all_anchors as (
    select
      'r:' || lr.res_id::text as deal_id,
      lr.prospect_id,
      lr.res_id as reservation_id,
      lr.lot_id,
      lr.community_id,
      lr.project_id,
      false as lost_prospect
    from live_res lr

    union all

    select
      'p:' || p.id::text,
      p.id,
      null::uuid,
      null::uuid,
      p.community_id,
      null::uuid,
      p.status::text = 'lost'
    from public.prospects p
    where p.org_id = p_org_id
      and not exists (select 1 from live_res lr where lr.prospect_id = p.id)
      and (p_include_communityless or p.community_id is not null)

    union all

    select distinct
      'j:' || a.project_id::text,
      null::uuid,
      null::uuid,
      l.id,
      l.community_id,
      a.project_id,
      false
    from agreements a
    join public.lots l on l.org_id = p_org_id and l.project_id = a.project_id
    where not exists (select 1 from live_res lr where lr.project_id = a.project_id)
  ), anchors as (
    -- The filters that depend only on the anchor run before any deal is built,
    -- so an open-deals read of one community never assembles ten years of
    -- closed homes. A home is cut here only when every live closing it has is
    -- closed, so the closing the deal reads below is closed and its stage would
    -- be 'closed' anyway; a lost prospect with no reservation is always 'lost'.
    select aa.*
    from all_anchors aa
    where (p_deal_id is null or aa.deal_id = p_deal_id)
      and (p_community_id is null or aa.community_id = p_community_id)
      and (p_division_id is null or aa.community_id is null or exists (
        select 1 from public.communities c0 where c0.org_id = p_org_id and c0.id = aa.community_id and c0.division_id = p_division_id))
      and (p_include_closed or (
        not aa.lost_prospect
        and not (aa.project_id is not null
          and exists (select 1 from public.closings x where x.org_id = p_org_id and x.project_id = aa.project_id and x.status = 'closed')
          and not exists (select 1 from public.closings x where x.org_id = p_org_id and x.project_id = aa.project_id and x.status not in ('cancelled', 'closed')))
      ))
  ), staged as (
    -- Stage needs only the reservation, prospect, lot, agreement and closing:
    -- the board is ordered and capped here, and the rest is read for the rows kept.
    select
      a.*,
      ct.id as contract_id, ct.status as contract_status, ct.signed_at as contract_signed_at,
      ct.total_cents as contract_total_cents, ct.created_at as contract_created_at,
      cl.id as closing_id, cl.status as closing_status, cl.scheduled_date as closing_scheduled_date,
      cl.actual_date as closing_actual_date, cl.settlement as closing_settlement, cl.updated_at as closing_updated_at,
      stage.value as stage, stage.rank as stage_rank,
      coalesce(r.created_at, p.created_at, ct.created_at) as sort_created_at
    from anchors a
    left join public.prospects p on p.org_id = p_org_id and p.id = a.prospect_id
    left join public.lot_reservations r on r.org_id = p_org_id and r.id = a.reservation_id
    left join public.lots l on l.org_id = p_org_id and l.id = a.lot_id
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
    where (p_include_closed or stage.rank between 1 and 6)
    order by stage.rank between 1 and 6 desc, stage.rank, coalesce(r.created_at, p.created_at, ct.created_at) desc
    limit greatest(p_limit, 1)
  )
  select
    s.deal_id,
    s.prospect_id,
    s.reservation_id,
    s.contract_id,
    s.closing_id,
    s.project_id,
    s.lot_id,
    s.community_id,
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
    s.stage,
    s.stage_rank,
    coalesce(
      nullif(coalesce(s.closing_settlement ->> 'finalPriceCents', s.closing_settlement ->> 'final_price_cents'), '')::bigint,
      s.contract_total_cents::bigint,
      r.asking_price_cents,
      l.asking_price_override_cents
    ) as price_cents,
    case when r.status = 'hold' then r.expires_at end as hold_expires_at,
    p.next_follow_up_at,
    s.contract_status,
    s.contract_signed_at,
    s.closing_status,
    s.closing_scheduled_date,
    s.closing_actual_date,
    coalesce(gates.open_count, 0) as open_gate_count,
    s.stage_rank between 1 and 6 as is_open,
    s.sort_created_at as created_at,
    greatest(
      coalesce(r.updated_at, '-infinity'::timestamptz),
      coalesce(p.updated_at, '-infinity'::timestamptz),
      coalesce(s.closing_updated_at, '-infinity'::timestamptz)
    ) as updated_at
  from staged s
  left join public.prospects p on p.org_id = p_org_id and p.id = s.prospect_id
  left join public.lot_reservations r on r.org_id = p_org_id and r.id = s.reservation_id
  left join public.lots l on l.org_id = p_org_id and l.id = s.lot_id
  left join public.communities c on c.org_id = p_org_id and c.id = s.community_id
  left join public.house_plans hp on hp.org_id = p_org_id and hp.id = l.house_plan_id
  left join public.contacts bc on bc.org_id = p_org_id and bc.id = r.buyer_contact_id
  left join lateral (
    select pc2.*
    from public.prospect_contacts pc2
    where pc2.org_id = p_org_id
      and pc2.prospect_id = s.prospect_id
    order by pc2.is_primary desc, pc2.created_at
    limit 1
  ) pc on s.prospect_id is not null
  left join lateral (
    select count(*) as open_count
    from public.closing_checklist_items i
    where i.org_id = p_org_id
      and i.closing_id = s.closing_id
      and i.is_gate
      and i.status = 'open'
  ) gates on s.closing_id is not null
  order by s.stage_rank between 1 and 6 desc, s.stage_rank, s.sort_created_at desc;
$function$;
