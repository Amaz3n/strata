-- The UI records money already returned outside Arc; it never sends a refund.
-- All callers authorize payment.release before invoking this service-only command.
create or replace function public.record_manual_customer_refund_atomic(
  p_org_id uuid,
  p_payment_id uuid,
  p_amount_cents integer,
  p_reason text,
  p_idempotency_key text,
  p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  source_payment public.payments%rowtype;
  existing public.payment_reversals%rowtype;
  applied_cents bigint;
  reversed_cents bigint;
  result jsonb;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'Refund amount must be positive'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A refund reason is required'; end if;
  if nullif(trim(p_idempotency_key), '') is null then raise exception 'A refund reference is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':manual-refund:' || p_idempotency_key, 0));
  select * into existing from public.payment_reversals
    where org_id = p_org_id and provider_reversal_id = 'manual-refund:' || p_idempotency_key;
  if found then
    if existing.payment_id <> p_payment_id or existing.amount_cents <> p_amount_cents or existing.reason is distinct from trim(p_reason) then
      raise exception 'This refund reference was already used for different details';
    end if;
    return to_jsonb(existing) || jsonb_build_object('duplicate', true);
  end if;

  -- Deposit applications also lock this payment. Applying and refunding cannot
  -- both spend the same available deposit, even when submitted concurrently.
  select * into source_payment from public.payments
    where org_id = p_org_id and id = p_payment_id for update;
  if not found or source_payment.invoice_id is null then raise exception 'Invoice payment not found'; end if;
  if source_payment.provider is distinct from 'manual' or source_payment.status not in ('succeeded', 'completed', 'paid')
    or coalesce(source_payment.metadata ->> 'customer_deposit_application', 'false') = 'true' then
    raise exception 'Only received manual payments can be refunded here';
  end if;
  select coalesce(sum(amount_cents), 0) into applied_cents from public.payments
    where org_id = p_org_id and metadata ->> 'deposit_payment_id' = p_payment_id::text
      and status in ('succeeded', 'completed', 'paid', 'refunded');
  select coalesce(sum(amount_cents), 0) into reversed_cents from public.payment_reversals
    where org_id = p_org_id and payment_id = p_payment_id and status in ('pending', 'succeeded');
  if applied_cents + reversed_cents + p_amount_cents > source_payment.amount_cents then
    raise exception 'Refund exceeds the payment amount still available';
  end if;

  result := public.record_payment_reversal_atomic(p_org_id, p_payment_id, p_amount_cents, 'refund',
    'manual-refund:' || p_idempotency_key, trim(p_reason),
    jsonb_build_object('source', 'manual_customer_refund', 'recorded_by', p_actor_id));
  update public.accounting_sync_records set status = 'needs_review',
    error_message = 'A refund was recorded in Arc. Record the matching refund in your accounting provider.'
    where org_id = p_org_id and nullif(external_id, '') is not null
      and ((entity_type = 'invoice' and entity_id = source_payment.invoice_id)
        or (entity_type = 'payment' and entity_id = source_payment.id));
  return result || jsonb_build_object('duplicate', false);
end;
$$;
revoke all on function public.record_manual_customer_refund_atomic(uuid, uuid, integer, text, text, uuid) from public, anon, authenticated;
grant execute on function public.record_manual_customer_refund_atomic(uuid, uuid, integer, text, text, uuid) to service_role;
