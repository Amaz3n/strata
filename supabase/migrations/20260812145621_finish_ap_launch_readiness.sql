begin;

-- The success watermark must never move when reconciliation failed. Attempts
-- have their own fair-scheduling cursor; the watchdog continues to read only
-- last_reconciled_at, which remains proof of a completed run.
alter table public.payment_rail_policies
  add column if not exists last_reconciliation_attempt_at timestamptz;

update public.payment_rail_policies
set payout_hold_hours = greatest(payout_hold_hours, 48),
    new_vendor_hold_hours = greatest(new_vendor_hold_hours, 24)
where payout_hold_hours < 48 or new_vendor_hold_hours < 24;

do $$
declare
  v_unsafe_orgs text;
begin
  select string_agg(org_id::text, ', ' order by org_id::text) into v_unsafe_orgs
  from public.payment_rail_policies
  where enabled
    and (
      per_payment_limit_cents is null
      or per_run_limit_cents is null
      or daily_limit_cents is null
      or max_inflight_cents is null
      or return_loss_ceiling_cents is null
      or payout_hold_hours < 48
      or new_vendor_hold_hours < 24
    );
  if v_unsafe_orgs is not null then
    raise exception 'Disable or fully configure unsafe payment policies before this migration: %', v_unsafe_orgs;
  end if;
end;
$$;

alter table public.payment_rail_policies
  drop constraint if exists payment_rail_policies_payout_hold_hours_check,
  drop constraint if exists payment_rail_policies_new_vendor_hold_hours_check,
  drop constraint if exists payment_rail_policies_launch_readiness_check;
alter table public.payment_rail_policies
  add constraint payment_rail_policies_payout_hold_hours_check check (payout_hold_hours between 48 and 720),
  add constraint payment_rail_policies_new_vendor_hold_hours_check check (new_vendor_hold_hours between 24 and 720),
  add constraint payment_rail_policies_launch_readiness_check check (
    not enabled or (
      per_payment_limit_cents is not null
      and per_run_limit_cents is not null
      and daily_limit_cents is not null
      and max_inflight_cents is not null
      and return_loss_ceiling_cents is not null
      and per_run_limit_cents >= per_payment_limit_cents
      and daily_limit_cents >= per_run_limit_cents
      and max_inflight_cents >= daily_limit_cents
    )
  );

