-- EP04 review fixes: the land and inventory controls held for every writer.
--
-- lots, lot_reservations and lot_takedowns still carry their original
-- is_org_member FOR ALL policies, so any member could write them straight
-- through PostgREST and walk around rules the services and the newer guards
-- only enforced on some operations. Every fix below refuses the direct write by
-- a signed-in member (`current_user = 'authenticated'`, as tg_lots_land_delivery
-- does) or moves the legitimate write into a service-role function the service
-- calls after its own checks.
--
-- 1. Spec price moves. record_spec_price_move and decide_spec_price_proposal are
--    service-role only and take the actor: the service computes the band (the
--    org's configurable bands live in lib/sales/spec-price-approval-thresholds.ts)
--    before calling. A member can no longer insert a move at all, and only
--    withdraws their own by direct update; decisions go through the function.
-- 2. lots.asking_price_override_cents is written only by those functions.
-- 3. spec_dispositions.carrying_cents is the database's: what Books carries for
--    the home on the day the disposition is proposed (books_home_carrying_cents).
-- 4. lot_reservations: the buyer and the lot never change; status moves only
--    along hold -> reserved -> converted (each releasable, a hold expirable); a
--    reservation going live again is held to the allocation rule; members do not
--    move a reservation's status, sale or deposit invoice, and do not delete one.
-- 5. lot_takedowns: one under a signed contract is never deleted. A member
--    never closes or reopens a takedown directly, and never cancels one under a
--    signed contract or from a land deal; closing a deal's takedown needs an
--    approved acquisition review whoever writes it. close_lot_takedown closes,
--    applies the paid deposits and advances the lots in one transaction.
-- 6. Terminating a land contract cancels its scheduled deposits ('cancelled',
--    a new status: no money moved, so no receipt) and its scheduled takedowns,
--    in one transaction (close_out_land_contract).
-- 7. A started or closed lot moving back is a reversal: a member needs
--    community.write, the authority the service's force path demands.
-- 9. An extension or penalty fee records its payment (fee_paid_on with the
--    receipt), so an unpaid one past due stays in the cash plan.

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. Spec price moves: written by the service, after its band check.
-- ---------------------------------------------------------------------------

drop function if exists public.record_spec_price_move(uuid, uuid, uuid, uuid, text, bigint, bigint, bigint, date, text, text, boolean, timestamptz);
drop function if exists public.decide_spec_price_proposal(uuid, uuid, boolean, text, timestamptz);

create or replace function public.record_spec_price_move(
  p_org_id uuid,
  p_lot_id uuid,
  p_project_id uuid,
  p_community_id uuid,
  p_kind text,
  p_asking_price_cents bigint,
  p_from_cents bigint,
  p_to_cents bigint,
  p_expires_on date,
  p_reason text,
  p_required_permission text,
  p_apply boolean,
  p_lot_updated_at timestamptz,
  p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  move_id uuid;
begin
  if p_actor_id is null or not exists (select 1 from public.app_users where id = p_actor_id) then
    raise exception 'A price move is made by a person' using errcode = '22023';
  end if;
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor_id then
    raise exception 'Price move actor mismatch' using errcode = '42501';
  end if;
  insert into public.spec_price_proposals (
    org_id, lot_id, project_id, community_id, kind, asking_price_cents, from_cents, to_cents,
    incentive_expires_on, reason, required_permission, status, proposed_by
  ) values (
    p_org_id, p_lot_id, p_project_id, p_community_id, p_kind, p_asking_price_cents, p_from_cents, p_to_cents,
    p_expires_on, p_reason, p_required_permission, case when p_apply then 'applied' else 'proposed' end, p_actor_id
  )
  returning id into move_id;

  if p_apply and p_kind = 'price' then
    update public.lots
    set asking_price_override_cents = p_to_cents
    where id = p_lot_id and org_id = p_org_id and updated_at = p_lot_updated_at;
    if not found then
      raise exception 'The home changed while you were repricing it. Review it and try again.' using errcode = '40001';
    end if;
  end if;
  return move_id;
end;
$$;

revoke all on function public.record_spec_price_move(uuid, uuid, uuid, uuid, text, bigint, bigint, bigint, date, text, text, boolean, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.record_spec_price_move(uuid, uuid, uuid, uuid, text, bigint, bigint, bigint, date, text, text, boolean, timestamptz, uuid) to service_role;

create or replace function public.decide_spec_price_proposal(
  p_org_id uuid,
  p_proposal_id uuid,
  p_approve boolean,
  p_note text,
  p_lot_updated_at timestamptz,
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  proposal record;
begin
  if p_actor_id is null or not exists (select 1 from public.app_users where id = p_actor_id) then
    raise exception 'A price change is decided by a person' using errcode = '22023';
  end if;
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor_id then
    raise exception 'Price decision actor mismatch' using errcode = '42501';
  end if;
  update public.spec_price_proposals
  set status = case when p_approve then 'approved' else 'rejected' end,
      decided_by = p_actor_id,
      decided_at = now(),
      decision_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_proposal_id and org_id = p_org_id and status = 'proposed'
  returning kind, lot_id, to_cents into proposal;
  if not found then
    raise exception 'This price change was already decided or withdrawn.' using errcode = '40001';
  end if;

  if p_approve and proposal.kind = 'price' then
    update public.lots
    set asking_price_override_cents = proposal.to_cents
    where id = proposal.lot_id and org_id = p_org_id and updated_at = p_lot_updated_at;
    if not found then
      raise exception 'The home changed while you were deciding. Review it and try again.' using errcode = '40001';
    end if;
  end if;
end;
$$;

revoke all on function public.decide_spec_price_proposal(uuid, uuid, boolean, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.decide_spec_price_proposal(uuid, uuid, boolean, text, timestamptz, uuid) to service_role;

-- A member's only direct write to a move is withdrawing their own.
create or replace function public.guard_spec_price_proposal_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is distinct from old.org_id
     or new.lot_id is distinct from old.lot_id
     or new.project_id is distinct from old.project_id
     or new.community_id is distinct from old.community_id
     or new.kind is distinct from old.kind
     or new.asking_price_cents is distinct from old.asking_price_cents
     or new.from_cents is distinct from old.from_cents
     or new.to_cents is distinct from old.to_cents
     or new.incentive_expires_on is distinct from old.incentive_expires_on
     or new.reason is distinct from old.reason
     or new.required_permission is distinct from old.required_permission
     or new.proposed_by is distinct from old.proposed_by
     or new.proposed_at is distinct from old.proposed_at then
    raise exception 'A proposed price change cannot be edited; withdraw it and propose again' using errcode = '42501';
  end if;
  if old.status <> 'proposed' then
    raise exception 'This price change is final' using errcode = '42501';
  end if;
  if (select auth.role()) is distinct from 'service_role' then
    if new.status in ('approved', 'rejected') then
      raise exception 'A price change is decided through its approval, by someone holding %', new.required_permission using errcode = '42501';
    end if;
    if new.status = 'withdrawn' and new.proposed_by is distinct from (select auth.uid()) then
      raise exception 'Only the person who proposed a price change can withdraw it' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_spec_price_proposal_decision() from public, anon, authenticated;

drop policy if exists spec_price_proposals_insert on public.spec_price_proposals;

drop policy if exists spec_price_proposals_update on public.spec_price_proposals;
create policy spec_price_proposals_update on public.spec_price_proposals
  for update
  to authenticated
  using (public.has_org_permission(org_id, 'sales.manage') and proposed_by = (select auth.uid()))
  with check (
    public.has_org_permission(org_id, 'sales.manage')
    and proposed_by = (select auth.uid())
    and status = 'withdrawn'
    and decided_by is null
  );

revoke insert on table public.spec_price_proposals from authenticated;

comment on function public.record_spec_price_move(uuid, uuid, uuid, uuid, text, bigint, bigint, bigint, date, text, text, boolean, timestamptz, uuid) is
  'Service role only: the move row and, for an applied price move, the lot''s asking price in one transaction. The caller (proposeSpecPriceChange) has already computed the band, so p_apply and p_required_permission are never a client''s choice.';

-- ---------------------------------------------------------------------------
-- 2 + 7. Lots: the asking price and reversals.
-- ---------------------------------------------------------------------------

create or replace function public.tg_lots_member_write_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.asking_price_override_cents is not null then
      raise exception 'A spec home''s asking price is set by a price move' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.asking_price_override_cents is distinct from old.asking_price_override_cents then
    raise exception 'A spec home''s asking price is set by a price move' using errcode = '42501';
  end if;
  -- Out of started or closed, except forward to closed, is a reversal.
  if old.status in ('started', 'closed')
     and new.status is distinct from old.status
     and not (old.status = 'started' and new.status = 'closed')
     and not public.has_org_permission(new.org_id, 'community.write') then
    raise exception 'Moving a lot out of % is a reversal; it takes community.write and an explicit force confirmation', old.status
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_lots_member_write_guard() from public, anon, authenticated;

drop trigger if exists lots_member_write_guard on public.lots;
create trigger lots_member_write_guard
  before insert or update of asking_price_override_cents, status on public.lots
  for each row execute function public.tg_lots_member_write_guard();

-- ---------------------------------------------------------------------------
-- 3. A disposition's carrying cost is what Books carries, never a client figure.
-- ---------------------------------------------------------------------------

create or replace function public.tg_spec_dispositions_carrying()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.carrying_cents := greatest(0, public.books_home_carrying_cents(new.org_id, new.project_id, current_date));
  return new;
end;
$$;

revoke all on function public.tg_spec_dispositions_carrying() from public, anon, authenticated;

drop trigger if exists spec_dispositions_carrying on public.spec_dispositions;
create trigger spec_dispositions_carrying
  before insert on public.spec_dispositions
  for each row execute function public.tg_spec_dispositions_carrying();

comment on column public.spec_dispositions.carrying_cents is
  'What Books carried for the home (1160 + 1170) on the day the disposition was proposed, set by the database on insert. Below it, execution waits for an approved write-down.';

-- ---------------------------------------------------------------------------
-- 4. Reservations: one buyer, one lot, one lifecycle.
-- ---------------------------------------------------------------------------

create or replace function public.tg_lot_reservations_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_project uuid;
  v_client uuid;
begin
  if tg_op = 'DELETE' then
    if current_user = 'authenticated' then
      raise exception 'A reservation is kept; release it instead' using errcode = '42501';
    end if;
    return old;
  end if;
  if (new.org_id, new.lot_id, new.community_id, new.buyer_contact_id)
     is distinct from (old.org_id, old.lot_id, old.community_id, old.buyer_contact_id) then
    raise exception 'A reservation stays with its buyer and lot; release it and hold the lot again' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'hold' and new.status in ('reserved', 'released', 'expired'))
    or (old.status = 'reserved' and new.status in ('converted', 'released'))
    or (old.status = 'converted' and new.status = 'released')
  ) then
    raise exception 'A reservation cannot move from % to %', old.status, new.status using errcode = '42501';
  end if;
  if current_user = 'authenticated'
     and ((new.status, new.co_buyer_contact_id, new.contract_id, new.deposit_invoice_id, new.deposit_required_cents)
          is distinct from
          (old.status, old.co_buyer_contact_id, old.contract_id, old.deposit_invoice_id, old.deposit_required_cents)) then
    raise exception 'A reservation moves through the sales flow (hold, reserve, agreement, release), not a direct edit' using errcode = '42501';
  end if;
  -- A reservation that becomes a sale belongs to the lot's home's buyer.
  if new.status is distinct from old.status and new.status in ('reserved', 'converted') then
    select project_id into v_project from public.lots where org_id = new.org_id and id = new.lot_id;
    if v_project is not null then
      select client_id into v_client from public.projects where org_id = new.org_id and id = v_project;
      if v_client is not null and v_client not in (new.buyer_contact_id, coalesce(new.co_buyer_contact_id, new.buyer_contact_id)) then
        raise exception 'This lot''s home belongs to another buyer. Release that sale before reserving the lot.'
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_lot_reservations_transition() from public, anon, authenticated;

drop trigger if exists lot_reservations_transition on public.lot_reservations;
create trigger lot_reservations_transition
  before update or delete on public.lot_reservations
  for each row execute function public.tg_lot_reservations_transition();

revoke delete on table public.lot_reservations from authenticated;

-- ---------------------------------------------------------------------------
-- 5. Takedowns under a signed contract or from a land deal.
-- ---------------------------------------------------------------------------

create or replace function public.tg_lot_takedowns_closure_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_contract_status text;
begin
  if tg_op = 'DELETE' then
    if old.land_contract_id is not null and exists (
      select 1 from public.land_contracts c where c.id = old.land_contract_id and c.status <> 'draft'
    ) then
      raise exception 'A takedown under a signed land contract is kept; terminate the contract instead' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.status is not distinct from old.status then
    return new;
  end if;
  if new.status = 'closed' and new.land_opportunity_id is not null and not exists (
    select 1 from public.land_acquisition_reviews r
     where r.org_id = new.org_id and r.land_opportunity_id = new.land_opportunity_id
       and r.status = 'approved' and r.decision = 'acquire'
  ) then
    raise exception 'This takedown''s land deal has no approved acquisition review. Approve the acquisition before closing it.'
      using errcode = '42501';
  end if;
  if current_user = 'authenticated' then
    if 'closed' in (old.status, new.status) then
      raise exception 'A takedown is closed through its closing, which applies its deposits and acquires its lots' using errcode = '42501';
    end if;
    if old.land_contract_id is not null then
      select c.status into v_contract_status from public.land_contracts c where c.id = old.land_contract_id;
    end if;
    if coalesce(v_contract_status, 'draft') <> 'draft' or old.land_opportunity_id is not null then
      raise exception 'A takedown under a signed contract or from a land deal changes status only through the land workflow' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_lot_takedowns_closure_guard() from public, anon, authenticated;

drop trigger if exists lot_takedowns_closure_guard on public.lot_takedowns;
create trigger lot_takedowns_closure_guard
  before update or delete on public.lot_takedowns
  for each row execute function public.tg_lot_takedowns_closure_guard();

-- Close, credit the deposits and acquire the lots: one transaction. The service
-- (closeLotTakedown) checks permission, scope and Books posture first.
create or replace function public.close_lot_takedown(
  p_org_id uuid,
  p_takedown_id uuid,
  p_actual_date date,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_takedown public.lot_takedowns%rowtype;
  v_applied_cents bigint;
  v_lot_ids uuid[];
begin
  if p_actor_id is null or not exists (select 1 from public.app_users where id = p_actor_id) then
    raise exception 'A takedown is closed by a person' using errcode = '22023';
  end if;
  if p_actual_date is null then
    raise exception 'A takedown closes on its actual date' using errcode = '22023';
  end if;
  select * into v_takedown from public.lot_takedowns where org_id = p_org_id and id = p_takedown_id for update;
  if not found then
    raise exception 'Lot takedown not found' using errcode = 'P0002';
  end if;
  if v_takedown.status <> 'scheduled' then
    raise exception 'Only a scheduled takedown is closed' using errcode = '22023';
  end if;
  if v_takedown.land_contract_id is not null and not exists (
    select 1 from public.land_contracts c where c.id = v_takedown.land_contract_id and c.status = 'executed'
  ) then
    raise exception 'Execute this takedown''s land contract before closing it.' using errcode = '22023';
  end if;
  perform 1 from public.land_contract_deposits d
   where d.org_id = p_org_id and d.takedown_id = p_takedown_id and d.status in ('scheduled', 'paid')
   order by d.id for update;
  if exists (select 1 from public.land_contract_deposits d where d.org_id = p_org_id and d.takedown_id = p_takedown_id and d.status = 'scheduled') then
    raise exception 'Record the payment of every deposit credited against this takedown before closing it.' using errcode = '22023';
  end if;

  update public.lot_takedowns set status = 'closed', actual_date = p_actual_date where id = p_takedown_id;

  with applied as (
    update public.land_contract_deposits set status = 'applied'
     where org_id = p_org_id and takedown_id = p_takedown_id and status = 'paid'
    returning amount_cents
  )
  select coalesce(sum(amount_cents), 0)::bigint into v_applied_cents from applied;

  with advanced as (
    update public.lots set status = 'owned', acquired_date = p_actual_date
     where org_id = p_org_id and takedown_id = p_takedown_id and status = 'controlled'
    returning id
  )
  select coalesce(array_agg(id order by id), '{}') into v_lot_ids from advanced;

  return jsonb_build_object('lot_ids', to_jsonb(v_lot_ids), 'applied_deposit_cents', v_applied_cents);
end;
$$;

revoke all on function public.close_lot_takedown(uuid, uuid, date, uuid) from public, anon, authenticated;
grant execute on function public.close_lot_takedown(uuid, uuid, date, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Terminating a contract ends what it still called for.
-- ---------------------------------------------------------------------------

alter table public.land_contract_deposits drop constraint if exists land_contract_deposits_status_check;
alter table public.land_contract_deposits add constraint land_contract_deposits_status_check
  check (status in ('scheduled', 'paid', 'applied', 'refunded', 'forfeited', 'cancelled'));
-- A cancelled deposit was never paid: nothing moved, so there is no receipt.
alter table public.land_contract_deposits drop constraint if exists land_contract_deposits_evidence_check;
alter table public.land_contract_deposits add constraint land_contract_deposits_evidence_check
  check (status in ('scheduled', 'cancelled') or (paid_on is not null and evidence_file_id is not null));
alter table public.land_contract_deposits drop constraint if exists land_contract_deposits_cancelled_check;
alter table public.land_contract_deposits add constraint land_contract_deposits_cancelled_check
  check (status <> 'cancelled' or (paid_on is null and evidence_file_id is null));

create or replace function public.guard_land_contract_deposit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_contract_status text;
begin
  if tg_op = 'DELETE' then
    if old.status <> 'scheduled' then
      raise exception 'A deposit that moved money is kept' using errcode = '42501';
    end if;
    -- A cascade from deleting a draft contract finds no contract left.
    select status into v_contract_status from public.land_contracts where id = old.land_contract_id;
    if v_contract_status is not null and v_contract_status <> 'draft' then
      raise exception 'The deposit schedule of an executed land contract cannot change' using errcode = '42501';
    end if;
    return old;
  end if;

  select status into v_contract_status
    from public.land_contracts
   where id = new.land_contract_id and org_id = new.org_id;
  if v_contract_status is null then
    raise exception 'The land contract is not in this organization' using errcode = '23503';
  end if;
  if new.takedown_id is not null and not exists (
    select 1 from public.lot_takedowns t
     where t.id = new.takedown_id and t.org_id = new.org_id and t.land_contract_id = new.land_contract_id
  ) then
    raise exception 'A deposit is credited only against a takedown of the same contract' using errcode = '23503';
  end if;
  if new.evidence_file_id is not null
     and not exists (select 1 from public.files f where f.id = new.evidence_file_id and f.org_id = new.org_id) then
    raise exception 'The deposit evidence file is not in this organization' using errcode = '23503';
  end if;

  if tg_op = 'INSERT' then
    if v_contract_status <> 'draft' then
      raise exception 'The deposit schedule of an executed land contract cannot change' using errcode = '42501';
    end if;
    if new.status <> 'scheduled' then
      raise exception 'A deposit is scheduled before it is paid' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.org_id is distinct from old.org_id or new.land_contract_id is distinct from old.land_contract_id then
    raise exception 'A deposit stays with its contract' using errcode = '42501';
  end if;
  -- The schedule itself is a contract term.
  if (new.takedown_id, new.label, new.due_on, new.amount_cents, new.refundability, new.refundable_until)
     is distinct from
     (old.takedown_id, old.label, old.due_on, old.amount_cents, old.refundability, old.refundable_until)
     and (v_contract_status <> 'draft' or old.status <> 'scheduled') then
    raise exception 'The deposit schedule of an executed land contract cannot change' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'scheduled' and new.status in ('paid', 'cancelled'))
    or (old.status = 'paid' and new.status in ('applied', 'refunded', 'forfeited'))
  ) then
    raise exception 'A deposit moves scheduled, then paid, then applied, refunded or forfeited' using errcode = '42501';
  end if;
  if new.status = 'paid' and v_contract_status not in ('executed', 'completed', 'terminated') then
    raise exception 'Execute the land contract before recording a deposit payment' using errcode = '42501';
  end if;
  -- An unpaid deposit falls away only with the contract that called for it.
  if new.status = 'cancelled' and old.status <> 'cancelled' and v_contract_status <> 'terminated' then
    raise exception 'A scheduled deposit is cancelled only by terminating its land contract' using errcode = '42501';
  end if;
  if old.status <> 'scheduled'
     and (new.paid_on, new.payment_reference) is distinct from (old.paid_on, old.payment_reference) then
    raise exception 'A recorded deposit payment cannot be rewritten' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_land_contract_deposit() from public, anon, authenticated;

create or replace function public.close_out_land_contract(
  p_org_id uuid,
  p_contract_id uuid,
  p_status text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_deposit_ids uuid[] := '{}';
  v_takedown_ids uuid[] := '{}';
begin
  if p_actor_id is null or not exists (select 1 from public.app_users where id = p_actor_id) then
    raise exception 'A land contract is closed out by a person' using errcode = '22023';
  end if;
  if p_status not in ('terminated', 'completed') then
    raise exception 'A land contract is terminated or completed' using errcode = '22023';
  end if;
  select status into v_status from public.land_contracts where org_id = p_org_id and id = p_contract_id for update;
  if not found then
    raise exception 'Land contract not found' using errcode = 'P0002';
  end if;
  if v_status <> 'executed' then
    raise exception 'Only an executed land contract is terminated or completed.' using errcode = '22023';
  end if;

  update public.land_contracts set status = p_status where id = p_contract_id;

  if p_status = 'terminated' then
    with cancelled as (
      update public.land_contract_deposits set status = 'cancelled'
       where org_id = p_org_id and land_contract_id = p_contract_id and status = 'scheduled'
      returning id
    )
    select coalesce(array_agg(id order by id), '{}') into v_deposit_ids from cancelled;
    with cancelled as (
      update public.lot_takedowns set status = 'cancelled'
       where org_id = p_org_id and land_contract_id = p_contract_id and status = 'scheduled'
      returning id
    )
    select coalesce(array_agg(id order by id), '{}') into v_takedown_ids from cancelled;
  end if;

  return jsonb_build_object('cancelled_deposit_ids', to_jsonb(v_deposit_ids), 'cancelled_takedown_ids', to_jsonb(v_takedown_ids));
end;
$$;

revoke all on function public.close_out_land_contract(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.close_out_land_contract(uuid, uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 9. A fee's payment, recorded once with its receipt.
-- ---------------------------------------------------------------------------

alter table public.land_contract_amendments
  add column if not exists fee_paid_on date,
  add column if not exists fee_evidence_file_id uuid references public.files(id) on delete restrict;

alter table public.land_contract_amendments drop constraint if exists land_contract_amendments_fee_paid_check;
alter table public.land_contract_amendments add constraint land_contract_amendments_fee_paid_check
  check ((fee_paid_on is null) = (fee_evidence_file_id is null) and (fee_paid_on is null or fee_cents > 0));

create index if not exists land_contract_amendments_fee_evidence_idx
  on public.land_contract_amendments (fee_evidence_file_id) where fee_evidence_file_id is not null;
drop index if exists public.land_contract_amendments_fee_due_idx;
create index if not exists land_contract_amendments_fee_due_idx
  on public.land_contract_amendments (org_id, due_on) where fee_cents > 0 and fee_paid_on is null;

comment on column public.land_contract_amendments.fee_paid_on is
  'The day the extension or penalty fee was paid, with fee_evidence_file_id as the receipt. Recorded once; until then the fee is owed, and past due it is owed now.';

-- Definer: the receipt and evidence checks read files the caller's own row
-- security may hide (the guard decides on facts, not on who can see them).
create or replace function public.guard_land_contract_amendment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    -- The one change an amendment takes: its fee's payment, recorded once.
    if (to_jsonb(new) - 'fee_paid_on' - 'fee_evidence_file_id') = (to_jsonb(old) - 'fee_paid_on' - 'fee_evidence_file_id')
       and old.fee_paid_on is null and new.fee_paid_on is not null then
      if new.fee_evidence_file_id is not null
         and not exists (select 1 from public.files f where f.id = new.fee_evidence_file_id and f.org_id = new.org_id) then
        raise exception 'The fee receipt is not in this organization' using errcode = '23503';
      end if;
      return new;
    end if;
    raise exception 'Land contract amendments are kept as recorded; record another amendment instead' using errcode = '42501';
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'Land contract amendments are kept as recorded; record another amendment instead' using errcode = '42501';
  end if;
  if new.fee_paid_on is not null then
    raise exception 'A fee is recorded before its payment' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.land_contracts c
     where c.id = new.land_contract_id and c.org_id = new.org_id and c.status = 'executed'
  ) then
    raise exception 'Only an executed land contract is amended' using errcode = '42501';
  end if;
  if new.takedown_id is not null and not exists (
    select 1 from public.lot_takedowns t
     where t.id = new.takedown_id and t.org_id = new.org_id and t.land_contract_id = new.land_contract_id
  ) then
    raise exception 'The takedown is not under this contract' using errcode = '23503';
  end if;
  if not exists (select 1 from public.files f where f.id = new.evidence_file_id and f.org_id = new.org_id) then
    raise exception 'The amendment evidence file is not in this organization' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_land_contract_amendment() from public, anon, authenticated;

drop policy if exists land_contract_amendments_update on public.land_contract_amendments;
create policy land_contract_amendments_update on public.land_contract_amendments
  for update
  to authenticated
  using (public.has_org_permission(org_id, 'land_contract.write'))
  with check (public.has_org_permission(org_id, 'land_contract.write'));

grant update (fee_paid_on, fee_evidence_file_id) on table public.land_contract_amendments to authenticated;
