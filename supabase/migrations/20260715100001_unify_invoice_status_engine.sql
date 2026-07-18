-- Unify the invoice payment→status engines.
--
-- Before this migration three implementations computed "how much of this invoice
-- is paid" from different inputs:
--   * TS recalcInvoiceBalanceAndStatus: payments + payment_allocations − reversals
--   * apply_invoice_payment_atomic:     payments only (no allocations, no reversals,
--                                       excluded 'refunded')
--   * record/resolve_payment_reversal_atomic: payments − reversals (no allocations)
-- An invoice paid via multi-invoice allocations could stay 'sent'/'partial' forever
-- depending on which write path last touched it.
--
-- One canonical pair now owns the math:
--   invoice_paid_cents(org, invoice)  → gross direct + allocated − reversed, floored at 0
--   derive_invoice_status(...)        → the single status CASE
-- plus recalc_invoice_balance_atomic(org, invoice) so app code can re-derive
-- balance/status in one locked transaction. The three payment RPCs are recreated
-- on top of these helpers with unchanged signatures.

create or replace function public.invoice_paid_cents(
  p_org_id uuid,
  p_invoice_id uuid
)
returns bigint
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
        and status in ('processing', 'succeeded', 'completed', 'refunded')
    ), 0)
    + coalesce((
      select sum(pa.amount_cents)
      from public.payment_allocations pa
      join public.payments p
        on p.id = pa.payment_id
       and p.org_id = pa.org_id
      where pa.org_id = p_org_id
        and pa.invoice_id = p_invoice_id
        and p.status in ('processing', 'succeeded', 'completed', 'refunded')
    ), 0)
    - coalesce((
      select sum(amount_cents)
      from public.payment_reversals
      where org_id = p_org_id
        and invoice_id = p_invoice_id
        and status in ('pending', 'succeeded')
    ), 0)
  , 0);
$$;

grant execute on function public.invoice_paid_cents(uuid, uuid) to service_role;

create or replace function public.derive_invoice_status(
  p_current_status text,
  p_total_cents integer,
  p_paid_cents bigint,
  p_due_date date,
  p_client_visible boolean,
  p_sent_at timestamptz
)
returns text
language sql
immutable
as $$
  select case
    when p_current_status = 'void' then 'void'
    when greatest(coalesce(p_total_cents, 0) - p_paid_cents, 0) = 0
         and coalesce(p_total_cents, 0) > 0 then 'paid'
    when p_paid_cents > 0 then 'partial'
    when p_sent_at is null
         and not coalesce(p_client_visible, false)
         and coalesce(p_current_status, 'sent') not in ('sent', 'partial', 'paid', 'overdue')
      then case when p_current_status = 'draft' then 'draft' else 'saved' end
    when p_due_date is not null and p_due_date < current_date then 'overdue'
    else 'sent'
  end;
$$;

