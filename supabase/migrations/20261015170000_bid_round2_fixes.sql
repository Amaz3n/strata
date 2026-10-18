-- EP08 review round 2 (R2-A): bids and price book.
--
-- 1. A member cannot rewrite, insert or delete a vendor's quote through the data
--    API (totals, line prices, responses); leveling columns stay editable.
-- 2. Rescind takes the very scope lock award takes (and before any row lock an
--    award also takes), and the award's displacement UPDATE conditions on status,
--    so a concurrent rescind and award can never leave two active prices.
-- 3. A portal submission's attachments are linked inside the same transaction
--    as the submission, so a link failure can never leave a saved quote without
--    its files.

-- 2. One scope lock for award and rescind.

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
begin
  if v_effective_from < current_date or v_effective_from > current_date + 366 then
    raise exception 'The price takes effect from today up to a year ahead';
  end if;

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
  if v_package.award_target <> 'price_agreement' or v_package.project_id is not null
      or v_package.prospect_id is not null then
    raise exception 'Bid package is not a price-agreement package';
  end if;
  if v_package.status = 'cancelled' then raise exception 'Cannot award a cancelled bid package'; end if;

  -- Two packages awarded for the same community and plan each hold their own
  -- row lock; this one lock is what keeps the second from minting beside the
  -- first instead of replacing it.
  perform pg_advisory_xact_lock(hashtextextended(
    'price_book_scope:' || p_org_id::text || ':' || coalesce(v_package.community_id::text, '') || ':' || coalesce(v_package.house_plan_id::text, ''), 0));

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
  -- The scope lock an award takes, taken before any row lock an award also
  -- takes: a rescind and an award for the same community and plan run one
  -- after the other, never interleaved.
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
    if v_entry.minted_id = any(v_voided)
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


-- 3. Attachments inside the submission transaction.

create or replace function public.create_bid_submission_version(p_org_id uuid,p_bid_invite_id uuid,p_payload jsonb,p_items jsonb default '[]',p_source text default 'portal',p_entered_by uuid default null) returns jsonb language plpgsql set search_path=public as $$
declare i public.bid_invites; p public.bid_packages; v_result jsonb; v_file_ids uuid[]; v_submission_id uuid;
begin
 select * into i from public.bid_invites where id=p_bid_invite_id and org_id=p_org_id for update;
 select * into p from public.bid_packages where id=i.bid_package_id and org_id=p_org_id for update;
 if p.id is null then raise exception 'Bid package not found'; end if;
 if p.status in ('awarded','cancelled') or (p_source='portal' and p.status in ('draft','closed')) then raise exception 'Bidding is not open'; end if;
 if p_source='portal' and (p_payload->>'scope_revision' is null or (p_payload->>'scope_revision')::integer<>p.scope_revision) then raise exception 'The scope changed while this form was open. Reload and review before resubmitting.'; end if;
 if p_source='portal' and i.status in ('withdrawn','declined') then raise exception 'This invitation is inactive'; end if;
 v_result := public.create_bid_submission_version_unchecked(p_org_id,p_bid_invite_id,p_payload,p_items,p_source,p_entered_by);
 -- Attachments are part of the submission or the submission does not exist.
 select coalesce(array_agg(distinct e::uuid), '{}') into v_file_ids from jsonb_array_elements_text(coalesce(p_payload->'file_ids', '[]'::jsonb)) e;
 if cardinality(v_file_ids) > 0 then
  v_submission_id := (v_result->>'submission_id')::uuid;
  if (select count(*) from public.files f where f.org_id=p_org_id and f.id=any(v_file_ids) and f.metadata->>'bid_invite_id'=p_bid_invite_id::text) <> cardinality(v_file_ids) then
   raise exception 'An attachment does not belong to this bid';
  end if;
  insert into public.file_links (org_id,file_id,entity_type,entity_id)
   select p_org_id,f,'bid_submission',v_submission_id from unnest(v_file_ids) f;
 end if;
 return v_result;
end $$;


-- ---------------------------------------------------------------------------
-- 5. A vendor's quote is not a member's to rewrite.
--
-- Members (anon/authenticated) level a bid: the adjustment, the leveling notes,
-- the leveler's line summary, and each priced line's plug and note. Quotes are
-- created by the bid service (create_bid_submission_version) and the portal;
-- a member cannot insert or delete one, nor change a total, a line's price or
-- response, or what a submission says, awarded or not. An award mints its
-- agreements from those lines, and a rescinded package is re-awarded from them.
-- Referential cascades and the service/definer paths run as other roles and pass.
-- ---------------------------------------------------------------------------

create or replace function public.tg_bid_response_member_fence()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed text[] := case tg_table_name
    when 'bid_submissions' then array['leveled_adjustment_cents', 'leveling_notes', 'line_items', 'benchmark', 'updated_at']
    else array['gc_plug_cents', 'gc_note', 'updated_at']
  end;
begin
  if current_user not in ('anon', 'authenticated') then
    return coalesce(new, old);
  end if;
  if tg_op <> 'UPDATE' then
    raise exception 'A bid response is recorded through the bid service, not edited as data' using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_allowed) is distinct from (to_jsonb(old) - v_allowed) then
    raise exception 'A vendor''s bid cannot be changed; only its leveling can' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger bid_submissions_member_fence before insert or update or delete on public.bid_submissions
  for each row execute function public.tg_bid_response_member_fence();
create trigger bid_submission_items_member_fence before insert or update or delete on public.bid_submission_items
  for each row execute function public.tg_bid_response_member_fence();
