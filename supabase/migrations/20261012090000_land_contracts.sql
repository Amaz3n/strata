-- Land contracts: the signed agreement a community's takedowns belong to.
--
-- A takedown recorded a date, a lot count, a price and one deposit figure, and
-- nothing said which contract obliged them or what it said about deposits,
-- extensions and penalties. This adds:
--
--   land_contracts            the agreement with the seller. Its terms are
--                             frozen the moment it is executed against a signed
--                             file; afterwards only its status moves forward.
--   land_contract_deposits    the deposit schedule: due dates, refundability,
--                             and payment / refund / forfeit with evidence.
--                             A paid deposit tied to a takedown is applied
--                             against that takedown's price when it closes.
--   land_contract_amendments  extensions, penalties and other changes after
--                             signing. Append-only, each with a reason and a
--                             signed evidence file.
--   lot_takedowns.land_contract_id
--                             a takedown under an executed contract keeps its
--                             signed lot count and price, and moves its date
--                             only through record_land_contract_extension(),
--                             which writes the amendment and the new date in
--                             one transaction.
--
-- Reads ride on org membership like lot_takedowns (takedown prices are already
-- visible to community readers); every write needs land_contract.write. The
-- division wall follows the community.

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. Contracts.
-- ---------------------------------------------------------------------------

create table if not exists public.land_contracts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete restrict,
  seller_company_id uuid references public.companies(id) on delete restrict,
  contract_number text,
  title text not null,
  kind text not null default 'purchase',
  status text not null default 'draft',
  executed_on date,
  executed_file_id uuid references public.files(id) on delete restrict,
  signature_envelope_id uuid references public.envelopes(id) on delete set null,
  total_lots integer not null default 0,
  base_price_per_lot_cents bigint,
  extension_terms text,
  penalty_terms text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint land_contracts_title_check check (length(btrim(title)) between 1 and 160),
  constraint land_contracts_kind_check check (kind in ('purchase', 'option')),
  constraint land_contracts_status_check check (status in ('draft', 'executed', 'terminated', 'completed')),
  constraint land_contracts_total_lots_check check (total_lots >= 0),
  constraint land_contracts_price_check check (base_price_per_lot_cents is null or base_price_per_lot_cents >= 0),
  -- An executed contract is one somebody signed: the date and the signed file.
  constraint land_contracts_execution_check check (
    status = 'draft' or (executed_on is not null and executed_file_id is not null)
  )
);

create unique index if not exists land_contracts_number_key
  on public.land_contracts (org_id, lower(btrim(contract_number))) where contract_number is not null;
create index if not exists land_contracts_org_community_idx on public.land_contracts (org_id, community_id, status);
create index if not exists land_contracts_community_idx on public.land_contracts (community_id);
create index if not exists land_contracts_seller_idx
  on public.land_contracts (seller_company_id) where seller_company_id is not null;
create index if not exists land_contracts_executed_file_idx
  on public.land_contracts (executed_file_id) where executed_file_id is not null;
create index if not exists land_contracts_envelope_idx
  on public.land_contracts (signature_envelope_id) where signature_envelope_id is not null;
create index if not exists land_contracts_created_by_idx
  on public.land_contracts (created_by) where created_by is not null;

comment on table public.land_contracts is
  'A land purchase or option agreement for a community. Terms are frozen once executed against a signed file; changes after signing are land_contract_amendments.';

-- Everything a contract names belongs to its own organization.
create or replace function public.guard_land_contract_references()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.communities c where c.id = new.community_id and c.org_id = new.org_id) then
    raise exception 'The community is not in this organization' using errcode = '23503';
  end if;
  if new.seller_company_id is not null
     and not exists (select 1 from public.companies c where c.id = new.seller_company_id and c.org_id = new.org_id) then
    raise exception 'The seller is not in this organization' using errcode = '23503';
  end if;
  if new.executed_file_id is not null
     and not exists (select 1 from public.files f where f.id = new.executed_file_id and f.org_id = new.org_id) then
    raise exception 'The signed contract file is not in this organization' using errcode = '23503';
  end if;
  if new.signature_envelope_id is not null
     and not exists (select 1 from public.envelopes e where e.id = new.signature_envelope_id and e.org_id = new.org_id) then
    raise exception 'The signature envelope is not in this organization' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_land_contract_references() from public, anon, authenticated;

