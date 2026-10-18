-- Lot allocation guards: one lot, one home, one owner -- for every writer.
--
-- The lot lifecycle (lib/land/lot-lifecycle.ts) and the hold/attach checks in the
-- sales and lots services were application-only: a service-role writer could
-- start a lot with no home, and a hold and a home attach for two different
-- buyers could both pass their read-then-write checks at the same instant.
--
-- 1. A lot's status agrees with its home. Started and closed lots have one;
--    controlled and developed lots do not. An owned lot may carry a home: a
--    sale of undelivered land keeps the land status (20261010160000), so
--    presales on owned lots stay possible. Checked only when status or
--    project_id changes -- existing rows are not revalidated.
-- 2. Hold and attach serialize on the lot row. A hold insert locks the lot
--    first; an attach is an update of that same row. Whichever commits second
--    sees the first and is refused when the buyers differ.
-- 3. A hold whose expiry has passed is expired by the next hold on its lot,
--    inside that insert, so a lapsed hold never blocks a sale while every read
--    already calls the lot free.
-- 4. Releasing a reservation is one locked transition (release_lot_reservation).
--    The service claims it before any refund or forfeiture, so two releases
--    cannot both move the deposit. A released sale hands the home back to
--    inventory, and a reservation with an open purchase agreement is released
--    only by voiding the agreement.

-- ---------------------------------------------------------------------------
-- 1. Lot status agrees with its home.
-- ---------------------------------------------------------------------------

create or replace function public.tg_lots_status_home_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.status is not distinct from old.status
     and new.project_id is not distinct from old.project_id then
    return new;
  end if;
  if new.status = 'started' and new.project_id is null then
    raise exception 'A project must be attached before a lot can be marked started.'
      using errcode = 'check_violation';
  end if;
  if new.status = 'closed' and new.project_id is null then
    raise exception 'A lot cannot be closed without a home; attach the home that settled first.'
      using errcode = 'check_violation';
  end if;
  if new.status in ('controlled', 'developed') and new.project_id is not null then
    raise exception 'A lot with a home attached cannot be set to %; detach the home first.', new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_lots_status_home_guard() from public, anon, authenticated;

-- Named to sort after lots_land_delivery, so it judges the status that trigger settles on.
drop trigger if exists lots_status_home_guard on public.lots;
create trigger lots_status_home_guard
  before insert or update of status, project_id on public.lots
  for each row execute function public.tg_lots_status_home_guard();

-- ---------------------------------------------------------------------------
-- 2a. Attaching a home: a live hold or reservation belongs to its buyer.
-- ---------------------------------------------------------------------------

create or replace function public.tg_lots_home_reservation_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client uuid;
begin
  if new.project_id is null
     or (tg_op = 'UPDATE' and new.project_id is not distinct from old.project_id) then
    return new;
  end if;
  -- The update already holds this lot row, so a hold insert (which locks the
  -- lot first) either committed before this read or waits for this transaction.
  select client_id into v_client from public.projects where org_id = new.org_id and id = new.project_id;
  if exists (
    select 1
      from public.lot_reservations r
     where r.org_id = new.org_id
       and r.lot_id = new.id
       and r.status in ('hold', 'reserved', 'converted')
       and (r.status <> 'hold' or r.expires_at is null or r.expires_at > now())
       and (v_client is null or v_client not in (r.buyer_contact_id, coalesce(r.co_buyer_contact_id, r.buyer_contact_id)))
  ) then
    raise exception 'This lot has a live hold or reservation for another buyer. Release it before attaching a different home.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_lots_home_reservation_guard() from public, anon, authenticated;

drop trigger if exists lots_home_reservation_guard on public.lots;
create trigger lots_home_reservation_guard
  before insert or update of project_id on public.lots
  for each row execute function public.tg_lots_home_reservation_guard();

-- ---------------------------------------------------------------------------
-- 2b + 3. A new hold locks its lot, expires the lot's lapsed hold, and is
-- refused when the lot's home already belongs to another buyer.
-- ---------------------------------------------------------------------------

