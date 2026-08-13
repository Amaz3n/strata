-- Receivables foundation: invoice posture, durable delivery/receipt state, and
-- concurrency-safe online-payment reservations.

begin;

alter table public.invoices
  add column if not exists product_posture text,
  add column if not exists approval_status text not null default 'not_required',
  add column if not exists delivery_status text not null default 'not_sent',
  add column if not exists issued_snapshot jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.invoices'::regclass
      and conname = 'invoices_product_posture_check'
  ) then
    alter table public.invoices add constraint invoices_product_posture_check
      check (product_posture is null or product_posture in ('residential', 'commercial', 'production'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.invoices'::regclass
      and conname = 'invoices_approval_status_check'
  ) then
    alter table public.invoices add constraint invoices_approval_status_check
      check (approval_status in ('not_required', 'draft', 'pending', 'approved', 'rejected'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.invoices'::regclass
      and conname = 'invoices_delivery_status_check'
  ) then
    alter table public.invoices add constraint invoices_delivery_status_check
      check (delivery_status in ('not_sent', 'queued', 'sending', 'sent', 'delivered', 'bounced', 'failed'));
  end if;
end $$;

create table if not exists public.invoice_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  channel text not null default 'email'
    check (channel in ('email', 'sms', 'link', 'download')),
  recipient text,
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'delivered', 'bounced', 'failed')),
  idempotency_key text,
  provider_message_id text,
  error_message text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  failed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists invoice_deliveries_idempotency_idx
  on public.invoice_deliveries (org_id, idempotency_key);
create index if not exists invoice_deliveries_invoice_timeline_idx
  on public.invoice_deliveries (org_id, invoice_id, created_at desc);

alter table public.invoice_deliveries enable row level security;
drop policy if exists invoice_deliveries_access on public.invoice_deliveries;
create policy invoice_deliveries_access on public.invoice_deliveries
  using (auth.role() = 'service_role' or public.is_org_member(org_id))
  with check (auth.role() = 'service_role' or public.is_org_member(org_id));
grant select on public.invoice_deliveries to authenticated;
grant select, insert, update on public.invoice_deliveries to service_role;

create table if not exists public.invoice_approval_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete restrict,
  decided_by uuid references auth.users(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'canceled')),
  note text,
  decision_note text,
  invoice_updated_at timestamptz not null,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists invoice_approval_requests_pending_idx
  on public.invoice_approval_requests (org_id, invoice_id)
  where status = 'pending';
create index if not exists invoice_approval_requests_timeline_idx
  on public.invoice_approval_requests (org_id, invoice_id, created_at desc);
alter table public.invoice_approval_requests enable row level security;
drop policy if exists invoice_approval_requests_access on public.invoice_approval_requests;
create policy invoice_approval_requests_access on public.invoice_approval_requests
  using (auth.role() = 'service_role' or public.is_org_member(org_id))
  with check (auth.role() = 'service_role' or public.is_org_member(org_id));
grant select on public.invoice_approval_requests to authenticated;
grant select, insert, update on public.invoice_approval_requests to service_role;

