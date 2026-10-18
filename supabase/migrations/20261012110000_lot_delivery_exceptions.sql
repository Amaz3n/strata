-- Starting a house on undelivered land is an authorized, recorded act.
--
-- The exception that lets a vertical start consume a lot land development has
-- not delivered lived in lots.metadata.delivery_exception, and lots grant every
-- org member UPDATE. Any member could write that key (or set delivered_at, or
-- mark the lot developed) straight through PostgREST, and the start-package
-- trigger then accepted the lot. And moving a lot to 'started' was not gated on
-- delivery at all; only opening a start package was.
--
--   lot_delivery_exceptions  the exception as its own record, mirroring
--                            lot_fit_overrides: a reason, optional evidence,
--                            who approved it, revocable once. Written only by a
--                            holder of lot.delivery_override.
--   tg_start_packages_lot_delivered
--                            reads the active exception from the table.
--   tg_lots_land_delivery    refuses status -> 'started' on an undelivered lot
--                            without an active exception (every writer), and
--                            refuses a signed-in member who sets delivered_at
--                            directly or marks a lot developed without lot.write.
--
-- Existing metadata exceptions are carried into the table and the key removed.

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. The exception record.
-- ---------------------------------------------------------------------------

create table if not exists public.lot_delivery_exceptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  lot_id uuid not null references public.lots(id) on delete cascade,
  reason text not null,
  evidence_file_id uuid references public.files(id),
  approved_by uuid not null references public.app_users(id),
  approved_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lot_delivery_exceptions_reason_check check (length(btrim(reason)) >= 10),
  constraint lot_delivery_exceptions_revocation_check check ((revoked_at is null) = (revoked_by is null))
);

-- One live exception per lot.
create unique index if not exists lot_delivery_exceptions_active_key
  on public.lot_delivery_exceptions (lot_id) where revoked_at is null;
create index if not exists lot_delivery_exceptions_org_lot_idx
  on public.lot_delivery_exceptions (org_id, lot_id);
create index if not exists lot_delivery_exceptions_evidence_idx
  on public.lot_delivery_exceptions (evidence_file_id) where evidence_file_id is not null;
create index if not exists lot_delivery_exceptions_approved_by_idx
  on public.lot_delivery_exceptions (approved_by);
create index if not exists lot_delivery_exceptions_revoked_by_idx
  on public.lot_delivery_exceptions (revoked_by) where revoked_by is not null;

comment on table public.lot_delivery_exceptions is
  'An authorized exception letting a vertical start consume a lot land development has not delivered. Never edited; revoked by setting revoked_at/revoked_by.';

create or replace function public.guard_lot_delivery_exception_references()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.lots l where l.id = new.lot_id and l.org_id = new.org_id) then
    raise exception 'The lot is not in this organization' using errcode = '23503';
  end if;
  if new.evidence_file_id is not null
     and not exists (select 1 from public.files f where f.id = new.evidence_file_id and f.org_id = new.org_id) then
    raise exception 'The evidence file is not in this organization' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_lot_delivery_exception_references() from public, anon, authenticated;

drop trigger if exists lot_delivery_exceptions_references on public.lot_delivery_exceptions;
create trigger lot_delivery_exceptions_references
  before insert on public.lot_delivery_exceptions
  for each row execute function public.guard_lot_delivery_exception_references();

create or replace function public.guard_lot_delivery_exception_revocation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is not null
     or new.revoked_at is null
     or (to_jsonb(new) - array['revoked_at', 'revoked_by', 'updated_at'])
        is distinct from (to_jsonb(old) - array['revoked_at', 'revoked_by', 'updated_at'])
  then
    raise exception 'A lot delivery exception cannot be changed, only revoked once' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_lot_delivery_exception_revocation() from public, anon, authenticated;

drop trigger if exists lot_delivery_exceptions_revocation_only on public.lot_delivery_exceptions;
create trigger lot_delivery_exceptions_revocation_only
  before update on public.lot_delivery_exceptions
  for each row execute function public.guard_lot_delivery_exception_revocation();

drop trigger if exists lot_delivery_exceptions_set_updated_at on public.lot_delivery_exceptions;
create trigger lot_delivery_exceptions_set_updated_at
  before update on public.lot_delivery_exceptions
  for each row execute function public.tg_set_updated_at();

alter table public.lot_delivery_exceptions enable row level security;

drop policy if exists lot_delivery_exceptions_read on public.lot_delivery_exceptions;
create policy lot_delivery_exceptions_read on public.lot_delivery_exceptions
  for select
  to authenticated
  using (public.is_org_member(org_id));

drop policy if exists lot_delivery_exceptions_insert on public.lot_delivery_exceptions;
create policy lot_delivery_exceptions_insert on public.lot_delivery_exceptions
  for insert
  to authenticated
  with check (
    public.has_org_permission(org_id, 'lot.delivery_override')
    and approved_by = (select auth.uid())
    and revoked_at is null
  );

drop policy if exists lot_delivery_exceptions_revoke on public.lot_delivery_exceptions;
create policy lot_delivery_exceptions_revoke on public.lot_delivery_exceptions
  for update
  to authenticated
  using (public.has_org_permission(org_id, 'lot.delivery_override'))
  with check (
    public.has_org_permission(org_id, 'lot.delivery_override')
    and revoked_by = (select auth.uid())
  );