drop trigger if exists land_contracts_references on public.land_contracts;
create trigger land_contracts_references
  before insert or update on public.land_contracts
  for each row execute function public.guard_land_contract_references();

-- What was signed stays signed. A draft is edited freely; an executed contract
-- only moves to terminated or completed, and a draft is the only one deleted.
create or replace function public.guard_land_contract_terms()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'An executed land contract is kept; terminate it instead' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.org_id is distinct from old.org_id or new.community_id is distinct from old.community_id then
    raise exception 'A land contract stays with its community' using errcode = '42501';
  end if;
  if old.status = 'draft' then
    if new.status not in ('draft', 'executed') then
      raise exception 'Execute a land contract before it can be terminated or completed' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.kind, new.seller_company_id, new.contract_number, new.title, new.executed_on, new.executed_file_id,
      new.total_lots, new.base_price_per_lot_cents, new.extension_terms, new.penalty_terms)
     is distinct from
     (old.kind, old.seller_company_id, old.contract_number, old.title, old.executed_on, old.executed_file_id,
      old.total_lots, old.base_price_per_lot_cents, old.extension_terms, old.penalty_terms) then
    raise exception 'An executed land contract''s terms cannot change. Record an amendment.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'executed' and new.status in ('terminated', 'completed')) then
    raise exception 'A land contract only moves from executed to terminated or completed' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_land_contract_terms() from public, anon, authenticated;

drop trigger if exists land_contracts_terms on public.land_contracts;
create trigger land_contracts_terms
  before update or delete on public.land_contracts
  for each row execute function public.guard_land_contract_terms();

drop trigger if exists land_contracts_set_updated_at on public.land_contracts;
create trigger land_contracts_set_updated_at
  before update on public.land_contracts
  for each row execute function public.tg_set_updated_at();

alter table public.land_contracts enable row level security;

drop policy if exists land_contracts_read on public.land_contracts;
create policy land_contracts_read on public.land_contracts
  for select
  to authenticated
  using (public.is_org_member(org_id));

drop policy if exists land_contracts_insert on public.land_contracts;
create policy land_contracts_insert on public.land_contracts
  for insert
  to authenticated
  with check (public.has_org_permission(org_id, 'land_contract.write'));

drop policy if exists land_contracts_update on public.land_contracts;
create policy land_contracts_update on public.land_contracts
  for update
  to authenticated
  using (public.has_org_permission(org_id, 'land_contract.write'))
  with check (public.has_org_permission(org_id, 'land_contract.write'));

drop policy if exists land_contracts_delete on public.land_contracts;
create policy land_contracts_delete on public.land_contracts
  for delete
  to authenticated
  using (public.has_org_permission(org_id, 'land_contract.write'));

drop policy if exists land_contracts_division_scope on public.land_contracts;
create policy land_contracts_division_scope on public.land_contracts
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or community_id in (select public.member_reachable_community_ids())
  )
  with check (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or community_id in (select public.member_reachable_community_ids())
  );

revoke all on table public.land_contracts from anon, authenticated;
grant select, insert, update, delete on table public.land_contracts to authenticated;
grant all on table public.land_contracts to service_role;

-- ---------------------------------------------------------------------------
-- 2. Takedowns belong to a contract.
-- ---------------------------------------------------------------------------

alter table public.lot_takedowns
  add column if not exists land_contract_id uuid references public.land_contracts(id) on delete restrict;

create index if not exists lot_takedowns_land_contract_idx
  on public.lot_takedowns (org_id, land_contract_id) where land_contract_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Deposit schedule.
-- ---------------------------------------------------------------------------

create table if not exists public.land_contract_deposits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  land_contract_id uuid not null references public.land_contracts(id) on delete cascade,
  takedown_id uuid references public.lot_takedowns(id) on delete restrict,
  label text,
  due_on date not null,
  amount_cents bigint not null,
  refundability text not null default 'refundable',
  refundable_until date,
  status text not null default 'scheduled',
  paid_on date,
  payment_reference text,
  evidence_file_id uuid references public.files(id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint land_contract_deposits_amount_check check (amount_cents > 0),
  constraint land_contract_deposits_refundability_check
    check (refundability in ('refundable', 'non_refundable', 'refundable_until')),
  constraint land_contract_deposits_refundable_until_check
    check ((refundability = 'refundable_until') = (refundable_until is not null)),
  constraint land_contract_deposits_status_check
    check (status in ('scheduled', 'paid', 'applied', 'refunded', 'forfeited')),
  -- Money that moved has a date and a receipt.
  constraint land_contract_deposits_evidence_check
    check (status = 'scheduled' or (paid_on is not null and evidence_file_id is not null))
);

