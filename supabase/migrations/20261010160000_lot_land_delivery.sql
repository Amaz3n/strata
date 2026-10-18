-- Land delivery is its own fact, separate from the sales status of a lot.
--
-- A hold on an owned lot advances it to 'assigned' the moment a buyer is
-- attached, and the start gate accepted 'developed' OR 'assigned' -- so a
-- vertical start could consume dirt that development never delivered.
-- `lots.delivered_at` is the land fact: stamped when a lot becomes developed,
-- never by a sale. A house starts on a delivered lot, or on a lot carrying a
-- recorded exception (`metadata.delivery_exception`, written by the lots
-- service under community.write with a reason and an audit row).
--
-- Also: a reservation conversion may not advance an undeveloped lot to
-- 'assigned'. The legacy service path already keeps the status; this keeps the
-- staged atomic conversion (20261005121409) and any other writer consistent.

alter table public.lots add column if not exists delivered_at timestamptz;

comment on column public.lots.delivered_at is
  'When land development delivered the lot (status reached developed). Distinct from sales status: a reserved lot is not a delivered lot. A vertical start requires it or metadata.delivery_exception.';

-- Lots already past development were delivered; the earliest honest date we
-- hold for them is the row's own creation.
update public.lots
   set delivered_at = created_at
 where delivered_at is null
   and status in ('developed', 'assigned', 'started', 'closed');

create or replace function public.tg_lots_land_delivery()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    -- A lot loaded already developed or sold is a delivered lot.
    if new.delivered_at is null and new.status in ('developed', 'assigned', 'started', 'closed') then
      new.delivered_at := now();
    end if;
    return new;
  end if;
  -- A sale never delivers land: an undeveloped lot keeps its land status.
  if new.status = 'assigned' and old.status in ('controlled', 'owned') then
    new.status := old.status;
  end if;
  if new.status = 'developed' and old.status is distinct from 'developed' and new.delivered_at is null then
    new.delivered_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists lots_land_delivery on public.lots;
create trigger lots_land_delivery
  before insert or update of status on public.lots
  for each row execute function public.tg_lots_land_delivery();

-- The database holds the line for every writer, including the SQL transactions
-- that open start packages: no package on an undelivered lot without a recorded
-- exception. Cancelled packages are history, not starts.
create or replace function public.tg_start_packages_lot_delivered()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_delivered_at timestamptz;
  v_exception jsonb;
begin
  if new.status = 'cancelled' then
    return new;
  end if;
  select delivered_at, metadata -> 'delivery_exception'
    into v_delivered_at, v_exception
    from public.lots
   where org_id = new.org_id and id = new.lot_id;
  if v_delivered_at is null
     and (v_exception is null or length(btrim(coalesce(v_exception ->> 'reason', ''))) < 10) then
    raise exception 'This lot has not been delivered by land development. Record a delivery exception with a reason to start on it.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists start_packages_lot_delivered on public.start_packages;
create trigger start_packages_lot_delivered
  before insert on public.start_packages
  for each row execute function public.tg_start_packages_lot_delivered();

revoke all on function public.tg_lots_land_delivery() from public, anon, authenticated;
revoke all on function public.tg_start_packages_lot_delivered() from public, anon, authenticated;
