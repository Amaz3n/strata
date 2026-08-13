-- Close the side doors into AP money state. Manual payments and vendor credits
-- now lock and roll up the payable in the same transaction as the payment row;
-- draft approval is rejected in both single and bulk paths; and paid_cents is a
-- required projection rather than something read paths guess from status.

begin;

-- Never manufacture historical money from a mutable status label. A `paid`
-- payable without enough settled payment evidence needs a human data repair;
-- guessing the balance here would make the migration itself a second source of
-- truth for cash.
do $$
declare
  v_unproven_ids text;
begin
  select string_agg(bill.id::text, ', ' order by bill.id)
  into v_unproven_ids
  from public.vendor_bills bill
  where bill.paid_cents is null
    and bill.status = 'paid'
    and coalesce((
      select sum(payment.amount_cents)
      from public.payments payment
      where payment.org_id = bill.org_id
        and payment.bill_id = bill.id
        and payment.status in ('succeeded', 'completed')
    ), 0) < greatest(coalesce(bill.total_cents, 0) - greatest(coalesce(bill.retainage_cents, 0), 0), 0);

  if v_unproven_ids is not null then
    raise exception 'Paid payables lack settled payment evidence; repair before applying migration: %', v_unproven_ids;
  end if;
end;
$$;

update public.vendor_bills bill
set paid_cents = coalesce((
  select sum(payment.amount_cents)
  from public.payments payment
  where payment.org_id = bill.org_id
    and payment.bill_id = bill.id
    and payment.status in ('succeeded', 'completed')
), 0)
where bill.paid_cents is null;

alter table public.vendor_bills
  alter column paid_cents set default 0,
  alter column paid_cents set not null;

-- Authentication belongs to external_identities. This compatibility column is
-- made nullable before application writers stop copying a stale password hash;
-- its eventual drop remains in pending-migrations for explicit approval.
alter table public.vendor_portal_identities
  alter column password_hash drop not null;