create index if not exists land_contract_deposits_contract_idx
  on public.land_contract_deposits (org_id, land_contract_id, due_on);
create index if not exists land_contract_deposits_contract_fk_idx
  on public.land_contract_deposits (land_contract_id);
create index if not exists land_contract_deposits_takedown_idx
  on public.land_contract_deposits (takedown_id) where takedown_id is not null;
create index if not exists land_contract_deposits_evidence_idx
  on public.land_contract_deposits (evidence_file_id) where evidence_file_id is not null;
-- The cash plan reads what is still to be paid.
create index if not exists land_contract_deposits_due_idx
  on public.land_contract_deposits (org_id, due_on) where status = 'scheduled';

comment on table public.land_contract_deposits is
  'A land contract''s deposit schedule. Scheduled while the contract is a draft; paid, refunded and forfeited with evidence. A paid deposit tied to a takedown is applied against its price when the takedown closes.';

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
    (old.status = 'scheduled' and new.status = 'paid')
    or (old.status = 'paid' and new.status in ('applied', 'refunded', 'forfeited'))
  ) then
    raise exception 'A deposit moves scheduled, then paid, then applied, refunded or forfeited' using errcode = '42501';
  end if;
  if new.status = 'paid' and v_contract_status not in ('executed', 'completed', 'terminated') then
    raise exception 'Execute the land contract before recording a deposit payment' using errcode = '42501';
  end if;
  if old.status <> 'scheduled'
     and (new.paid_on, new.payment_reference) is distinct from (old.paid_on, old.payment_reference) then
    raise exception 'A recorded deposit payment cannot be rewritten' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_land_contract_deposit() from public, anon, authenticated;

drop trigger if exists land_contract_deposits_guard on public.land_contract_deposits;
create trigger land_contract_deposits_guard
  before insert or update or delete on public.land_contract_deposits
  for each row execute function public.guard_land_contract_deposit();

drop trigger if exists land_contract_deposits_set_updated_at on public.land_contract_deposits;
create trigger land_contract_deposits_set_updated_at
  before update on public.land_contract_deposits
  for each row execute function public.tg_set_updated_at();

alter table public.land_contract_deposits enable row level security;

drop policy if exists land_contract_deposits_read on public.land_contract_deposits;
create policy land_contract_deposits_read on public.land_contract_deposits
  for select
  to authenticated
  using (public.is_org_member(org_id));

drop policy if exists land_contract_deposits_insert on public.land_contract_deposits;
create policy land_contract_deposits_insert on public.land_contract_deposits
  for insert
  to authenticated
  with check (public.has_org_permission(org_id, 'land_contract.write'));

drop policy if exists land_contract_deposits_update on public.land_contract_deposits;
create policy land_contract_deposits_update on public.land_contract_deposits
  for update
  to authenticated
  using (public.has_org_permission(org_id, 'land_contract.write'))
  with check (public.has_org_permission(org_id, 'land_contract.write'));

drop policy if exists land_contract_deposits_delete on public.land_contract_deposits;
create policy land_contract_deposits_delete on public.land_contract_deposits
  for delete
  to authenticated
  using (public.has_org_permission(org_id, 'land_contract.write'));

-- Walled by the contract's community. The subquery reads land_contracts under
-- its own division policy, so it is the set of contracts the caller can reach.
drop policy if exists land_contract_deposits_division_scope on public.land_contract_deposits;
create policy land_contract_deposits_division_scope on public.land_contract_deposits
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or land_contract_id in (select c.id from public.land_contracts c)
  )
  with check (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or land_contract_id in (select c.id from public.land_contracts c)
  );

revoke all on table public.land_contract_deposits from anon, authenticated;
grant select, insert, update, delete on table public.land_contract_deposits to authenticated;
grant all on table public.land_contract_deposits to service_role;

-- ---------------------------------------------------------------------------
-- 4. Amendments: extensions, penalties and other post-signing changes.
-- ---------------------------------------------------------------------------