create or replace function public.request_invoice_approval(
  p_org_id uuid,
  p_invoice_id uuid,
  p_actor_id uuid,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_invoice public.invoices%rowtype;
  v_request public.invoice_approval_requests%rowtype;
begin
  if auth.uid() is not null and auth.uid() <> p_actor_id then
    raise exception 'Approval requester does not match the signed-in user';
  end if;
  select * into v_invoice from public.invoices
  where id = p_invoice_id and org_id = p_org_id for update;
  if v_invoice.id is null then raise exception 'Invoice not found'; end if;
  if v_invoice.product_posture <> 'commercial' then
    raise exception 'This invoice does not require commercial approval';
  end if;
  if v_invoice.sent_at is not null or v_invoice.status not in ('draft', 'saved') then
    raise exception 'Only an unissued invoice can be submitted for approval';
  end if;

  update public.invoice_approval_requests
  set status = 'canceled', updated_at = now()
  where org_id = p_org_id and invoice_id = p_invoice_id and status = 'pending';

  update public.invoices set approval_status = 'pending'
  where id = p_invoice_id and org_id = p_org_id
  returning * into v_invoice;

  insert into public.invoice_approval_requests (
    org_id, invoice_id, requested_by, status, note, invoice_updated_at
  ) values (
    p_org_id, p_invoice_id, p_actor_id, 'pending', nullif(trim(p_note), ''),
    v_invoice.updated_at
  ) returning * into v_request;
  return to_jsonb(v_request);
end;
$$;

create or replace function public.decide_invoice_approval(
  p_org_id uuid,
  p_invoice_id uuid,
  p_actor_id uuid,
  p_decision text,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_invoice public.invoices%rowtype;
  v_request public.invoice_approval_requests%rowtype;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Approval decision must be approved or rejected';
  end if;
  if auth.uid() is not null and auth.uid() <> p_actor_id then
    raise exception 'Approver does not match the signed-in user';
  end if;
  select * into v_invoice from public.invoices
  where id = p_invoice_id and org_id = p_org_id for update;
  select * into v_request from public.invoice_approval_requests
  where org_id = p_org_id and invoice_id = p_invoice_id and status = 'pending'
  for update;
  if v_invoice.id is null or v_request.id is null then
    raise exception 'Pending invoice approval not found';
  end if;
  if v_request.requested_by = p_actor_id then
    raise exception 'The requester cannot approve their own owner billing';
  end if;
  if v_invoice.updated_at <> v_request.invoice_updated_at
    or v_invoice.approval_status <> 'pending' then
    raise exception 'Invoice changed after the approval request; submit it again';
  end if;

  update public.invoice_approval_requests set
    status = p_decision, decided_by = p_actor_id,
    decision_note = nullif(trim(p_note), ''), decided_at = now(), updated_at = now()
  where id = v_request.id returning * into v_request;
  update public.invoices set approval_status = p_decision
  where id = p_invoice_id and org_id = p_org_id;
  return to_jsonb(v_request);
end;
$$;

revoke all on function public.request_invoice_approval(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.decide_invoice_approval(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.request_invoice_approval(uuid, uuid, uuid, text) to service_role;
grant execute on function public.decide_invoice_approval(uuid, uuid, uuid, text, text) to service_role;

-- The original receipt table did not contain the fields written by the payment
-- service and had no conflict target for retry-safe issuance.
alter table public.receipts
  add column if not exists project_id uuid references public.projects(id) on delete set null,
  add column if not exists invoice_id uuid references public.invoices(id) on delete set null,
  add column if not exists amount_cents integer,
  add column if not exists issued_to_email text,
  add column if not exists delivery_status text not null default 'not_sent',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists receipts_payment_id_unique_idx
  on public.receipts (payment_id);
create index if not exists receipts_invoice_idx
  on public.receipts (org_id, invoice_id, issued_at desc);

-- Reservations serialize the balance check before calling a payment processor.
-- They are deliberately service-role only: public checkout routes use the
-- service client after validating an invoice token or signed pay link.
create table if not exists public.invoice_payment_reservations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  principal_cents integer not null check (principal_cents > 0),
  charge_cents integer not null check (charge_cents >= principal_cents),
  currency text not null default 'usd',
  method text,
  status text not null default 'active'
    check (status in ('active', 'consumed', 'expired', 'canceled')),
  expires_at timestamptz not null,
  provider_intent_id text,
  idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists invoice_payment_reservations_idempotency_idx
  on public.invoice_payment_reservations (idempotency_key);
create unique index if not exists invoice_payment_reservations_provider_idx
  on public.invoice_payment_reservations (provider_intent_id)
  where provider_intent_id is not null;
create index if not exists invoice_payment_reservations_active_invoice_idx
  on public.invoice_payment_reservations (org_id, invoice_id, expires_at)
  where status = 'active';

alter table public.invoice_payment_reservations enable row level security;
revoke all on table public.invoice_payment_reservations from public, anon, authenticated;
grant all on table public.invoice_payment_reservations to service_role;

create or replace function public.reserve_invoice_payment(
  p_org_id uuid,
  p_invoice_id uuid,
  p_principal_cents integer,
  p_charge_cents integer,
  p_currency text,
  p_method text,
  p_idempotency_key text,
  p_expires_at timestamptz,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_invoice public.invoices%rowtype;
  v_existing public.invoice_payment_reservations%rowtype;
  v_reserved bigint;
  v_available bigint;
  v_reservation public.invoice_payment_reservations%rowtype;
begin
  if p_principal_cents <= 0 or p_charge_cents < p_principal_cents then
    raise exception 'Invalid payment reservation amount';
  end if;
  if nullif(trim(p_idempotency_key), '') is null then
    raise exception 'Payment reservation requires an idempotency key';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and org_id = p_org_id
  for update;

  if v_invoice.id is null then
    raise exception 'Invoice not found or inaccessible';
  end if;
  if not coalesce(v_invoice.client_visible, false) or v_invoice.status = 'void' then
    raise exception 'Invoice is not available for online payment';
  end if;

  update public.invoice_payment_reservations
  set status = 'expired', updated_at = now()
  where org_id = p_org_id
    and invoice_id = p_invoice_id
    and status = 'active'
    and expires_at <= now();

  select * into v_existing
  from public.invoice_payment_reservations
  where idempotency_key = p_idempotency_key
  for update;

  if v_existing.id is not null then
    if v_existing.org_id <> p_org_id
      or v_existing.invoice_id <> p_invoice_id
      or v_existing.principal_cents <> p_principal_cents
      or v_existing.charge_cents <> p_charge_cents then
      raise exception 'Idempotency key was already used for a different payment';
    end if;
    if v_existing.status = 'active' and v_existing.expires_at > now() then
      return to_jsonb(v_existing) || jsonb_build_object('created', false);
    end if;
    raise exception 'Payment attempt expired; start a new payment';
  end if;

  select coalesce(sum(principal_cents), 0) into v_reserved
  from public.invoice_payment_reservations
  where org_id = p_org_id
    and invoice_id = p_invoice_id
    and status = 'active'
    and expires_at > now();

  v_available := greatest(coalesce(v_invoice.balance_due_cents, v_invoice.total_cents, 0) - v_reserved, 0);
  if p_principal_cents > v_available then
    raise exception 'Payment amount exceeds the unreserved invoice balance';
  end if;

  insert into public.invoice_payment_reservations (
    org_id, project_id, invoice_id, principal_cents, charge_cents, currency,
    method, expires_at, idempotency_key, metadata
  ) values (
    p_org_id, v_invoice.project_id, p_invoice_id, p_principal_cents,
    p_charge_cents, lower(coalesce(p_currency, 'usd')), p_method,
    greatest(coalesce(p_expires_at, now() + interval '30 minutes'), now() + interval '5 minutes'),
    p_idempotency_key, coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_reservation;

  return to_jsonb(v_reservation) || jsonb_build_object('created', true);
end;
$$;

create or replace function public.commit_invoice_payment_intent(
  p_reservation_id uuid,
  p_provider_intent_id text,
  p_status text,
  p_client_secret text,
  p_connected_account_id text,
  p_charge_type text,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_reservation public.invoice_payment_reservations%rowtype;
  v_intent public.payment_intents%rowtype;
begin
  select * into v_reservation
  from public.invoice_payment_reservations
  where id = p_reservation_id
  for update;

  if v_reservation.id is null or v_reservation.status <> 'active'
    or v_reservation.expires_at <= now() then
    raise exception 'Payment reservation is no longer active';
  end if;

  insert into public.payment_intents (
    org_id, project_id, invoice_id, provider, provider_intent_id, status,
    amount_cents, currency, client_secret, idempotency_key, expires_at,
    connected_account_id, charge_type, application_fee_amount,
    processor_fee_cents, platform_fee_cents, metadata
  ) values (
    v_reservation.org_id, v_reservation.project_id, v_reservation.invoice_id,
    'stripe', p_provider_intent_id, p_status, v_reservation.charge_cents,
    v_reservation.currency, p_client_secret, v_reservation.idempotency_key,
    v_reservation.expires_at, p_connected_account_id, p_charge_type, 0, 0, 0,
    coalesce(p_metadata, '{}'::jsonb)
      || jsonb_build_object('payment_reservation_id', v_reservation.id)
  )
  on conflict (idempotency_key) where idempotency_key is not null
  do update set
    provider_intent_id = excluded.provider_intent_id,
    status = excluded.status,
    client_secret = excluded.client_secret,
    metadata = excluded.metadata,
    updated_at = now()
  returning * into v_intent;

  update public.invoice_payment_reservations
  set provider_intent_id = p_provider_intent_id, updated_at = now()
  where id = v_reservation.id;

  return to_jsonb(v_intent);
end;
$$;

create or replace function public.cancel_invoice_payment_reservation(
  p_reservation_id uuid,
  p_reason text default null
) returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  update public.invoice_payment_reservations
  set status = 'canceled',
      metadata = metadata || jsonb_build_object('canceled_reason', p_reason),
      updated_at = now()
  where id = p_reservation_id and status = 'active';
end;
$$;

revoke all on function public.reserve_invoice_payment(uuid, uuid, integer, integer, text, text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.commit_invoice_payment_intent(uuid, text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.cancel_invoice_payment_reservation(uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_invoice_payment(uuid, uuid, integer, integer, text, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.commit_invoice_payment_intent(uuid, text, text, text, text, text, jsonb) to service_role;
grant execute on function public.cancel_invoice_payment_reservation(uuid, text) to service_role;

-- Only settled money changes operational AR. Processing payments remain visible
-- in their own state, and a pending reversal does not change the books early.
create or replace function public.invoice_paid_cents(
  p_org_id uuid,
  p_invoice_id uuid
) returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
    coalesce((
      select sum(amount_cents)
      from public.payments
      where org_id = p_org_id
        and invoice_id = p_invoice_id
        and status in ('succeeded', 'completed', 'paid', 'refunded')
    ), 0)
    + coalesce((
      select sum(pa.amount_cents)
      from public.payment_allocations pa
      join public.payments p on p.id = pa.payment_id and p.org_id = pa.org_id
      where pa.org_id = p_org_id
        and pa.invoice_id = p_invoice_id
        and p.status in ('succeeded', 'completed', 'paid', 'refunded')
    ), 0)
    - coalesce((
      select sum(amount_cents)
      from public.payment_reversals
      where org_id = p_org_id
        and invoice_id = p_invoice_id
        and status = 'succeeded'
    ), 0)
  , 0);
$$;

revoke all on function public.invoice_paid_cents(uuid, uuid) from public, anon, authenticated;
grant execute on function public.invoice_paid_cents(uuid, uuid) to service_role;

-- Extend the existing atomic payment wrapper so a provider success consumes its
-- reservation in the same transaction that updates payment and invoice state.
create or replace function public.apply_invoice_payment_with_details_atomic(
  p_org_id uuid,
  p_invoice_id uuid,
  p_amount_cents integer,
  p_currency text,
  p_method text,
  p_provider text,
  p_provider_payment_id text,
  p_status text,
  p_reference text,
  p_fee_cents integer,
  p_gross_cents integer,
  p_net_cents integer,
  p_idempotency_key text,
  p_metadata jsonb,
  p_received_at timestamptz,
  p_provider_charge_id text,
  p_connected_account_id text,
  p_processor_fee_cents integer,
  p_platform_fee_cents integer,
  p_application_fee_cents integer,
  p_provider_balance_transaction_id text,
  p_provider_transfer_id text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  payment_result jsonb;
  payment_id uuid;
  payment_row public.payments%rowtype;
  reservation_id uuid;
  reservation public.invoice_payment_reservations%rowtype;
begin
  reservation_id := nullif(p_metadata ->> 'payment_reservation_id', '')::uuid;
  if reservation_id is not null then
    select * into reservation
    from public.invoice_payment_reservations
    where id = reservation_id
    for update;
    if reservation.id is null
      or reservation.org_id <> p_org_id
      or reservation.invoice_id <> p_invoice_id
      or reservation.principal_cents <> p_amount_cents then
      raise exception 'Payment reservation does not match the payment';
    end if;
  end if;

  payment_result := public.apply_invoice_payment_atomic(
    p_org_id, p_invoice_id, p_amount_cents, p_currency, p_method, p_provider,
    p_provider_payment_id, p_status, p_reference, p_fee_cents, p_gross_cents,
    p_net_cents, p_idempotency_key, p_metadata
  );
  payment_id := (payment_result ->> 'id')::uuid;

  update public.payments
  set status = p_status,
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
      received_at = coalesce(p_received_at, received_at),
      provider_charge_id = p_provider_charge_id,
      connected_account_id = p_connected_account_id,
      processor_fee_cents = coalesce(p_processor_fee_cents, 0),
      platform_fee_cents = coalesce(p_platform_fee_cents, 0),
      application_fee_cents = coalesce(p_application_fee_cents, 0),
      provider_balance_transaction_id = p_provider_balance_transaction_id,
      provider_transfer_id = p_provider_transfer_id
  where id = payment_id and org_id = p_org_id
  returning * into payment_row;

  if payment_row.id is null then
    raise exception 'Atomic payment details could not be persisted';
  end if;

  perform public.recalc_invoice_balance_atomic(p_org_id, p_invoice_id);

  if reservation_id is not null then
    if p_status in ('succeeded', 'completed', 'paid', 'refunded') then
      update public.invoice_payment_reservations
      set status = 'consumed', updated_at = now()
      where id = reservation_id and status in ('active', 'consumed');
    elsif p_status = 'processing' then
      update public.invoice_payment_reservations
      set expires_at = greatest(expires_at, now() + interval '7 days'), updated_at = now()
      where id = reservation_id and status = 'active';
    elsif p_status in ('failed', 'canceled') then
      update public.invoice_payment_reservations
      set status = 'canceled', updated_at = now()
      where id = reservation_id and status = 'active';
    end if;
  end if;

  return to_jsonb(payment_row) || (payment_result - 'id');
end;
$$;

revoke all on function public.apply_invoice_payment_with_details_atomic(uuid, uuid, integer, text, text, text, text, text, text, integer, integer, integer, text, jsonb, timestamptz, text, text, integer, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.apply_invoice_payment_with_details_atomic(uuid, uuid, integer, text, text, text, text, text, text, integer, integer, integer, text, jsonb, timestamptz, text, text, integer, integer, integer, text, text) to service_role;

-- Header, lines, draw ownership, approved-cost ownership and retainage are one
-- receivable write. The application still performs friendly preflight checks;
-- these transactions are the final concurrency boundary.
create or replace function public.create_invoice_atomic(
  p_org_id uuid,
  p_invoice jsonb,
  p_lines jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_invoice public.invoices%rowtype;
  v_line jsonb;
  v_line_id uuid;
  v_cost_id uuid;
  v_lines jsonb := '[]'::jsonb;
  v_claimed integer;
  v_draw_id uuid := nullif(p_invoice ->> 'source_draw_id', '')::uuid;
  v_retainage_cents integer := coalesce((p_invoice -> 'metadata' ->> 'retainage_amount_cents')::integer, 0);
  v_contract_id uuid := nullif(p_invoice -> 'metadata' ->> 'source_contract_id', '')::uuid;
begin
  if p_org_id is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Invoice requires an organization and at least one line';
  end if;
  if auth.uid() is not null and not public.is_org_member(p_org_id) then
    raise exception 'Not authorized for this organization';
  end if;
  if p_invoice ->> 'product_posture' = 'commercial'
    and coalesce((p_invoice ->> 'client_visible')::boolean, false)
    and p_invoice ->> 'approval_status' <> 'approved' then
    raise exception 'Commercial owner billing must be approved before issue';
  end if;

  insert into public.invoices (
    org_id, project_id, token, invoice_number, title, status, issue_date,
    due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents,
    balance_due_cents, source_type, source_draw_id, source_change_order_id,
    source_pay_application_id, metadata, sent_at, sent_to_emails,
    product_posture, approval_status, delivery_status, issued_snapshot
  ) values (
    p_org_id, nullif(p_invoice ->> 'project_id', '')::uuid,
    nullif(p_invoice ->> 'token', ''), p_invoice ->> 'invoice_number',
    p_invoice ->> 'title', coalesce(nullif(p_invoice ->> 'status', ''), 'saved'),
    nullif(p_invoice ->> 'issue_date', '')::date,
    nullif(p_invoice ->> 'due_date', '')::date, nullif(p_invoice ->> 'notes', ''),
    coalesce((p_invoice ->> 'client_visible')::boolean, false),
    coalesce((p_invoice ->> 'subtotal_cents')::integer, 0),
    coalesce((p_invoice ->> 'tax_cents')::integer, 0),
    coalesce((p_invoice ->> 'total_cents')::integer, 0),
    coalesce((p_invoice ->> 'balance_due_cents')::integer, 0),
    nullif(p_invoice ->> 'source_type', ''), v_draw_id,
    nullif(p_invoice ->> 'source_change_order_id', '')::uuid,
    nullif(p_invoice ->> 'source_pay_application_id', '')::uuid,
    coalesce(p_invoice -> 'metadata', '{}'::jsonb),
    nullif(p_invoice ->> 'sent_at', '')::timestamptz,
    case when jsonb_typeof(p_invoice -> 'sent_to_emails') = 'array'
      then array(select jsonb_array_elements_text(p_invoice -> 'sent_to_emails'))
      else null end,
    nullif(p_invoice ->> 'product_posture', ''),
    coalesce(nullif(p_invoice ->> 'approval_status', ''), 'not_required'),
    coalesce(nullif(p_invoice ->> 'delivery_status', ''), 'not_sent'),
    p_invoice -> 'issued_snapshot'
  ) returning * into v_invoice;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into public.invoice_lines (
      org_id, invoice_id, cost_code_id, description, quantity, unit,
      unit_price_cents, metadata
    ) values (
      p_org_id, v_invoice.id, nullif(v_line ->> 'cost_code_id', '')::uuid,
      coalesce(v_line ->> 'description', ''),
      coalesce((v_line ->> 'quantity')::numeric, 1), v_line ->> 'unit',
      coalesce((v_line ->> 'unit_price_cents')::integer, 0),
      coalesce(v_line -> 'metadata', '{}'::jsonb)
    ) returning id into v_line_id;

    if jsonb_typeof(v_line -> 'metadata' -> 'billable_cost_ids') = 'array' then
      for v_cost_id in
        select value::uuid from jsonb_array_elements_text(v_line -> 'metadata' -> 'billable_cost_ids')
      loop
        update public.billable_costs
        set invoice_id = v_invoice.id, invoice_line_id = v_line_id,
            status = 'billed', billed_at = now()
        where id = v_cost_id and org_id = p_org_id
          and invoice_id is null and status in ('open', 'locked');
        get diagnostics v_claimed = row_count;
        if v_claimed <> 1 then
          raise exception 'An approved cost was already claimed by another invoice';
        end if;
      end loop;
    end if;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('id', v_line_id, 'metadata', coalesce(v_line -> 'metadata', '{}'::jsonb))
    );
  end loop;

  if v_draw_id is not null then
    update public.draw_schedules
    set invoice_id = v_invoice.id,
        status = case when status in ('paid', 'partial') then status else 'invoiced' end,
        invoiced_at = coalesce(invoiced_at, now())
    where id = v_draw_id and org_id = p_org_id
      and (invoice_id is null or invoice_id = v_invoice.id);
    get diagnostics v_claimed = row_count;
    if v_claimed <> 1 then
      raise exception 'Selected draw is already linked to another invoice';
    end if;
  end if;

  if v_retainage_cents > 0 and v_contract_id is not null and v_invoice.project_id is not null then
    insert into public.retainage (
      org_id, project_id, contract_id, invoice_id, amount_cents, status
    ) values (
      p_org_id, v_invoice.project_id, v_contract_id, v_invoice.id,
      v_retainage_cents, 'held'
    );
  end if;

  return jsonb_build_object('invoice', to_jsonb(v_invoice), 'lines', v_lines);
end;
$$;

create or replace function public.update_invoice_atomic(
  p_org_id uuid,
  p_invoice_id uuid,
  p_invoice jsonb,
  p_lines jsonb,
  p_expected_updated_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_existing public.invoices%rowtype;
  v_invoice public.invoices%rowtype;
  v_line jsonb;
  v_line_id uuid;
  v_lines jsonb := '[]'::jsonb;
  v_old_draw_id uuid;
  v_new_draw_id uuid := nullif(p_invoice ->> 'source_draw_id', '')::uuid;
  v_claimed integer;
  v_retainage public.retainage%rowtype;
  v_retainage_cents integer := coalesce((p_invoice -> 'metadata' ->> 'retainage_amount_cents')::integer, 0);
  v_contract_id uuid := nullif(p_invoice -> 'metadata' ->> 'source_contract_id', '')::uuid;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Invoice requires at least one line';
  end if;
  if auth.uid() is not null and not public.is_org_member(p_org_id) then
    raise exception 'Not authorized for this organization';
  end if;

  select * into v_existing from public.invoices
  where id = p_invoice_id and org_id = p_org_id for update;
  if v_existing.id is null then raise exception 'Invoice not found'; end if;
  if v_existing.sent_at is not null or v_existing.client_visible
    or v_existing.status not in ('draft', 'saved') then
    raise exception 'Issued invoices are immutable; void and reissue instead';
  end if;
  if p_expected_updated_at is not null and v_existing.updated_at <> p_expected_updated_at then
    raise exception 'Invoice changed in another session; refresh before saving';
  end if;
  if p_invoice ->> 'product_posture' = 'commercial'
    and coalesce((p_invoice ->> 'client_visible')::boolean, false)
    and p_invoice ->> 'approval_status' <> 'approved' then
    raise exception 'Commercial owner billing must be approved before issue';
  end if;

  v_old_draw_id := v_existing.source_draw_id;
  if v_old_draw_id is distinct from v_new_draw_id and v_old_draw_id is not null then
    update public.draw_schedules
    set invoice_id = null, status = 'pending', invoiced_at = null
    where id = v_old_draw_id and org_id = p_org_id and invoice_id = p_invoice_id;
  end if;
  if v_new_draw_id is not null then
    update public.draw_schedules
    set invoice_id = p_invoice_id,
        status = case when status in ('paid', 'partial') then status else 'invoiced' end,
        invoiced_at = coalesce(invoiced_at, now())
    where id = v_new_draw_id and org_id = p_org_id
      and (invoice_id is null or invoice_id = p_invoice_id);
    get diagnostics v_claimed = row_count;
    if v_claimed <> 1 then
      raise exception 'Selected draw is already linked to another invoice';
    end if;
  end if;

  update public.invoices set
    project_id = nullif(p_invoice ->> 'project_id', '')::uuid,
    token = nullif(p_invoice ->> 'token', ''),
    invoice_number = p_invoice ->> 'invoice_number', title = p_invoice ->> 'title',
    status = coalesce(nullif(p_invoice ->> 'status', ''), 'saved'),
    issue_date = nullif(p_invoice ->> 'issue_date', '')::date,
    due_date = nullif(p_invoice ->> 'due_date', '')::date,
    notes = nullif(p_invoice ->> 'notes', ''),
    client_visible = coalesce((p_invoice ->> 'client_visible')::boolean, false),
    subtotal_cents = coalesce((p_invoice ->> 'subtotal_cents')::integer, 0),
    tax_cents = coalesce((p_invoice ->> 'tax_cents')::integer, 0),
    total_cents = coalesce((p_invoice ->> 'total_cents')::integer, 0),
    balance_due_cents = coalesce((p_invoice ->> 'balance_due_cents')::integer, 0),
    source_type = nullif(p_invoice ->> 'source_type', ''),
    source_draw_id = v_new_draw_id,
    source_change_order_id = nullif(p_invoice ->> 'source_change_order_id', '')::uuid,
    source_pay_application_id = nullif(p_invoice ->> 'source_pay_application_id', '')::uuid,
    metadata = coalesce(p_invoice -> 'metadata', '{}'::jsonb),
    sent_at = nullif(p_invoice ->> 'sent_at', '')::timestamptz,
    sent_to_emails = case when jsonb_typeof(p_invoice -> 'sent_to_emails') = 'array'
      then array(select jsonb_array_elements_text(p_invoice -> 'sent_to_emails'))
      else null end,
    product_posture = nullif(p_invoice ->> 'product_posture', ''),
    approval_status = coalesce(nullif(p_invoice ->> 'approval_status', ''), 'not_required'),
    delivery_status = coalesce(nullif(p_invoice ->> 'delivery_status', ''), 'not_sent'),
    issued_snapshot = p_invoice -> 'issued_snapshot'
  where id = p_invoice_id and org_id = p_org_id
  returning * into v_invoice;

  delete from public.invoice_lines where invoice_id = p_invoice_id and org_id = p_org_id;
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into public.invoice_lines (
      org_id, invoice_id, cost_code_id, description, quantity, unit,
      unit_price_cents, metadata
    ) values (
      p_org_id, p_invoice_id, nullif(v_line ->> 'cost_code_id', '')::uuid,
      coalesce(v_line ->> 'description', ''),
      coalesce((v_line ->> 'quantity')::numeric, 1), v_line ->> 'unit',
      coalesce((v_line ->> 'unit_price_cents')::integer, 0),
      coalesce(v_line -> 'metadata', '{}'::jsonb)
    ) returning id into v_line_id;
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('id', v_line_id, 'metadata', coalesce(v_line -> 'metadata', '{}'::jsonb))
    );
  end loop;

  select * into v_retainage from public.retainage
  where org_id = p_org_id and invoice_id = p_invoice_id for update;
  if v_retainage.id is not null and v_retainage.status = 'paid'
    and (v_retainage_cents <> v_retainage.amount_cents or v_retainage_cents = 0) then
    raise exception 'Paid retainage cannot be changed';
  elsif v_retainage_cents <= 0 or v_contract_id is null or v_invoice.project_id is null then
    delete from public.retainage
    where id = v_retainage.id and status <> 'paid';
  elsif v_retainage.id is not null then
    update public.retainage set
      project_id = v_invoice.project_id, contract_id = v_contract_id,
      amount_cents = v_retainage_cents, updated_at = now()
    where id = v_retainage.id;
  else
    insert into public.retainage (
      org_id, project_id, contract_id, invoice_id, amount_cents, status
    ) values (
      p_org_id, v_invoice.project_id, v_contract_id, p_invoice_id,
      v_retainage_cents, 'held'
    );
  end if;

  return jsonb_build_object('invoice', to_jsonb(v_invoice), 'lines', v_lines);
end;
$$;

revoke all on function public.create_invoice_atomic(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.update_invoice_atomic(uuid, uuid, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.create_invoice_atomic(uuid, jsonb, jsonb) to service_role;
grant execute on function public.update_invoice_atomic(uuid, uuid, jsonb, jsonb, timestamptz) to service_role;

-- C1 intentionally closed the chart subtype vocabulary. Fee recovery is a
-- distinct operating-income presentation, so extend that vocabulary before
-- seeding the system account for existing organizations.
alter table public.gl_accounts
  drop constraint if exists gl_accounts_subtype_check;
alter table public.gl_accounts
  add constraint gl_accounts_subtype_check check (subtype in (
    'cash', 'undeposited_funds', 'accounts_receivable', 'retainage_receivable',
    'costs_in_excess', 'work_in_progress', 'prepaid_expenses', 'fixed_assets',
    'accumulated_depreciation', 'other_asset', 'accounts_payable',
    'retainage_payable', 'credit_card', 'payroll_clearing', 'sales_use_tax',
    'customer_deposits', 'billings_in_excess', 'current_debt', 'long_term_debt',
    'other_liability', 'owner_equity', 'owner_contributions',
    'owner_distributions', 'retained_earnings', 'construction_revenue',
    'other_revenue', 'early_pay_discount', 'payment_fee_recovery', 'job_costs',
    'subcontractor_costs', 'material_costs', 'direct_labor', 'equipment_costs',
    'warranty_costs', 'rent', 'insurance', 'software', 'professional_fees',
    'utilities', 'bank_fees', 'interest', 'payroll', 'depreciation', 'other_expense'
  ));

insert into public.gl_accounts (
  org_id, code, name, account_type, subtype, normal_balance,
  cash_flow_category, is_system, active
)
select settings.org_id, '4920', 'Payment fee recovery', 'income',
  'payment_fee_recovery', 'credit', 'operating', true, true
from public.books_settings settings
on conflict (org_id, code) do nothing;

commit;