create or replace function public.record_manual_ap_payment_atomic(
  p_org_id uuid,
  p_bill_id uuid,
  p_actor_id uuid,
  p_amount_cents bigint,
  p_currency text,
  p_method text,
  p_reference text,
  p_check_number text,
  p_received_at timestamptz,
  p_release_evidence jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill public.vendor_bills%rowtype;
  v_payment public.payments%rowtype;
  v_existing public.payments%rowtype;
  v_payable_due bigint;
  v_next_paid bigint;
  v_next_status text;
begin
  if p_amount_cents <= 0 then raise exception 'Payment amount must be positive'; end if;
  if nullif(btrim(p_idempotency_key), '') is null then raise exception 'Payment idempotency key is required'; end if;

  select * into v_existing
  from public.payments
  where org_id = p_org_id and idempotency_key = p_idempotency_key
  limit 1;
  if v_existing.id is not null then
    if v_existing.bill_id is distinct from p_bill_id or v_existing.amount_cents is distinct from p_amount_cents then
      raise exception 'Payment idempotency key was used for different contents';
    end if;
    return jsonb_build_object(
      'payment_id', v_existing.id,
      'bill_id', v_existing.bill_id,
      'duplicate', true
    );
  end if;

  select * into v_bill
  from public.vendor_bills
  where id = p_bill_id and org_id = p_org_id
  for update;
  if v_bill.id is null then raise exception 'Vendor bill not found'; end if;
  if coalesce(v_bill.metadata->>'source', '') = 'vendor_credit' then
    raise exception 'Payments cannot be recorded against a vendor credit';
  end if;
  if v_bill.status not in ('approved', 'partial') then
    raise exception 'Vendor bill is not approved for payment';
  end if;
  if lower(coalesce(p_currency, '')) <> lower(coalesce(v_bill.currency, 'usd')) then
    raise exception 'Payment currency must match the vendor bill';
  end if;
  if coalesce(v_bill.metadata->>'creation_state', 'ready') = 'draft' then
    raise exception 'Complete the payable draft before recording payment';
  end if;
  if exists (
    select 1 from public.payment_run_items item
    where item.org_id = p_org_id and item.bill_id = p_bill_id
      and item.status in ('draft','pending_approval','approved','processing','partially_paid')
  ) then
    raise exception 'This payable already belongs to an active payment run';
  end if;

  v_payable_due := greatest(coalesce(v_bill.total_cents, 0) - greatest(coalesce(v_bill.retainage_cents, 0), 0), 0);
  v_next_paid := coalesce(v_bill.paid_cents, 0) + p_amount_cents;
  if v_next_paid > v_payable_due then raise exception 'Payment exceeds vendor bill balance'; end if;
  v_next_status := case when v_next_paid >= v_payable_due then 'paid' else 'partial' end;

  insert into public.payments (
    org_id, project_id, bill_id, amount_cents, currency, method, reference,
    check_number, release_evidence, received_at, status, provider, net_cents,
    idempotency_key, metadata
  ) values (
    p_org_id, v_bill.project_id, v_bill.id, p_amount_cents, lower(coalesce(p_currency, v_bill.currency, 'usd')),
    coalesce(nullif(btrim(p_method), ''), 'check'), nullif(btrim(p_reference), ''),
    nullif(btrim(p_check_number), ''), p_release_evidence, coalesce(p_received_at, now()),
    'succeeded', 'manual', p_amount_cents, p_idempotency_key,
    jsonb_build_object('recorded_by', p_actor_id)
  ) returning * into v_payment;

  update public.vendor_bills
  set paid_cents = v_next_paid,
      status = v_next_status,
      paid_at = case when v_next_status = 'paid' then coalesce(p_received_at, now()) else paid_at end,
      payment_method = v_payment.method,
      payment_reference = v_payment.reference
  where id = v_bill.id and org_id = p_org_id;

  insert into public.audit_log (
    org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source
  ) values (
    p_org_id, p_actor_id, 'update', 'vendor_bill', v_bill.id,
    jsonb_build_object('status', v_bill.status, 'paid_cents', v_bill.paid_cents),
    jsonb_build_object('status', v_next_status, 'paid_cents', v_next_paid, 'payment_id', v_payment.id),
    'manual_ap_payment'
  );

  return jsonb_build_object(
    'payment_id', v_payment.id,
    'bill_id', v_bill.id,
    'bill_status', v_next_status,
    'paid_cents', v_next_paid,
    'duplicate', false
  );
end;
$$;

revoke all on function public.record_manual_ap_payment_atomic(uuid,uuid,uuid,bigint,text,text,text,text,timestamptz,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.record_manual_ap_payment_atomic(uuid,uuid,uuid,bigint,text,text,text,text,timestamptz,jsonb,text)
  to service_role;

create or replace function public.apply_vendor_credit_atomic(
  p_org_id uuid,
  p_credit_bill_id uuid,
  p_bill_id uuid,
  p_actor_id uuid,
  p_amount_cents bigint,
  p_idempotency_key text,
  p_release_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_credit public.vendor_bills%rowtype;
  v_bill public.vendor_bills%rowtype;
  v_payment public.payments%rowtype;
  v_existing public.payments%rowtype;
  v_already_applied bigint;
  v_payable_due bigint;
  v_next_paid bigint;
  v_next_status text;
  v_warranty_backcharge_id uuid;
  v_backcharge_amount bigint;
begin
  if p_credit_bill_id = p_bill_id then raise exception 'A vendor credit cannot be applied to itself'; end if;
  if p_amount_cents <= 0 then raise exception 'Credit amount must be positive'; end if;
  if nullif(btrim(p_idempotency_key), '') is null then raise exception 'Credit idempotency key is required'; end if;

  select * into v_existing from public.payments
  where org_id = p_org_id and idempotency_key = p_idempotency_key limit 1;
  if v_existing.id is not null then
    if v_existing.bill_id is distinct from p_bill_id or v_existing.amount_cents is distinct from p_amount_cents then
      raise exception 'Credit idempotency key was used for different contents';
    end if;
    return jsonb_build_object('payment_id', v_existing.id, 'applied_cents', v_existing.amount_cents, 'duplicate', true);
  end if;

  -- Stable lock ordering avoids deadlocks when two credits are applied at once.
  perform id from public.vendor_bills
  where org_id = p_org_id and id in (p_credit_bill_id, p_bill_id)
  order by id for update;

  select * into v_credit from public.vendor_bills
  where org_id = p_org_id and id = p_credit_bill_id;
  select * into v_bill from public.vendor_bills
  where org_id = p_org_id and id = p_bill_id;
  if v_credit.id is null or coalesce(v_credit.metadata->>'source', '') <> 'vendor_credit' then
    raise exception 'Vendor credit not found';
  end if;
  if v_credit.status <> 'approved' or v_credit.approved_by is null then
    raise exception 'Vendor credit must be approved before it can be applied';
  end if;
  if v_bill.id is null or coalesce(v_bill.metadata->>'source', '') = 'vendor_credit' then
    raise exception 'Target bill not found';
  end if;
  if v_credit.company_id is distinct from v_bill.company_id then
    raise exception 'A vendor credit can only be applied to the same vendor';
  end if;
  if lower(coalesce(v_credit.currency, 'usd')) <> lower(coalesce(v_bill.currency, 'usd')) then
    raise exception 'A vendor credit can only be applied in the target bill currency';
  end if;
  if v_bill.status not in ('approved', 'partial') then
    raise exception 'Target bill must be approved before applying credit';
  end if;
  if coalesce(v_bill.metadata->>'creation_state', 'ready') = 'draft' then
    raise exception 'Complete the payable draft before applying credit';
  end if;
  if exists (
    select 1 from public.payment_run_items item
    where item.org_id = p_org_id and item.bill_id = p_bill_id
      and item.status in ('draft','pending_approval','approved','processing','partially_paid')
  ) then
    raise exception 'This payable already belongs to an active payment run';
  end if;

  select coalesce(sum(payment.amount_cents), 0) into v_already_applied
  from public.payments payment
  where payment.org_id = p_org_id
    and payment.metadata->>'vendor_credit_id' = p_credit_bill_id::text
    and payment.metadata->>'vendor_credit_applied' = 'true'
    and payment.status not in ('canceled', 'refunded');
  if v_already_applied + p_amount_cents > abs(coalesce(v_credit.total_cents, 0)) then
    raise exception 'Credit application exceeds the remaining vendor credit';
  end if;

  v_payable_due := greatest(coalesce(v_bill.total_cents, 0) - greatest(coalesce(v_bill.retainage_cents, 0), 0), 0);
  v_next_paid := coalesce(v_bill.paid_cents, 0) + p_amount_cents;
  if v_next_paid > v_payable_due then raise exception 'Credit application exceeds the bill balance'; end if;
  v_next_status := case when v_next_paid >= v_payable_due then 'paid' else 'partial' end;

  insert into public.payments (
    org_id, project_id, bill_id, amount_cents, currency, method, reference,
    received_at, status, provider, net_cents, idempotency_key, release_evidence, metadata
  ) values (
    p_org_id, v_bill.project_id, v_bill.id, p_amount_cents, lower(coalesce(v_bill.currency, 'usd')),
    'credit', 'Vendor credit ' || p_credit_bill_id::text, now(), 'succeeded', 'manual',
    p_amount_cents, p_idempotency_key, p_release_evidence,
    jsonb_build_object(
      'vendor_credit_applied', true,
      'vendor_credit_id', p_credit_bill_id,
      'recorded_by', p_actor_id
    )
  ) returning * into v_payment;

  update public.vendor_bills
  set paid_cents = v_next_paid,
      status = v_next_status,
      paid_at = case when v_next_status = 'paid' then coalesce(paid_at, now()) else paid_at end,
      payment_method = 'credit',
      payment_reference = v_payment.reference
  where org_id = p_org_id and id = v_bill.id;

  begin
    v_warranty_backcharge_id := nullif(v_credit.metadata->>'warranty_backcharge_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'Vendor credit has an invalid warranty backcharge reference';
  end;
  if v_warranty_backcharge_id is not null then
    select amount_cents into v_backcharge_amount
    from public.warranty_backcharges
    where org_id = p_org_id and id = v_warranty_backcharge_id and status in ('issued', 'recovered')
    for update;
    if v_backcharge_amount is null then raise exception 'Warranty backcharge is not recoverable'; end if;
    update public.warranty_backcharges
    set recovered_cents = v_already_applied + p_amount_cents,
        status = case when v_already_applied + p_amount_cents >= v_backcharge_amount then 'recovered' else 'issued' end,
        resolved_at = case when v_already_applied + p_amount_cents >= v_backcharge_amount then now() else null end
    where org_id = p_org_id and id = v_warranty_backcharge_id;
  end if;

  insert into public.audit_log (
    org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source
  ) values (
    p_org_id, p_actor_id, 'update', 'vendor_bill', v_bill.id,
    jsonb_build_object('status', v_bill.status, 'paid_cents', v_bill.paid_cents),
    jsonb_build_object('status', v_next_status, 'paid_cents', v_next_paid, 'payment_id', v_payment.id, 'vendor_credit_id', p_credit_bill_id),
    'vendor_credit_application'
  );

  return jsonb_build_object(
    'payment_id', v_payment.id,
    'bill_id', v_bill.id,
    'bill_status', v_next_status,
    'paid_cents', v_next_paid,
    'applied_cents', p_amount_cents,
    'duplicate', false
  );
end;
$$;

revoke all on function public.apply_vendor_credit_atomic(uuid,uuid,uuid,uuid,bigint,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_vendor_credit_atomic(uuid,uuid,uuid,uuid,bigint,text,jsonb)
  to service_role;

-- Opens one incident on the first observation and merely refreshes last_seen on
-- retries. Unlike the sweep-oriented sync RPC, this does not resolve other orgs'
-- incidents when a webhook for one org arrives.
create or replace function public.open_payment_operations_incident(
  p_org_id uuid,
  p_finding_code text,
  p_detail text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
begin
  if nullif(btrim(p_finding_code), '') is null then raise exception 'Finding code is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || p_finding_code, 0));
  select incident.status into v_status
  from public.payment_operations_incidents incident
  where incident.org_id = p_org_id and incident.finding_code = p_finding_code
  for update;
  if not found then
    insert into public.payment_operations_incidents (org_id, finding_code, detail)
    values (p_org_id, p_finding_code, p_detail);
    return true;
  end if;
  update public.payment_operations_incidents incident
  set detail = p_detail,
      last_seen_at = now(),
      status = 'open',
      opened_at = case when v_status = 'resolved' then now() else opened_at end,
      last_notified_at = case when v_status = 'resolved' then now() else last_notified_at end,
      resolved_at = null
  where incident.org_id = p_org_id and incident.finding_code = p_finding_code;
  return v_status = 'resolved';
end;
$$;

revoke all on function public.open_payment_operations_incident(uuid,text,text) from public, anon, authenticated;
grant execute on function public.open_payment_operations_incident(uuid,text,text) to service_role;

create or replace function public.resolve_payment_operations_incident(
  p_org_id uuid,
  p_finding_code text
)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.payment_operations_incidents incident
  set status = 'resolved', resolved_at = now()
  where incident.org_id = p_org_id
    and incident.finding_code = p_finding_code
    and incident.status = 'open';
$$;

revoke all on function public.resolve_payment_operations_incident(uuid,text) from public, anon, authenticated;
grant execute on function public.resolve_payment_operations_incident(uuid,text) to service_role;

-- Bulk approval must not turn quick-capture drafts into obligations.
create or replace function public.assert_payable_ready_for_approval()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'approved'
     and old.status is distinct from 'approved'
     and coalesce(new.metadata->>'creation_state', 'ready') = 'draft' then
    raise exception 'Complete the payable draft before approval';
  end if;
  return new;
end;
$$;

drop trigger if exists vendor_bills_ready_before_approval on public.vendor_bills;
create trigger vendor_bills_ready_before_approval
  before update of status on public.vendor_bills
  for each row execute function public.assert_payable_ready_for_approval();

commit;