create table if not exists public.land_contract_amendments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  land_contract_id uuid not null references public.land_contracts(id) on delete restrict,
  takedown_id uuid references public.lot_takedowns(id) on delete restrict,
  kind text not null,
  from_date date,
  to_date date,
  fee_cents bigint not null default 0,
  due_on date,
  reason text not null,
  evidence_file_id uuid not null references public.files(id) on delete restrict,
  recorded_by uuid not null references public.app_users(id),
  recorded_at timestamptz not null default now(),
  constraint land_contract_amendments_kind_check check (kind in ('extension', 'penalty', 'other')),
  constraint land_contract_amendments_fee_check check (fee_cents >= 0),
  constraint land_contract_amendments_due_check check (fee_cents = 0 or due_on is not null),
  constraint land_contract_amendments_reason_check check (length(btrim(reason)) >= 10),
  constraint land_contract_amendments_extension_check check (
    kind <> 'extension'
    or (takedown_id is not null and from_date is not null and to_date is not null and to_date > from_date)
  )
);

create index if not exists land_contract_amendments_contract_idx
  on public.land_contract_amendments (org_id, land_contract_id, recorded_at desc);
create index if not exists land_contract_amendments_contract_fk_idx
  on public.land_contract_amendments (land_contract_id);
create index if not exists land_contract_amendments_takedown_idx
  on public.land_contract_amendments (takedown_id) where takedown_id is not null;
create index if not exists land_contract_amendments_evidence_idx
  on public.land_contract_amendments (evidence_file_id);
create index if not exists land_contract_amendments_recorded_by_idx
  on public.land_contract_amendments (recorded_by);
create index if not exists land_contract_amendments_fee_due_idx
  on public.land_contract_amendments (org_id, due_on) where fee_cents > 0;

comment on table public.land_contract_amendments is
  'Append-only changes to an executed land contract: takedown extensions, penalties and other amendments, each with a reason and the signed evidence.';

create or replace function public.guard_land_contract_amendment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Land contract amendments are kept as recorded; record another amendment instead' using errcode = '42501';
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

drop trigger if exists land_contract_amendments_append_only on public.land_contract_amendments;
create trigger land_contract_amendments_append_only
  before insert or update or delete on public.land_contract_amendments
  for each row execute function public.guard_land_contract_amendment();

alter table public.land_contract_amendments enable row level security;

drop policy if exists land_contract_amendments_read on public.land_contract_amendments;
create policy land_contract_amendments_read on public.land_contract_amendments
  for select
  to authenticated
  using (public.is_org_member(org_id));

drop policy if exists land_contract_amendments_insert on public.land_contract_amendments;
create policy land_contract_amendments_insert on public.land_contract_amendments
  for insert
  to authenticated
  with check (
    public.has_org_permission(org_id, 'land_contract.write')
    and recorded_by = (select auth.uid())
  );

drop policy if exists land_contract_amendments_division_scope on public.land_contract_amendments;
create policy land_contract_amendments_division_scope on public.land_contract_amendments
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or land_contract_id in (select c.id from public.land_contracts c)
  )
  with check (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or land_contract_id in (select c.id from public.land_contracts c)
  );

revoke all on table public.land_contract_amendments from anon, authenticated;
grant select, insert on table public.land_contract_amendments to authenticated;
grant all on table public.land_contract_amendments to service_role;

-- ---------------------------------------------------------------------------
-- 5. A takedown under an executed contract keeps its signed terms.
-- ---------------------------------------------------------------------------

create or replace function public.guard_lot_takedown_contract_terms()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_new_status text;
  v_new_community_id uuid;
  v_old_status text;