-- External launch decisions are real controls, not checkboxes inferred from
-- code being merged. They are append-only attestations so a revoked approval
-- remains visible and the current state is always the latest signed decision.
create table if not exists public.payment_launch_gate_attestations (
  id uuid primary key default gen_random_uuid(),
  gate_key text not null check (gate_key in (
    'provider_program','payments_legal','risk_reserves','operations_runbook','production_qa'
  )),
  decision text not null check (decision in ('approved','revoked')),
  evidence_reference text not null check (length(btrim(evidence_reference)) >= 3),
  note text not null check (length(btrim(note)) >= 20),
  attested_by uuid not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index if not exists payment_launch_gate_attestations_latest_idx
  on public.payment_launch_gate_attestations (gate_key, created_at desc, id desc);
alter table public.payment_launch_gate_attestations enable row level security;
revoke all on table public.payment_launch_gate_attestations from public, anon, authenticated;
grant select, insert on table public.payment_launch_gate_attestations to service_role;

create or replace function public.prevent_payment_launch_attestation_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Payment launch attestations are append-only';
end;
$$;
drop trigger if exists payment_launch_gate_attestations_append_only on public.payment_launch_gate_attestations;
create trigger payment_launch_gate_attestations_append_only
  before update or delete on public.payment_launch_gate_attestations
  for each row execute function public.prevent_payment_launch_attestation_mutation();
revoke all on function public.prevent_payment_launch_attestation_mutation() from public, anon, authenticated;
grant execute on function public.prevent_payment_launch_attestation_mutation() to service_role;

-- A free-text note alone cannot close a money discrepancy. Keep a structured
-- external reference and evidence payload so an exception has an auditable
-- explanation tied to a provider, bank, or accounting correction.
alter table public.payment_reconciliation_items
  add column if not exists resolution_reference text,
  add column if not exists resolution_evidence jsonb;

alter table public.payment_reconciliation_items
  drop constraint if exists payment_reconciliation_resolution_evidence_check;
update public.payment_reconciliation_items
set resolution_reference = coalesce(nullif(btrim(resolution_reference), ''), 'legacy-resolution:' || id::text),
    resolution_evidence = coalesce(resolution_evidence, jsonb_build_object(
      'source', 'legacy',
      'verified_at', coalesce(resolved_at, created_at),
      'corrective_action', coalesce(resolution_note, 'Resolution predates structured evidence requirements')
    )),
    resolution_note = coalesce(nullif(btrim(resolution_note), ''), 'Resolution predates structured evidence requirements')
where status = 'resolved';
alter table public.payment_reconciliation_items
  add constraint payment_reconciliation_resolution_evidence_check check (
    status <> 'resolved'
    or (
      nullif(btrim(coalesce(resolution_note, '')), '') is not null
      and nullif(btrim(coalesce(resolution_reference, '')), '') is not null
      and jsonb_typeof(resolution_evidence) = 'object'
      and nullif(btrim(coalesce(resolution_evidence->>'source', '')), '') is not null
      and nullif(btrim(coalesce(resolution_evidence->>'verified_at', '')), '') is not null
    )
  ) not valid;
alter table public.payment_reconciliation_items
  validate constraint payment_reconciliation_resolution_evidence_check;

-- Allocate webhook attempt numbers under a row lock. Counting then inserting
-- races when two retries for the same provider event land together.
create or replace function public.record_payment_provider_event_attempt(
  p_provider_event_id uuid,
  p_outcome text,
  p_processing_error text,
  p_started_at timestamptz,
  p_completed_at timestamptz
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_attempt_number integer;
begin
  if p_outcome not in ('processed','ignored','failed') then
    raise exception 'Unsupported provider-event outcome';
  end if;
  perform 1 from public.payment_provider_events where id = p_provider_event_id for update;
  if not found then raise exception 'Provider event was not found'; end if;
  select coalesce(max(attempt_number), 0) + 1 into v_attempt_number
  from public.payment_provider_event_attempts where provider_event_id = p_provider_event_id;
  insert into public.payment_provider_event_attempts (
    provider_event_id, attempt_number, outcome, processing_error, started_at, completed_at
  ) values (
    p_provider_event_id, v_attempt_number, p_outcome, p_processing_error, p_started_at, p_completed_at
  ) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.record_payment_provider_event_attempt(uuid,text,text,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.record_payment_provider_event_attempt(uuid,text,text,timestamptz,timestamptz) to service_role;

-- Serialize the same canonical invoice identity the application uses. Removing
-- punctuation makes INV-1024 and INV 1024 the same obligation, not two invoices
-- that happen to evade an exact-text trigger.
create or replace function public.normalize_vendor_invoice_number(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select nullif(regexp_replace(lower(btrim(coalesce(p_value, ''))), '[^a-z0-9]+', '', 'g'), '')
$$;

revoke all on function public.normalize_vendor_invoice_number(text) from public, anon, authenticated;
grant execute on function public.normalize_vendor_invoice_number(text) to service_role;

create or replace function public.prevent_concurrent_vendor_bill_duplicate()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_number text := public.normalize_vendor_invoice_number(new.bill_number);
begin
  if new.company_id is null or v_number is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.org_id::text || ':' || new.company_id::text || ':' || v_number, 0));
  if exists (
    select 1
    from public.vendor_bills bill
    where bill.org_id = new.org_id
      and bill.company_id = new.company_id
      and public.normalize_vendor_invoice_number(bill.bill_number) = v_number
      and bill.id is distinct from new.id
      and lower(coalesce(bill.status, '')) not in ('void','voided','cancelled','canceled','rejected')
  ) then
    raise exception 'Duplicate vendor invoice number for this company';
  end if;
  return new;
end;
$$;

-- An approved run is evidence about one exact liability. Prevent edits that
-- would change the project, vendor, amount, currency, retainage, dates, coding,
-- or source document while that evidence is active. Provider settlement is
-- still allowed to advance paid_cents/status; returning a bill to pending or
-- rejected is not.
create or replace function public.prevent_active_payment_run_payable_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_has_active_run boolean;
begin
  select exists (
    select 1
    from public.payment_run_items item
    join public.payment_runs run on run.id = item.run_id and run.org_id = item.org_id
    where item.org_id = old.org_id
      and item.bill_id = old.id
      and item.status in ('draft','pending_approval','approved','processing','partially_paid')
      and run.status in ('draft','pending_approval','approved','processing','partially_paid')
  ) into v_has_active_run;

  if not v_has_active_run then return new; end if;

  if new.org_id is distinct from old.org_id
     or new.project_id is distinct from old.project_id
     or new.commitment_id is distinct from old.commitment_id
     or new.company_id is distinct from old.company_id
     or new.bill_number is distinct from old.bill_number
     or new.bill_date is distinct from old.bill_date
     or new.due_date is distinct from old.due_date
     or new.total_cents is distinct from old.total_cents
     or new.currency is distinct from old.currency
     or new.retainage_percent is distinct from old.retainage_percent
     or new.retainage_cents is distinct from old.retainage_cents
     or new.file_id is distinct from old.file_id
     or new.accounting_coding is distinct from old.accounting_coding
     or new.qbo_vendor_id is distinct from old.qbo_vendor_id
     or new.qbo_expense_account_id is distinct from old.qbo_expense_account_id
     or new.qbo_ap_account_id is distinct from old.qbo_ap_account_id
     or (new.status in ('pending','rejected') and new.status is distinct from old.status) then
    raise exception 'This payable belongs to an active payment run; cancel the run before changing the approved obligation';
  end if;
  return new;
end;
$$;

drop trigger if exists vendor_bills_protect_active_payment_run on public.vendor_bills;
create trigger vendor_bills_protect_active_payment_run
  before update on public.vendor_bills
  for each row execute function public.prevent_active_payment_run_payable_mutation();

-- Trigger helpers are internal implementation details, not Data API RPCs.
revoke all on function public.prevent_concurrent_vendor_bill_duplicate() from public, anon, authenticated;
revoke all on function public.prevent_active_payment_run_payable_mutation() from public, anon, authenticated;
grant execute on function public.prevent_concurrent_vendor_bill_duplicate() to service_role;
grant execute on function public.prevent_active_payment_run_payable_mutation() to service_role;

-- These mutations are called only through the service-role application layer.
-- They do not need owner privileges; SECURITY INVOKER sharply reduces the blast
-- radius of a future mistake inside one of their bodies.
do $$
declare
  v_function record;
begin
  for v_function in
    select p.oid::regprocedure::text as identity
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'create_payment_run_atomic',
        'submit_payment_run_atomic',
        'cancel_payment_run_atomic',
        'decide_payment_run_atomic',
        'claim_payment_run_execution_atomic',
        'record_ap_payment_atomic',
        'record_ap_payment_reversal_atomic',
        'record_payment_provider_event_attempt'
      ])
  loop
    execute format('alter function %s security invoker', v_function.identity);
  end loop;
end;
$$;

commit;
