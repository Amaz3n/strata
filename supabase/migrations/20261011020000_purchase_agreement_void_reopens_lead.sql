-- Voiding a signed purchase agreement re-opens its lead.
--
-- voidPurchaseAgreement() voids the contract, releases the reservation, and
-- then moves the prospect from 'won' back to 'qualified' (clearing won_at) as
-- the member, so the funnel stays truthful. arc_private.guard_deal_mutation()
-- (20261001121630_precon_deal_mutation_guards) refuses every edit to a won
-- deal, so that last step always failed and a voided sale left a won lead.
--
-- This redefines the guard unchanged except for ONE exception, evaluated after
-- the can_write_deal() authorization and before the closed-deal refusal. It
-- admits only an UPDATE of public.prospects where:
--   * OLD.status = 'won' and NEW.status = 'qualified', and NEW.won_at is null;
--   * no column other than status, won_at and updated_at changes;
--   * at least one of the lead's lot_reservations points (contract_id) at a
--     purchase agreement that is already 'void'; and
--   * none of the lead's lot_reservations points at a 'draft' or 'active'
--     purchase agreement.
-- The contract is voided before the lead is re-opened, so the exception reads
-- the committed void. Every other edit to a won or delivered deal is still
-- refused. security definer, search_path and grants are as before.

create or replace function arc_private.guard_deal_mutation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  tenant uuid;
  prospect uuid;
  deal_status text;
  delivery boolean;
begin
  -- Server-only lifecycle transactions already authorize their actor. Do not
  -- block signature workers, conversion, contact promotion, or migrations.
  if current_setting('role',true) in ('service_role','none') then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  tenant := case when tg_op='DELETE' then old.org_id else new.org_id end;
  if tg_op='UPDATE' and (new.org_id is distinct from old.org_id or new.id is distinct from old.id) then
    raise exception 'Deal identity cannot be changed';
  end if;
  if tg_table_name='prospect_contacts' then
    prospect := case when tg_op='DELETE' then old.prospect_id else new.prospect_id end;
    if tg_op='UPDATE' and new.prospect_id is distinct from old.prospect_id then raise exception 'Contact cannot be moved to another deal'; end if;
    select status::text into deal_status from public.prospects where id=prospect and org_id=tenant;
    if not found then
      -- The parent guard and RLS already authorized an ON DELETE CASCADE.
      if tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if;
      raise exception 'Prospect not found';
    end if;
  else
    prospect := case when tg_op='DELETE' then old.id else new.id end;
    deal_status := case when tg_op='INSERT' then new.status::text else old.status::text end;
  end if;
  if not arc_private.can_write_deal(tenant,prospect) then raise exception 'Missing permission to edit this deal' using errcode='42501'; end if;
  -- The one edit a won deal takes: voiding its signed purchase agreement
  -- re-opens the lead. Nothing but the status (to qualified), won_at (cleared)
  -- and updated_at may change, and the agreement must already be void with no
  -- draft or active agreement left on any of the lead's reservations.
  if tg_table_name='prospects' and tg_op='UPDATE' then
    if old.status::text='won' and new.status::text='qualified' and new.won_at is null
      and (to_jsonb(new)-array['status','won_at','updated_at']) = (to_jsonb(old)-array['status','won_at','updated_at'])
      and exists(
        select 1 from public.lot_reservations lr join public.contracts c on c.org_id=lr.org_id and c.id=lr.contract_id
        where lr.org_id=tenant and lr.prospect_id=prospect and c.contract_type='purchase_agreement' and c.status='void')
      and not exists(
        select 1 from public.lot_reservations lr join public.contracts c on c.org_id=lr.org_id and c.id=lr.contract_id
        where lr.org_id=tenant and lr.prospect_id=prospect and c.contract_type='purchase_agreement' and c.status in ('draft','active'))
    then
      return new;
    end if;
  end if;
  select exists(select 1 from public.projects where org_id=tenant and prospect_id=prospect and phase='delivery') into delivery;
  if deal_status='won' or delivery then raise exception 'This deal is closed. Manage the active project instead.'; end if;
  if deal_status='lost' then
    if tg_table_name='prospects' and tg_op='UPDATE' then
      if new.status::text='contacted' and new.lost_reason is null
        and (to_jsonb(new)-array['status','lost_reason','lost_at','won_at','updated_at']) = (to_jsonb(old)-array['status','lost_reason','lost_at','won_at','updated_at']) then
        return new;
      end if;
    end if;
    raise exception 'Reopen this deal before editing it';
  end if;
  if tg_table_name='prospects' and tg_op<>'DELETE' then
    if new.owner_user_id is not null and (tg_op='INSERT' or new.owner_user_id is distinct from old.owner_user_id)
      and not exists(select 1 from public.memberships where org_id=tenant and user_id=new.owner_user_id and status='active') then
      raise exception 'Choose an active team member';
    end if;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke all on function arc_private.guard_deal_mutation() from public, anon, authenticated;
