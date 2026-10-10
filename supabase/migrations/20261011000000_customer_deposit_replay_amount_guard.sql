-- Replaying a deposit application (same deposit, same target invoice) must
-- repeat the original amount. apply_invoice_payment_with_details_atomic keys the
-- application on (deposit, invoice) and returns the first one, so a retry with a
-- different amount used to succeed silently while recording the original amount.
-- Redefines the function from 20260812120755_books_release_hardening.sql; the
-- only change is the prior-application check and skipping the balance test for
-- an exact replay.
create or replace function public.apply_customer_deposit_atomic(
  p_org_id uuid,
  p_deposit_payment_id uuid,
  p_target_invoice_id uuid,
  p_amount_cents integer,
  p_actor_id uuid,
  p_received_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  deposit_payment public.payments%rowtype;
  deposit_invoice public.invoices%rowtype;
  target_invoice public.invoices%rowtype;
  refunded_cents bigint;
  applied_cents bigint;
  prior_cents bigint;
  result jsonb;
begin
  if p_amount_cents <= 0 then raise exception 'Deposit application must be positive'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':deposit:' || p_deposit_payment_id::text, 0));
  select * into deposit_payment from public.payments
  where id = p_deposit_payment_id and org_id = p_org_id
  for update;
  if not found or deposit_payment.status not in ('succeeded', 'completed') or deposit_payment.invoice_id is null then
    raise exception 'The source payment is not an available customer deposit';
  end if;

  select * into deposit_invoice from public.invoices
  where id = deposit_payment.invoice_id and org_id = p_org_id;
  if not found or coalesce(deposit_invoice.metadata ->> 'invoice_kind', '') <> 'earnest_deposit' then
    raise exception 'The source payment is not tied to an earnest-deposit invoice';
  end if;
  if p_target_invoice_id = deposit_invoice.id then
    raise exception 'A deposit cannot be applied to its own collection request';
  end if;
  select * into target_invoice from public.invoices
  where id = p_target_invoice_id and org_id = p_org_id for update;
  if not found or target_invoice.status not in ('sent','partial','overdue') then
    raise exception 'The target invoice is not open for payment';
  end if;
  if nullif(deposit_invoice.metadata ->> 'customer_id', '') is not null
    and nullif(target_invoice.metadata ->> 'customer_id', '')
      is distinct from nullif(deposit_invoice.metadata ->> 'customer_id', '') then
    raise exception 'A customer deposit can only be applied to that customer''s invoice';
  end if;
  if deposit_invoice.project_id is not null and target_invoice.project_id is distinct from deposit_invoice.project_id then
    raise exception 'A project deposit can only be applied within that project';
  end if;

  select sum(amount_cents) into prior_cents
  from public.payments
  where org_id = p_org_id
    and invoice_id = p_target_invoice_id
    and status in ('succeeded', 'completed')
    and metadata ->> 'deposit_payment_id' = p_deposit_payment_id::text;
  if prior_cents is not null and prior_cents <> p_amount_cents then
    raise exception 'This deposit was already applied to the invoice for a different amount';
  end if;

  if prior_cents is null then
    select coalesce(sum(amount_cents), 0) into refunded_cents
    from public.payment_reversals
    where org_id = p_org_id and payment_id = p_deposit_payment_id and status = 'succeeded';
    select coalesce(sum(amount_cents), 0) into applied_cents
    from public.payments
    where org_id = p_org_id
      and status in ('succeeded', 'completed')
      and metadata ->> 'deposit_payment_id' = p_deposit_payment_id::text;
    if applied_cents + refunded_cents + p_amount_cents > deposit_payment.amount_cents then
      raise exception 'Deposit application exceeds the unapplied deposit balance';
    end if;
  end if;

  result := public.apply_invoice_payment_with_details_atomic(
    p_org_id, p_target_invoice_id, p_amount_cents, deposit_payment.currency,
    'credit', 'arc_books', 'deposit:' || p_deposit_payment_id::text || ':' || p_target_invoice_id::text,
    'succeeded', 'Customer deposit application', 0, p_amount_cents, p_amount_cents,
    'deposit:' || p_deposit_payment_id::text || ':' || p_target_invoice_id::text,
    jsonb_build_object(
      'customer_deposit_application', true,
      'deposit_payment_id', p_deposit_payment_id,
      'deposit_invoice_id', deposit_payment.invoice_id,
      'applied_by', p_actor_id
    ), p_received_at, null, null, 0, 0, 0, null, null
  );
  return result;
end;
$$;