drop policy if exists lot_delivery_exceptions_division_scope on public.lot_delivery_exceptions;
create policy lot_delivery_exceptions_division_scope on public.lot_delivery_exceptions
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or lot_id in (select public.member_reachable_lot_ids())
  )
  with check (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or lot_id in (select public.member_reachable_lot_ids())
  );

revoke all on table public.lot_delivery_exceptions from anon, authenticated;
grant select, insert, update on table public.lot_delivery_exceptions to authenticated;
grant all on table public.lot_delivery_exceptions to service_role;

-- ---------------------------------------------------------------------------
-- 2. Carry the metadata exceptions over, then drop the key.
-- ---------------------------------------------------------------------------

-- The recorder when they are still a user, otherwise the org's creator: the
-- exception was authorized in the service under community.write either way.
insert into public.lot_delivery_exceptions (org_id, lot_id, reason, approved_by, approved_at)
select l.org_id,
       l.id,
       btrim(l.metadata -> 'delivery_exception' ->> 'reason'),
       coalesce(recorder.id, o.created_by),
       case
         when (l.metadata -> 'delivery_exception' ->> 'at') ~ '^\d{4}-\d{2}-\d{2}T'
           then (l.metadata -> 'delivery_exception' ->> 'at')::timestamptz
         else l.updated_at
       end
  from public.lots l
  join public.orgs o on o.id = l.org_id
  left join public.app_users recorder
    on (l.metadata -> 'delivery_exception' ->> 'by') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and recorder.id = (l.metadata -> 'delivery_exception' ->> 'by')::uuid
 where l.metadata ? 'delivery_exception'
   and length(btrim(coalesce(l.metadata -> 'delivery_exception' ->> 'reason', ''))) >= 10
   and coalesce(recorder.id, o.created_by) is not null
on conflict do nothing;

update public.lots
   set metadata = metadata - 'delivery_exception'
 where metadata ? 'delivery_exception';

-- ---------------------------------------------------------------------------
-- 3. The gates read the record.
-- ---------------------------------------------------------------------------

-- Both triggers run as the writer. A writer who can reach the lot can read its
-- exception (same org, same division wall), so the check sees what it should.
create or replace function public.tg_start_packages_lot_delivered()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_delivered_at timestamptz;
begin
  if new.status = 'cancelled' then
    return new;
  end if;
  select delivered_at into v_delivered_at
    from public.lots
   where org_id = new.org_id and id = new.lot_id;
  if v_delivered_at is null and not exists (
    select 1 from public.lot_delivery_exceptions e
     where e.org_id = new.org_id and e.lot_id = new.lot_id and e.revoked_at is null
  ) then
    raise exception 'This lot has not been delivered by land development. Record a delivery exception with a reason to start on it.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function public.tg_lots_land_delivery()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    if current_user = 'authenticated' then
      if new.delivered_at is not null then
        raise exception 'Land delivery is recorded by marking the lot developed' using errcode = '42501';
      end if;
      if new.status in ('developed', 'assigned', 'started', 'closed')
         and not public.has_org_permission(new.org_id, 'lot.write') then
        raise exception 'Marking land delivered takes lot.write' using errcode = '42501';
      end if;
    end if;
    -- A lot loaded already developed or sold is a delivered lot.
    if new.delivered_at is null and new.status in ('developed', 'assigned', 'started', 'closed') then
      new.delivered_at := now();
    end if;
    return new;
  end if;

  -- A signed-in member never writes the land fact directly, and marks land
  -- delivered only with the authority to change lot status.
  if current_user = 'authenticated' then
    if new.delivered_at is distinct from old.delivered_at then
      raise exception 'Land delivery is recorded by marking the lot developed' using errcode = '42501';
    end if;
    if new.status = 'developed' and old.status is distinct from 'developed'
       and not public.has_org_permission(new.org_id, 'lot.write') then
      raise exception 'Marking land delivered takes lot.write' using errcode = '42501';
    end if;
  end if;

  -- A sale never delivers land: an undeveloped lot keeps its land status.
  if new.status = 'assigned' and old.status in ('controlled', 'owned') then
    new.status := old.status;
  end if;
  if new.status = 'developed' and old.status is distinct from 'developed' and new.delivered_at is null then
    new.delivered_at := now();
  end if;
  -- A house starts only on delivered land, or under an authorized exception.
  if new.status = 'started' and old.status is distinct from 'started' and new.delivered_at is null
     and not exists (
       select 1 from public.lot_delivery_exceptions e
        where e.org_id = new.org_id and e.lot_id = new.id and e.revoked_at is null
     ) then
    raise exception 'This lot has not been delivered by land development. Record a delivery exception with a reason to start on it.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists lots_land_delivery on public.lots;
create trigger lots_land_delivery
  before insert or update of status, delivered_at on public.lots
  for each row execute function public.tg_lots_land_delivery();

revoke all on function public.tg_lots_land_delivery() from public, anon, authenticated;
revoke all on function public.tg_start_packages_lot_delivered() from public, anon, authenticated;

comment on column public.lots.delivered_at is
  'When land development delivered the lot (status reached developed). Distinct from sales status: a reserved lot is not a delivered lot. A vertical start requires it or an active lot_delivery_exceptions row. Written only by the database.';

-- ---------------------------------------------------------------------------
-- 4. RBAC.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('lot.delivery_override', 'Start a house on undelivered land with a recorded reason')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select rp.role_id, 'lot.delivery_override'
from public.role_permissions rp
where rp.permission_key = 'community.write'
on conflict (role_id, permission_key) do nothing;