begin
  if new.land_contract_id is not null then
    select c.status, c.community_id into v_new_status, v_new_community_id
      from public.land_contracts c
     where c.id = new.land_contract_id and c.org_id = new.org_id;
    if not found then
      raise exception 'The land contract is not in this organization' using errcode = '23503';
    end if;
    if v_new_community_id <> new.community_id then
      raise exception 'A takedown belongs to a contract for its own community' using errcode = '23503';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if coalesce(v_new_status, 'draft') <> 'draft' then
      raise exception 'Takedowns are added to a land contract before it is executed' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.land_contract_id is not null then
    select c.status into v_old_status from public.land_contracts c where c.id = old.land_contract_id;
  end if;

  if new.land_contract_id is distinct from old.land_contract_id
     and (coalesce(v_old_status, 'draft') <> 'draft'
          or coalesce(v_new_status, 'draft') <> 'draft') then
    raise exception 'A takedown cannot move into or out of an executed land contract' using errcode = '42501';
  end if;

  if v_old_status is distinct from 'executed' or new.land_contract_id is distinct from old.land_contract_id then
    return new;
  end if;

  if (new.lot_count, new.price_per_lot_cents) is distinct from (old.lot_count, old.price_per_lot_cents) then
    raise exception 'The lot count and price of a takedown under an executed contract are signed terms. Record an amendment.'
      using errcode = '42501';
  end if;
  -- A new close date is an extension, recorded in this same transaction
  -- (record_land_contract_extension writes both).
  if new.scheduled_date is distinct from old.scheduled_date and not exists (
    select 1 from public.land_contract_amendments a
     where a.org_id = new.org_id
       and a.takedown_id = new.id
       and a.kind = 'extension'
       and a.from_date = old.scheduled_date
       and a.to_date = new.scheduled_date
       and a.recorded_at = now()
  ) then
    raise exception 'Moving the close date of a takedown under an executed contract is an extension. Record the extension with its signed evidence.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_lot_takedown_contract_terms() from public, anon, authenticated;

drop trigger if exists lot_takedowns_contract_terms on public.lot_takedowns;
create trigger lot_takedowns_contract_terms
  before insert or update on public.lot_takedowns
  for each row execute function public.guard_lot_takedown_contract_terms();

-- ---------------------------------------------------------------------------
-- 6. Extensions: the amendment and the new close date, together.
-- ---------------------------------------------------------------------------

create or replace function public.record_land_contract_extension(
  p_org_id uuid,
  p_takedown_id uuid,
  p_to_date date,
  p_fee_cents bigint,
  p_fee_due_on date,
  p_reason text,
  p_evidence_file_id uuid,
  p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_takedown public.lot_takedowns%rowtype;
  v_amendment_id uuid;
begin
  if p_actor_id is null or not exists (select 1 from public.app_users where id = p_actor_id) then
    raise exception 'An extension is recorded by a person' using errcode = '22023';
  end if;
  select * into v_takedown
    from public.lot_takedowns
   where org_id = p_org_id and id = p_takedown_id
   for update;
  if not found then
    raise exception 'Lot takedown not found' using errcode = 'P0002';
  end if;
  if v_takedown.status <> 'scheduled' then
    raise exception 'Only a scheduled takedown is extended' using errcode = '22023';
  end if;
  if v_takedown.land_contract_id is null or not exists (
    select 1 from public.land_contracts c where c.id = v_takedown.land_contract_id and c.status = 'executed'
  ) then
    raise exception 'Only a takedown under an executed land contract is extended; edit the date directly' using errcode = '22023';
  end if;
  if v_takedown.scheduled_date is null or p_to_date is null or p_to_date <= v_takedown.scheduled_date then
    raise exception 'An extension moves the close date later' using errcode = '22023';
  end if;

  insert into public.land_contract_amendments (
    org_id, land_contract_id, takedown_id, kind, from_date, to_date, fee_cents, due_on, reason, evidence_file_id, recorded_by
  ) values (
    p_org_id, v_takedown.land_contract_id, v_takedown.id, 'extension', v_takedown.scheduled_date, p_to_date,
    coalesce(p_fee_cents, 0), p_fee_due_on, btrim(coalesce(p_reason, '')), p_evidence_file_id, p_actor_id
  )
  returning id into v_amendment_id;

  -- The reminder markers belonged to the old date; the new one is announced afresh.
  update public.lot_takedowns
     set scheduled_date = p_to_date,
         metadata = metadata - 'reminded_at_30d' - 'reminded_at_7d' - 'reminded_at_0d'
   where id = v_takedown.id;

  return v_amendment_id;
end;
$$;

revoke all on function public.record_land_contract_extension(uuid, uuid, date, bigint, date, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.record_land_contract_extension(uuid, uuid, date, bigint, date, text, uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. RBAC.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('land_contract.write', 'Manage land contracts, deposits, extensions and penalties')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select rp.role_id, 'land_contract.write'
from public.role_permissions rp
where rp.permission_key = 'community.write'
on conflict (role_id, permission_key) do nothing;
