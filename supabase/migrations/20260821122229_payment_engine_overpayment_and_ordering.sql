-- Payment engine hardening:
--
-- 1. The overpayment guard in apply_invoice_payment_atomic only counted SETTLED
--    money (invoice_paid_cents excludes 'processing' since 20260812160000), so N
--    sequential full-balance ACH payments in 'processing' each passed the guard
--    and settled to N × total. In-flight pending/processing amounts now count
--    against the outstanding balance for guard purposes.
-- 2. apply_invoice_payment_with_details_atomic no longer demotes a settled
--    payment when a late/retried 'processing' webhook replays after 'succeeded'
--    (which flipped a paid invoice back to sent/partial on recalc).

-- In-flight (not yet settled) payment cents against an invoice. Mirrors the
-- shape of invoice_paid_cents; used only by the overpayment guard.
create or replace function public.invoice_pending_payment_cents(
  p_org_id uuid,
  p_invoice_id uuid
) returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
      select sum(amount_cents)
      from public.payments
      where org_id = p_org_id
        and invoice_id = p_invoice_id
        and status in ('pending', 'processing')
    ), 0)
    + coalesce((
      select sum(pa.amount_cents)
      from public.payment_allocations pa
      join public.payments p on p.id = pa.payment_id and p.org_id = pa.org_id
      where pa.org_id = p_org_id
        and pa.invoice_id = p_invoice_id
        and p.status in ('pending', 'processing')
    ), 0);
$$;

revoke all on function public.invoice_pending_payment_cents(uuid, uuid) from public, anon, authenticated;
grant execute on function public.invoice_pending_payment_cents(uuid, uuid) to service_role;

create or replace function public.apply_invoice_payment_atomic(
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
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
  v_existing public.payments%rowtype;
  v_payment public.payments%rowtype;
  v_paid_cents bigint;
  v_pending_cents bigint;
  v_balance_cents integer;
  v_next_status text;
begin
  if p_amount_cents <= 0 then
    raise exception 'Payment amount must be positive';
  end if;

  -- Deliberately mirrors the payments_status_check table constraint exactly.
  -- 'paid' is NOT a storable payment status: invoice_paid_cents and the
  -- settled-set comparisons below tolerate it defensively, but accepting it
  -- here would only trade a clear error for a constraint violation.
  if p_status not in ('pending', 'processing', 'succeeded', 'completed', 'failed', 'canceled', 'refunded') then
    raise exception 'Unsupported payment status';
  end if;

  if p_idempotency_key is not null then
    select *
      into v_existing
      from public.payments
      where org_id = p_org_id
        and idempotency_key = p_idempotency_key
      limit 1;
    if v_existing.id is not null then
      return to_jsonb(v_existing);
    end if;
  end if;

  if p_provider_payment_id is not null then
    select *
      into v_existing
      from public.payments
      where org_id = p_org_id
        and coalesce(provider, '') = coalesce(p_provider, '')
        and provider_payment_id = p_provider_payment_id
      limit 1;
    if v_existing.id is not null then
      return to_jsonb(v_existing);
    end if;
  end if;

  select *
    into v_invoice
    from public.invoices
    where id = p_invoice_id
      and org_id = p_org_id
    for update;

  if v_invoice.id is null then
    raise exception 'Invoice not found or inaccessible';
  end if;
  if v_invoice.status = 'void' then
    raise exception 'Cannot apply payment to a void invoice';
  end if;

  v_paid_cents := public.invoice_paid_cents(p_org_id, p_invoice_id);
  v_pending_cents := public.invoice_pending_payment_cents(p_org_id, p_invoice_id);

  -- Guard against covering the same balance twice: money already settled AND
  -- money still in flight both consume the outstanding balance.
  if p_status in ('pending', 'processing', 'succeeded', 'completed')
    and p_amount_cents > greatest(coalesce(v_invoice.total_cents, 0) - v_paid_cents - v_pending_cents, 0) then
    raise exception 'Payment exceeds the outstanding invoice balance';
  end if;

  insert into public.payments (
    org_id,
    project_id,
    invoice_id,
    amount_cents,
    gross_cents,
    currency,
    method,
    provider,
    provider_payment_id,
    status,
    reference,
    fee_cents,
    net_cents,
    idempotency_key,
    metadata
  )
  values (
    p_org_id,
    v_invoice.project_id,
    p_invoice_id,
    p_amount_cents,
    coalesce(p_gross_cents, p_amount_cents),
    coalesce(nullif(p_currency, ''), 'usd'),
    p_method,
    p_provider,
    p_provider_payment_id,
    p_status,
    p_reference,
    coalesce(p_fee_cents, 0),
    coalesce(p_net_cents, coalesce(p_gross_cents, p_amount_cents) - coalesce(p_fee_cents, 0)),
    p_idempotency_key,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning * into v_payment;

  v_paid_cents := public.invoice_paid_cents(p_org_id, p_invoice_id);
  v_balance_cents := greatest(coalesce(v_invoice.total_cents, 0) - v_paid_cents, 0);
  v_next_status := public.derive_invoice_status(
    v_invoice.status, v_invoice.total_cents, v_paid_cents,
    v_invoice.due_date, v_invoice.client_visible, v_invoice.sent_at
  );

  update public.invoices
     set balance_due_cents = v_balance_cents,
         status = v_next_status
   where id = p_invoice_id
     and org_id = p_org_id;

  return to_jsonb(v_payment) || jsonb_build_object(
    'invoice_balance_due_cents', v_balance_cents,
    'invoice_status', v_next_status
  );
end;
$$;

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

  -- Out-of-order webhooks: a settled payment never regresses to an in-flight
  -- status when a retried 'processing' event replays after 'succeeded'.
  update public.payments
  set status = case
        when status in ('succeeded', 'completed', 'paid', 'refunded')
          and p_status in ('pending', 'processing')
        then status
        else p_status
      end,
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
    if payment_row.status in ('succeeded', 'completed', 'paid', 'refunded') then
      update public.invoice_payment_reservations
      set status = 'consumed', updated_at = now()
      where id = reservation_id and status in ('active', 'consumed');
    elsif payment_row.status = 'processing' then
      update public.invoice_payment_reservations
      set expires_at = greatest(expires_at, now() + interval '7 days'), updated_at = now()
      where id = reservation_id and status = 'active';
    elsif payment_row.status in ('failed', 'canceled') then
      update public.invoice_payment_reservations
      set status = 'canceled', updated_at = now()
      where id = reservation_id and status = 'active';
    end if;
  end if;

  return to_jsonb(payment_row) || (payment_result - 'id');
end;
$$;
