-- Rescinding a price-book award left the vendor price agreements it minted
-- active, so purchasing kept pricing homes from a bid the builder had taken
-- back. Rescind now voids every live agreement that carries the award as its
-- source, in the same transaction that stamps the award rescinded. A successor
-- a buyer repriced by hand is a manual agreement (reprice clears the award
-- source) and stands on its own.
--
-- The agreements the award superseded are NOT reactivated: the award overwrote
-- their effective_to, so their original end date is gone and resurrecting them
-- could extend a price nobody agreed to. Their cost codes surface as PO
-- generation exceptions until purchasing re-awards or reprices — a visible gap
-- rather than a silent wrong price.
--
-- Otherwise identical to the applied definition in
-- 20260716090000_bid_scope_line_model.sql. Re-award after rescind additionally
-- needs 20261004120000_bid_awards_active_package_unique.sql (still unapplied).

create or replace function public.rescind_bid_award(
  p_org_id uuid,
  p_bid_award_id uuid,
  p_actor_id uuid,
  p_reason text default null
) returns table (
  bid_package_id uuid,
  commitment_id uuid,
  commitment_canceled boolean
)
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_award record;
  v_bill_count integer;
  v_commitment_canceled boolean := false;
begin
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
    and vpa.status in ('draft', 'active');

  update bid_awards ba
  set rescinded_at = now(), rescinded_by = p_actor_id, rescind_reason = p_reason
  where ba.id = p_bid_award_id and ba.org_id = p_org_id;

  -- Reopen the package for re-award (bids are still on file)
  update bid_packages bp
  set status = 'closed', updated_at = now()
  where bp.id = v_award.bid_package_id and bp.org_id = p_org_id;

  return query select v_award.bid_package_id, v_award.awarded_commitment_id, v_commitment_canceled;
end;
$$;

revoke all on function public.rescind_bid_award(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rescind_bid_award(uuid, uuid, uuid, text) to service_role;
