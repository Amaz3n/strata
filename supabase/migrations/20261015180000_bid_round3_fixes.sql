-- EP08 review round 3 (R3-A): bids and price book.
--
-- 1. A member cannot re-point a bid invite to another vendor, contact or address.
-- 2. A price repriced after an award keeps the award's id, so rescinding the
--    award voids the whole chain it minted and puts back what the award displaced.
-- 3. Award and rescind take the scope lock first and the row locks after, in the
--    same order, so the two never deadlock on one package.

-- 1. The invite is the vendor's identity on a package.

create or replace function public.tg_bid_invite_member_fence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and (
       new.company_id is distinct from old.company_id
    or new.contact_id is distinct from old.contact_id
    or new.invite_email is distinct from old.invite_email
  ) then
    raise exception 'An invite belongs to the vendor it was sent to; invite the other vendor instead' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger bid_invites_member_fence before update on public.bid_invites
  for each row execute function public.tg_bid_invite_member_fence();

-- 2. Lineage through a reprice.

create or replace function public.reprice_vendor_price_agreement(
  p_org_id uuid,
  p_agreement_id uuid,
  p_effective_from date,
  p_unit_cost_cents bigint default null,
  p_lump_sum_cents bigint default null,
  p_notes text default null,
  p_actor_id uuid default null,
  p_reason text default null
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
declare
  v_old public.vendor_price_agreements%rowtype;
  v_new_id uuid;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required to reprice an agreement';
  end if;
  select * into v_old from public.vendor_price_agreements
    where org_id = p_org_id and id = p_agreement_id for update;
  if not found then raise exception 'Price agreement not found'; end if;
  if v_old.status <> 'active' then raise exception 'Only active agreements can be repriced'; end if;
  if p_effective_from <= v_old.effective_from then
    raise exception 'Reprice effective date must follow the current agreement start';
  end if;
  if v_old.effective_to is not null and p_effective_from > v_old.effective_to then
    raise exception 'Reprice effective date must fall before the agreement ends';
  end if;
  if v_old.pricing_kind = 'unit' and (p_unit_cost_cents is null or p_lump_sum_cents is not null) then
    raise exception 'Unit repricing requires unit cost only';
  end if;
  if v_old.pricing_kind = 'lump_sum' and (p_lump_sum_cents is null or p_unit_cost_cents is not null) then
    raise exception 'Lump-sum repricing requires lump sum only';
  end if;

  insert into public.vendor_price_agreements (
    org_id, company_id, cost_code_id, cost_type, division_id, community_id,
    house_plan_id, house_plan_version_id, pricing_kind, uom, unit_cost_cents,
    lump_sum_cents, scope_of_work, effective_from, effective_to, status,
    source, source_bid_award_id, notes, metadata, created_by
  ) values (
    v_old.org_id, v_old.company_id, v_old.cost_code_id, v_old.cost_type,
    v_old.division_id, v_old.community_id, v_old.house_plan_id,
    v_old.house_plan_version_id, v_old.pricing_kind, v_old.uom,
    p_unit_cost_cents, p_lump_sum_cents, v_old.scope_of_work, p_effective_from,
    v_old.effective_to, 'active', 'manual', v_old.source_bid_award_id, p_notes,
    (v_old.metadata - 'supersedes') || jsonb_build_object('repriced_from_id', v_old.id, 'reprice_reason', btrim(p_reason)),
    p_actor_id
  ) returning id into v_new_id;

  update public.vendor_price_agreements set
    status = 'superseded', superseded_by_id = v_new_id,
    effective_to = p_effective_from - 1
  where org_id = p_org_id and id = v_old.id;
  return v_new_id;
end;
$$;

revoke all on function public.reprice_vendor_price_agreement(uuid, uuid, date, bigint, bigint, text, uuid, text) from public, anon, authenticated;
grant execute on function public.reprice_vendor_price_agreement(uuid, uuid, date, bigint, bigint, text, uuid, text) to service_role;

-- 3. Award and rescind, one lock order.

CREATE OR REPLACE FUNCTION public.run_bid_award_price_agreements(p_org_id uuid, p_bid_submission_id uuid, p_awarded_by uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_accepted_alternate_ids uuid[] DEFAULT '{}'::uuid[], p_effective_from date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_submission public.bid_submissions%rowtype;
  v_invite public.bid_invites%rowtype;
  v_package public.bid_packages%rowtype;
  v_existing_award public.bid_awards%rowtype;
  v_award public.bid_awards%rowtype;
  v_item record;
  v_agreement_id uuid;
  v_agreement_ids uuid[] := '{}';
  v_displaced_ids uuid[] := '{}';
  v_displaced jsonb;
  v_effective_from date := coalesce(p_effective_from, current_date);
  v_end date := v_effective_from - 1;
  v_scope_community uuid;
  v_scope_plan uuid;
begin
  if v_effective_from < current_date or v_effective_from > current_date + 366 then
    raise exception 'The price takes effect from today up to a year ahead';
  end if;

  -- The scope lock first, exactly as rescind takes it, then the rows: an award
  -- and a rescind for one package queue on that lock instead of each holding the
  -- row the other wants. The scope is read unlocked, then re-checked under the lock.
  select p.* into v_package from public.bid_packages p
    join public.bid_invites i on i.org_id = p.org_id and i.bid_package_id = p.id
    join public.bid_submissions s on s.org_id = i.org_id and s.bid_invite_id = i.id
    where s.org_id = p_org_id and s.id = p_bid_submission_id;
  if not found then raise exception 'Bid submission not found'; end if;
  v_scope_community := v_package.community_id;
  v_scope_plan := v_package.house_plan_id;
  perform pg_advisory_xact_lock(hashtextextended(
    'price_book_scope:' || p_org_id::text || ':' || coalesce(v_scope_community::text, '') || ':' || coalesce(v_scope_plan::text, ''), 0));

  select * into v_submission from public.bid_submissions
    where org_id = p_org_id and id = p_bid_submission_id for update;
  if not found then raise exception 'Bid submission not found'; end if;
  if not coalesce(v_submission.is_current, false) then
    raise exception 'Only the current submission can be awarded';
  end if;

  select * into v_invite from public.bid_invites
    where org_id = p_org_id and id = v_submission.bid_invite_id for update;
  if not found then raise exception 'Bid invite not found'; end if;

  select * into v_package from public.bid_packages
    where org_id = p_org_id and id = v_invite.bid_package_id for update;
  if not found then raise exception 'Bid package not found'; end if;
  if v_package.community_id is distinct from v_scope_community or v_package.house_plan_id is distinct from v_scope_plan then
    raise exception 'The bid package changed while it was being awarded; try again';
  end if;
  if v_package.award_target <> 'price_agreement' or v_package.project_id is not null
      or v_package.prospect_id is not null then
    raise exception 'Bid package is not a price-agreement package';
  end if;
  if v_package.status = 'cancelled' then raise exception 'Cannot award a cancelled bid package'; end if;

  select * into v_existing_award from public.bid_awards
    where org_id = p_org_id and bid_package_id = v_package.id and rescinded_at is null
    order by awarded_at desc limit 1 for update;
  if found then
    if v_existing_award.awarded_submission_id = p_bid_submission_id then
      return jsonb_build_object(
        'award_id', v_existing_award.id,
        'bid_package_id', v_package.id,
        'agreement_ids', coalesce((select jsonb_agg(id) from public.vendor_price_agreements
          where source_bid_award_id = v_existing_award.id), '[]'::jsonb),
        'displaced_ids', '[]'::jsonb
      );
    end if;
    raise exception 'This bid package has already been awarded';
  end if;

  insert into public.bid_awards (
    org_id, bid_package_id, awarded_submission_id, awarded_commitment_id,
    awarded_by, notes, accepted_alternate_ids
  ) values (
    p_org_id, v_package.id, v_submission.id, null, p_awarded_by, p_notes,
    coalesce(p_accepted_alternate_ids, '{}')
  ) returning * into v_award;

  for v_item in
    select
      i.id,
      i.description,
      i.amount_cents,
      i.unit_rate_cents,
      i.quantity,
      s.cost_code_id,
      s.item_type,
      s.unit,
      s.details
    from public.bid_submission_items i
    join public.bid_scope_items s on s.id = i.bid_scope_item_id and s.org_id = i.org_id and s.bid_package_id = v_package.id
    where i.org_id = p_org_id
      and i.bid_submission_id = v_submission.id
      and i.response = 'priced'
      and i.amount_cents is not null
      and s.cost_code_id is not null
      and (s.item_type <> 'alternate' or s.id = any(coalesce(p_accepted_alternate_ids, '{}')))
    order by s.position, i.created_at
  loop
    if v_item.unit is null and v_package.house_plan_id is null then
      raise exception 'Lump-sum price agreements require a house plan';
    end if;

    -- The price this one replaces: the same scope, whichever vendor holds it.
    -- Rows of this award are never displaced by it.
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', old.id, 'prior_effective_to', old.effective_to, 'prior_status', old.status,
             'new_effective_to', case when old.effective_from < v_effective_from then v_end else old.effective_from end
           )), '[]'::jsonb),
           coalesce(array_agg(old.id), '{}')
      into v_displaced, v_displaced_ids
    from public.vendor_price_agreements old
    where old.org_id = p_org_id
      and old.cost_code_id = v_item.cost_code_id
      and old.cost_type is null
      and old.division_id is null
      and old.community_id is not distinct from v_package.community_id
      and old.house_plan_id is not distinct from v_package.house_plan_id
      and old.house_plan_version_id is null
      and old.status = 'active'
      and old.effective_from <= v_effective_from
      and coalesce(old.effective_to, 'infinity'::date) >= v_effective_from
      and old.source_bid_award_id is distinct from v_award.id;

    update public.vendor_price_agreements old
    set effective_to = case when old.effective_from < v_effective_from then v_end else old.effective_from end,
        -- A price that starts in the future leaves the incumbent in force until
        -- the day before; maintenance expires it on the way past. One that was
        -- itself due to start on the same day never takes effect at all.
        status = case when v_effective_from <= current_date or old.effective_from = v_effective_from then 'superseded' else old.status end
    where old.org_id = p_org_id and old.id = any(v_displaced_ids) and old.status = 'active';

    insert into public.vendor_price_agreements (
      org_id, company_id, cost_code_id, community_id, house_plan_id,
      pricing_kind, uom, unit_cost_cents, lump_sum_cents, scope_of_work,
      effective_from, status, source, source_bid_award_id, notes, created_by,
      metadata
    ) values (
      p_org_id, v_invite.company_id, v_item.cost_code_id, v_package.community_id,
      v_package.house_plan_id,
      case when v_item.unit is null then 'lump_sum' else 'unit' end,
      v_item.unit,
      case when v_item.unit is not null then coalesce(v_item.unit_rate_cents,
        round(v_item.amount_cents / greatest(coalesce(v_item.quantity, 1), 1))::bigint) end,
      case when v_item.unit is null then v_item.amount_cents::bigint end,
      coalesce(v_item.details, v_item.description),
      v_effective_from, 'active', 'bid_award', v_award.id, p_notes, p_awarded_by,
      jsonb_build_object('bid_submission_item_id', v_item.id, 'bid_package_id', v_package.id, 'supersedes', v_displaced)
    ) returning id into v_agreement_id;

    update public.vendor_price_agreements
    set superseded_by_id = v_agreement_id
    where org_id = p_org_id and id = any(v_displaced_ids);

    v_agreement_ids := array_append(v_agreement_ids, v_agreement_id);
  end loop;

  if cardinality(v_agreement_ids) = 0 then
    raise exception 'Award has no priced cost-coded scope items';
  end if;

  update public.bid_packages set status = 'awarded', updated_at = now()
    where org_id = p_org_id and id = v_package.id;

  return jsonb_build_object(
    'award_id', v_award.id,
    'bid_package_id', v_package.id,
    'agreement_ids', to_jsonb(v_agreement_ids),
    'displaced_ids', coalesce((
      select jsonb_agg(distinct e ->> 'id')
      from public.vendor_price_agreements m, jsonb_array_elements(m.metadata -> 'supersedes') e
      where m.id = any(v_agreement_ids)
    ), '[]'::jsonb)
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.rescind_bid_award(p_org_id uuid, p_bid_award_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS TABLE(bid_package_id uuid, commitment_id uuid, commitment_canceled boolean, voided_agreement_ids uuid[], restored_agreement_ids uuid[], skipped_agreement_ids uuid[], affected_po_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_award record;
  v_scope record;
  v_bill_count integer;
  v_commitment_canceled boolean := false;
  v_minted uuid[];
  v_voided uuid[];
  v_restored uuid[] := '{}';
  v_skipped uuid[] := '{}';
  v_entry record;
  v_po_count integer := 0;
begin
  -- The scope lock an award takes first too: a rescind and an award for the same
  -- community and plan run one after the other, never interleaved.
  select bp.community_id, bp.house_plan_id into v_scope
  from bid_awards ba
  join bid_packages bp on bp.id = ba.bid_package_id and bp.org_id = ba.org_id
  where ba.id = p_bid_award_id and ba.org_id = p_org_id;
  if not found then
    raise exception 'Bid award not found';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'price_book_scope:' || p_org_id::text || ':' || coalesce(v_scope.community_id::text, '') || ':' || coalesce(v_scope.house_plan_id::text, ''), 0));

  select ba.id, ba.org_id, ba.bid_package_id, ba.awarded_commitment_id, ba.rescinded_at
  into v_award
  from bid_awards ba
  where ba.id = p_bid_award_id and ba.org_id = p_org_id
  for update;

  if not found then
    raise exception 'Bid award not found';
  end if;
  if v_award.rescinded_at is not null then
    raise exception 'Bid award is already rescinded';
  end if;

  if v_award.awarded_commitment_id is not null then
    select count(*) into v_bill_count
    from vendor_bills vb
    where vb.org_id = p_org_id and vb.commitment_id = v_award.awarded_commitment_id;

    if v_bill_count > 0 then
      raise exception 'Cannot rescind: % bill(s) already reference the awarded subcontract', v_bill_count;
    end if;

    update commitments c
    set status = 'canceled', updated_at = now()
    where c.id = v_award.awarded_commitment_id
      and c.org_id = p_org_id
      and c.status in ('draft', 'approved');
    v_commitment_canceled := found;
  end if;

  select coalesce(array_agg(vpa.id), '{}') into v_minted
  from vendor_price_agreements vpa
  where vpa.org_id = p_org_id and vpa.source_bid_award_id = p_bid_award_id;

  -- v_minted is the whole chain: a price repriced after the award keeps the
  -- award's id, so the repriced successor is voided here with the row it replaced.
  with voided as (
    update vendor_price_agreements vpa
    set status = 'void',
        metadata = vpa.metadata || jsonb_build_object(
          'voided_by_rescind', jsonb_build_object(
            'bid_award_id', p_bid_award_id, 'actor_id', p_actor_id,
            'reason', p_reason, 'at', now()
          )
        )
    where vpa.org_id = p_org_id
      and vpa.source_bid_award_id = p_bid_award_id
      and vpa.status in ('draft', 'active')
    returning vpa.id
  )
  select coalesce(array_agg(id), '{}') into v_voided from voided;

  -- Put back exactly what the award displaced, unless somebody has touched it
  -- since: the price this award replaced is restored only while it still reads
  -- as the award left it, and only when the minted row it yielded to is void.
  for v_entry in
    select m.id as minted_id, (e ->> 'id')::uuid as old_id,
           (e ->> 'prior_effective_to')::date as prior_effective_to,
           (e ->> 'prior_status') as prior_status,
           (e ->> 'new_effective_to')::date as new_effective_to
    from vendor_price_agreements m, jsonb_array_elements(m.metadata -> 'supersedes') e
    where m.org_id = p_org_id and m.id = any(v_minted)
  loop
    if exists (
         -- The minted row itself, or a repriced successor of it, was voided by
         -- this rescind: the displaced price has no one left to yield to.
         with recursive chain(id) as (
           select v_entry.minted_id
           union all
           select n.id from vendor_price_agreements n join chain c on n.metadata ->> 'repriced_from_id' = c.id::text
           where n.org_id = p_org_id
         ) select 1 from chain where id = any(v_voided)
       )
       and exists (
         select 1 from vendor_price_agreements o
         where o.id = v_entry.old_id and o.org_id = p_org_id
           and o.superseded_by_id = v_entry.minted_id
           and o.effective_to is not distinct from v_entry.new_effective_to
           and o.status in ('superseded', 'active', 'expired')
       ) then
      update vendor_price_agreements o
      set effective_to = v_entry.prior_effective_to,
          superseded_by_id = null,
          status = case when v_entry.prior_effective_to is not null and v_entry.prior_effective_to < current_date
                        then 'expired' else 'active' end,
          metadata = o.metadata || jsonb_build_object(
            'restored_by_rescind', jsonb_build_object('bid_award_id', p_bid_award_id, 'actor_id', p_actor_id, 'at', now())
          )
      where o.id = v_entry.old_id and o.org_id = p_org_id;
      v_restored := array_append(v_restored, v_entry.old_id);
    else
      v_skipped := array_append(v_skipped, v_entry.old_id);
    end if;
  end loop;

  v_po_count := public.price_agreement_order_count(p_org_id, v_minted);

  update bid_awards ba
  set rescinded_at = now(), rescinded_by = p_actor_id, rescind_reason = p_reason
  where ba.id = p_bid_award_id and ba.org_id = p_org_id;

  -- Reopen the package for re-award (bids are still on file)
  update bid_packages bp
  set status = 'closed', updated_at = now()
  where bp.id = v_award.bid_package_id and bp.org_id = p_org_id;

  return query select v_award.bid_package_id, v_award.awarded_commitment_id, v_commitment_canceled,
    v_voided, v_restored, v_skipped, v_po_count;
end;
$function$;


