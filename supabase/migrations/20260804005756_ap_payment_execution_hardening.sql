-- AP execution hardening. This migration is intentionally service-role only:
-- payment execution is never a browser-writable surface.

alter table public.disbursements
  add column if not exists actual_processor_fee_cents bigint
    check (actual_processor_fee_cents is null or actual_processor_fee_cents >= 0),
  add column if not exists submission_attempted_at timestamptz;

alter table public.payment_rail_policies
  add column if not exists last_reconciled_at timestamptz;

-- Serialize duplicate invoice-number checks so concurrent intake paths cannot
-- both pass an application-level lookup and create the same vendor obligation.
create or replace function public.prevent_concurrent_vendor_bill_duplicate()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null or nullif(btrim(new.bill_number), '') is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.org_id::text || ':' || new.company_id::text || ':' || lower(btrim(new.bill_number)), 0));
  if exists (
    select 1 from public.vendor_bills bill
    where bill.org_id = new.org_id
      and bill.company_id = new.company_id
      and lower(btrim(bill.bill_number)) = lower(btrim(new.bill_number))
      and bill.id is distinct from new.id
      and lower(coalesce(bill.status, '')) not in ('void','voided','cancelled','canceled')
  ) then raise exception 'Duplicate vendor invoice number for this company'; end if;
  return new;
end;
$$;

drop trigger if exists vendor_bills_prevent_concurrent_duplicate on public.vendor_bills;
create trigger vendor_bills_prevent_concurrent_duplicate
  before insert or update of org_id, company_id, bill_number, status on public.vendor_bills
  for each row execute function public.prevent_concurrent_vendor_bill_duplicate();

create table if not exists public.payment_execution_reservations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_id uuid not null unique references public.payment_runs(id) on delete restrict,
  business_date date not null,
  reserved_cents bigint not null check (reserved_cents > 0),
  created_at timestamptz not null default now()
);

create index if not exists payment_execution_reservations_daily_idx
  on public.payment_execution_reservations (org_id, business_date);

alter table public.payment_execution_reservations enable row level security;
revoke all on public.payment_execution_reservations from public, anon, authenticated;
grant all on public.payment_execution_reservations to service_role;

-- Bind every ACH destination to the vendor relationship captured by the run
-- item. This closes both cross-org and same-org recipient substitution.
create or replace function public.enforce_payment_payee_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  item_org uuid;
  item_relationship uuid;
  relationship_entity uuid;
  relationship_recipient uuid;
  recipient_entity uuid;
begin
  select org_id, relationship_id into item_org, item_relationship
  from public.payment_run_items where id = new.run_item_id;

  if item_org is distinct from new.org_id then
    raise exception 'Payment payee must belong to the run item organization';
  end if;

  if new.method = 'ach' then
    select vendor_entity_id, recipient_account_id
      into relationship_entity, relationship_recipient
    from public.vendor_payment_relationships
    where id = item_relationship and org_id = new.org_id and status = 'active';

    select vendor_entity_id into recipient_entity
    from public.payment_recipient_accounts where id = new.recipient_account_id;

    if relationship_entity is null
       or recipient_entity is distinct from relationship_entity
       or (new.payee_kind = 'primary_vendor' and new.recipient_account_id is distinct from relationship_recipient) then
      raise exception 'ACH recipient is not verified for this vendor relationship';
    end if;
  end if;
  return new;
end;
$$;

-- Serializes each organization's execution admission and records the amount
-- before the lock is released. Concurrent runs therefore cannot both pass a
-- daily limit while neither has created its disbursements yet.
create or replace function public.claim_payment_run_execution_atomic(
  p_org_id uuid,
  p_run_id uuid,
  p_claimed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.payment_runs%rowtype;
  v_daily_limit bigint;
  v_reserved bigint;
  v_date date := (coalesce(p_claimed_at, now()) at time zone 'UTC')::date;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || v_date::text, 0));

  select * into v_run from public.payment_runs
  where id = p_run_id and org_id = p_org_id for update;
  if v_run.id is null then raise exception 'Payment run not found'; end if;

  if v_run.status = 'processing' then
    return jsonb_build_object('claimed', false, 'duplicate', true, 'status', v_run.status);
  end if;
  if v_run.status <> 'approved' then raise exception 'Payment run is not approved'; end if;

  v_daily_limit := nullif(v_run.control_snapshot #>> '{policy,daily_limit_cents}', '')::bigint;
  select coalesce(sum(reserved_cents), 0) into v_reserved
  from public.payment_execution_reservations
  where org_id = p_org_id and business_date = v_date;

  if v_daily_limit is not null and v_reserved + v_run.total_debit_cents > v_daily_limit then
    raise exception 'Organization daily payment limit would be exceeded';
  end if;

  insert into public.payment_execution_reservations (org_id, run_id, business_date, reserved_cents)
  values (p_org_id, p_run_id, v_date, v_run.total_debit_cents)
  on conflict (run_id) do nothing;

  update public.payment_runs
  set status = 'processing', processing_started_at = coalesce(processing_started_at, p_claimed_at, now())
  where id = p_run_id and org_id = p_org_id and status = 'approved';

  if not found then raise exception 'Payment run execution was claimed concurrently'; end if;
  return jsonb_build_object('claimed', true, 'duplicate', false, 'status', 'processing');
end;
$$;

revoke all on function public.claim_payment_run_execution_atomic(uuid,uuid,timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_payment_run_execution_atomic(uuid,uuid,timestamptz)
  to service_role;