create or replace function public.recalc_invoice_balance_atomic(
  p_org_id uuid,
  p_invoice_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
  v_paid_cents bigint;
  v_balance integer;
  v_status text;
begin
  select *
    into v_invoice
    from public.invoices
    where id = p_invoice_id
      and org_id = p_org_id
    for update;

  if v_invoice.id is null then
    raise exception 'Invoice not found or inaccessible';
  end if;

  v_paid_cents := public.invoice_paid_cents(p_org_id, p_invoice_id);

  if v_invoice.status = 'void' then
    update public.invoices
       set balance_due_cents = 0
     where id = p_invoice_id
       and org_id = p_org_id;
    return jsonb_build_object(
      'balance_due_cents', 0,
      'status', 'void',
      'paid_cents', v_paid_cents
    );
  end if;

  v_balance := greatest(coalesce(v_invoice.total_cents, 0) - v_paid_cents, 0);
  v_status := public.derive_invoice_status(
    v_invoice.status, v_invoice.total_cents, v_paid_cents,
    v_invoice.due_date, v_invoice.client_visible, v_invoice.sent_at
  );

  update public.invoices
     set balance_due_cents = v_balance,
         status = v_status
   where id = p_invoice_id
     and org_id = p_org_id;

  return jsonb_build_object(
    'balance_due_cents', v_balance,
    'status', v_status,
    'paid_cents', v_paid_cents
  );
end;
$$;

-- Called from user-context clients (invoice edits) as well as service jobs. It only
-- re-derives an invoice's own balance/status from its payments, so the definer write
-- is safe to expose to authenticated.
grant execute on function public.recalc_invoice_balance_atomic(uuid, uuid) to authenticated, service_role;

-- Recreate apply_invoice_payment_atomic on the shared helpers (signature unchanged).
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
  v_balance_cents integer;
  v_next_status text;
begin
  if p_amount_cents <= 0 then
    raise exception 'Payment amount must be positive';
  end if;

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

  if p_status in ('processing', 'succeeded', 'completed')
    and p_amount_cents > greatest(coalesce(v_invoice.total_cents, 0) - v_paid_cents, 0) then
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

-- Recreate record_payment_reversal_atomic on the shared helpers (signature unchanged).
create or replace function public.record_payment_reversal_atomic(
  p_org_id uuid,
  p_payment_id uuid,
  p_amount_cents integer,
  p_reversal_type text,
  p_provider_reversal_id text,
  p_reason text,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
  v_invoice public.invoices%rowtype;
  v_existing public.payment_reversals%rowtype;
  v_reversal public.payment_reversals%rowtype;
  v_reversed_for_payment bigint;
  v_net_paid bigint;
  v_balance integer;
  v_status text;
begin
  if p_amount_cents <= 0 then
    raise exception 'Reversal amount must be positive';
  end if;
  if p_reversal_type not in ('refund', 'ach_return', 'chargeback', 'dispute', 'correction') then
    raise exception 'Unsupported payment reversal type';
  end if;

  if p_provider_reversal_id is not null then
    select *
      into v_existing
      from public.payment_reversals
      where org_id = p_org_id
        and provider_reversal_id = p_provider_reversal_id
      limit 1;
    if v_existing.id is not null then
      return to_jsonb(v_existing);
    end if;
  end if;

  select *
    into v_payment
    from public.payments
    where id = p_payment_id
      and org_id = p_org_id
    for update;
  if v_payment.id is null or v_payment.invoice_id is null then
    raise exception 'Invoice payment not found';
  end if;

  select *
    into v_invoice
    from public.invoices
    where id = v_payment.invoice_id
      and org_id = p_org_id
    for update;
  if v_invoice.id is null then
    raise exception 'Invoice not found';
  end if;

  select coalesce(sum(amount_cents), 0)
    into v_reversed_for_payment
    from public.payment_reversals
    where org_id = p_org_id
      and payment_id = p_payment_id
      and status in ('pending', 'succeeded');

  if v_reversed_for_payment + p_amount_cents > v_payment.amount_cents then
    raise exception 'Reversal exceeds the original payment amount';
  end if;

  insert into public.payment_reversals (
    org_id, project_id, invoice_id, payment_id, amount_cents,
    reversal_type, status, provider_reversal_id, reason, metadata
  )
  values (
    p_org_id, v_payment.project_id, v_payment.invoice_id, v_payment.id, p_amount_cents,
    p_reversal_type, 'succeeded', p_provider_reversal_id, p_reason, coalesce(p_metadata, '{}'::jsonb)
  )
  returning * into v_reversal;

  if v_reversed_for_payment + p_amount_cents = v_payment.amount_cents then
    update public.payments
       set status = 'refunded'
     where id = v_payment.id
       and org_id = p_org_id;
  end if;

  v_net_paid := public.invoice_paid_cents(p_org_id, v_invoice.id);
  v_balance := greatest(coalesce(v_invoice.total_cents, 0) - v_net_paid, 0);
  v_status := public.derive_invoice_status(
    v_invoice.status, v_invoice.total_cents, v_net_paid,
    v_invoice.due_date, v_invoice.client_visible, v_invoice.sent_at
  );

  update public.invoices
     set balance_due_cents = v_balance,
         status = v_status
   where id = v_invoice.id
     and org_id = p_org_id;

  return to_jsonb(v_reversal) || jsonb_build_object(
    'invoice_balance_due_cents', v_balance,
    'invoice_status', v_status
  );
end;
$$;

-- Recreate resolve_payment_reversal_atomic on the shared helpers (signature unchanged).
create or replace function public.resolve_payment_reversal_atomic(
  p_org_id uuid,
  p_provider_reversal_id text,
  p_outcome text,
  p_reason text,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reversal public.payment_reversals%rowtype;
  v_payment public.payments%rowtype;
  v_invoice public.invoices%rowtype;
  v_net_paid bigint;
  v_balance integer;
  v_status text;
begin
  if p_outcome not in ('succeeded', 'reversed') then
    raise exception 'Unsupported reversal outcome';
  end if;

  select *
    into v_reversal
    from public.payment_reversals
    where org_id = p_org_id
      and provider_reversal_id = p_provider_reversal_id
    for update;
  if v_reversal.id is null then
    raise exception 'Payment reversal not found';
  end if;

  update public.payment_reversals
     set status = p_outcome,
         reason = coalesce(p_reason, reason),
         metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb)
   where id = v_reversal.id
  returning * into v_reversal;

  select *
    into v_payment
    from public.payments
    where id = v_reversal.payment_id
      and org_id = p_org_id
    for update;

  select *
    into v_invoice
    from public.invoices
    where id = v_reversal.invoice_id
      and org_id = p_org_id
    for update;

  if p_outcome = 'reversed' and v_payment.status = 'refunded' then
    update public.payments
       set status = 'succeeded'
     where id = v_payment.id
       and org_id = p_org_id;
  end if;

  v_net_paid := public.invoice_paid_cents(p_org_id, v_invoice.id);
  v_balance := greatest(coalesce(v_invoice.total_cents, 0) - v_net_paid, 0);
  v_status := public.derive_invoice_status(
    v_invoice.status, v_invoice.total_cents, v_net_paid,
    v_invoice.due_date, v_invoice.client_visible, v_invoice.sent_at
  );

  update public.invoices
     set balance_due_cents = v_balance,
         status = v_status
   where id = v_invoice.id
     and org_id = p_org_id;

  return to_jsonb(v_reversal) || jsonb_build_object(
    'invoice_balance_due_cents', v_balance,
    'invoice_status', v_status
  );
end;
$$;