create or replace function public.tg_lot_reservations_allocate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_client uuid;
begin
  if new.status not in ('hold', 'reserved', 'converted') then
    return new;
  end if;
  select project_id into v_project from public.lots where org_id = new.org_id and id = new.lot_id for update;
  if not found then
    raise exception 'Lot not found' using errcode = 'foreign_key_violation';
  end if;

  with expired as (
    update public.lot_reservations
       set status = 'expired', released_at = now(), release_reason = 'Hold expired'
     where org_id = new.org_id
       and lot_id = new.lot_id
       and status = 'hold'
       and expires_at is not null
       and expires_at <= now()
    returning id, org_id, lot_id, community_id
  )
  insert into public.events (org_id, event_type, entity_type, entity_id, payload)
  select org_id, 'lot_hold_expired', 'lot_reservation', id, jsonb_build_object('lot_id', lot_id, 'community_id', community_id)
    from expired;

  if v_project is not null then
    select client_id into v_client from public.projects where org_id = new.org_id and id = v_project;
    if v_client is not null and v_client not in (new.buyer_contact_id, coalesce(new.co_buyer_contact_id, new.buyer_contact_id)) then
      raise exception 'This lot''s home belongs to another buyer. Release that sale before holding the lot.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_lot_reservations_allocate() from public, anon, authenticated;

drop trigger if exists lot_reservations_allocate on public.lot_reservations;
create trigger lot_reservations_allocate
  before insert on public.lot_reservations
  for each row execute function public.tg_lot_reservations_allocate();

-- ---------------------------------------------------------------------------
-- 4. Release: one locked transition, claimed before any money moves.
-- ---------------------------------------------------------------------------

create or replace function public.release_lot_reservation(
  p_org_id uuid,
  p_actor_id uuid,
  p_reservation_id uuid,
  p_reason text,
  p_deposit_disposition text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lot uuid;
  v_project uuid;
  r public.lot_reservations;
  released public.lot_reservations;
begin
  if p_org_id is null or p_actor_id is null or p_reservation_id is null or length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reservation and a release reason are required';
  end if;
  if p_deposit_disposition is not null and p_deposit_disposition not in ('refund', 'forfeit') then
    raise exception 'Unknown deposit disposition';
  end if;
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor_id then
    raise exception 'Reservation release actor mismatch' using errcode = '42501';
  end if;

  -- Lot before reservation: the order a hold insert and a conversion lock in.
  select lot_id into v_lot from public.lot_reservations where org_id = p_org_id and id = p_reservation_id;
  if not found then
    raise exception 'Live reservation not found';
  end if;
  select project_id into v_project from public.lots where org_id = p_org_id and id = v_lot for update;
  select * into r from public.lot_reservations where org_id = p_org_id and id = p_reservation_id for update;
  if r.lot_id <> v_lot or r.status not in ('hold', 'reserved', 'converted') then
    raise exception 'Live reservation not found';
  end if;
  if r.contract_id is not null and exists (
    select 1 from public.contracts
     where org_id = p_org_id and id = r.contract_id and contract_type = 'purchase_agreement' and status in ('draft', 'active')
  ) then
    raise exception 'This reservation has an open purchase agreement. Void the agreement to release it.';
  end if;

  update public.lot_reservations
     set status = 'released',
         released_at = now(),
         release_reason = p_reason,
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('deposit_disposition', p_deposit_disposition)
   where org_id = p_org_id and id = r.id
  returning * into released;

  -- The home a sale assigned goes back to inventory with the buyer who walked away.
  if r.status in ('reserved', 'converted') and v_project is not null and not exists (
    select 1 from public.contracts
     where org_id = p_org_id and project_id = v_project and contract_type = 'purchase_agreement' and status in ('draft', 'active')
  ) then
    update public.projects set client_id = null
     where org_id = p_org_id and id = v_project and client_id = r.buyer_contact_id;
  end if;

  return jsonb_build_object('before', to_jsonb(r), 'after', to_jsonb(released));
end;
$$;

revoke all on function public.release_lot_reservation(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.release_lot_reservation(uuid, uuid, uuid, text, text) to service_role;
