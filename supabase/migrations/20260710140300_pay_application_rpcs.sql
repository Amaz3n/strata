-- Workstream 02: atomic pay-application posting, voiding, and retainage
-- release. Mirrors the run_bid_award_conversion pattern: the multi-table
-- rollup updates must land together, so they live in SQL.

create or replace function public.post_pay_application(
  p_org_id uuid,
  p_pay_application_id uuid,
  p_invoice_id uuid,
  p_summary jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_app record;
begin
  select * into v_app
  from public.pay_applications
  where id = p_pay_application_id and org_id = p_org_id
  for update;

  if not found then
    raise exception 'Pay application not found';
  end if;
  if v_app.status <> 'draft' then
    raise exception 'Pay application has already been submitted';
  end if;

  update public.prime_sov_lines s
  set previous_billed_cents = s.previous_billed_cents + l.this_period_cents,
      stored_materials_cents = l.stored_materials_cents,
      retainage_held_cents = s.retainage_held_cents + l.retainage_cents
  from public.pay_application_lines l
  where l.pay_application_id = p_pay_application_id
    and l.org_id = p_org_id
    and s.id = l.prime_sov_line_id
    and s.org_id = p_org_id;

  update public.pay_applications
  set status = 'invoiced',
      invoice_id = p_invoice_id,
      submitted_at = now(),
      original_contract_sum_cents = coalesce((p_summary->>'original_contract_sum_cents')::integer, 0),
      change_order_sum_cents = coalesce((p_summary->>'change_order_sum_cents')::integer, 0),
      contract_sum_to_date_cents = coalesce((p_summary->>'contract_sum_to_date_cents')::integer, 0),
      total_completed_stored_cents = coalesce((p_summary->>'total_completed_stored_cents')::integer, 0),
      retainage_cents = coalesce((p_summary->>'retainage_cents')::integer, 0),
      total_earned_less_retainage_cents = coalesce((p_summary->>'total_earned_less_retainage_cents')::integer, 0),
      previous_certificates_cents = coalesce((p_summary->>'previous_certificates_cents')::integer, 0),
      current_payment_due_cents = coalesce((p_summary->>'current_payment_due_cents')::integer, 0),
      balance_to_finish_cents = coalesce((p_summary->>'balance_to_finish_cents')::integer, 0),
      metadata = coalesce(v_app.metadata, '{}'::jsonb) || coalesce(p_summary->'metadata', '{}'::jsonb)
  where id = p_pay_application_id and org_id = p_org_id;

  return jsonb_build_object('pay_application_id', p_pay_application_id, 'invoice_id', p_invoice_id);
end;
$$;

create or replace function public.void_pay_application(
  p_org_id uuid,
  p_pay_application_id uuid
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_app record;
  v_newer integer;
  v_invoice_status text;
begin
  select * into v_app
  from public.pay_applications
  where id = p_pay_application_id and org_id = p_org_id
  for update;

  if not found then
    raise exception 'Pay application not found';
  end if;
  if v_app.status = 'void' then
    return jsonb_build_object('pay_application_id', p_pay_application_id, 'already_void', true);
  end if;
  if v_app.status not in ('submitted', 'approved', 'invoiced') then
    raise exception 'Only submitted pay applications can be voided; delete drafts instead';
  end if;

  select count(*) into v_newer
  from public.pay_applications
  where org_id = p_org_id
    and contract_id = v_app.contract_id
    and application_number > v_app.application_number
    and status <> 'void';
  if v_newer > 0 then
    raise exception 'Only the latest pay application can be voided';
  end if;

  if v_app.invoice_id is not null then
    select status into v_invoice_status
    from public.invoices
    where id = v_app.invoice_id and org_id = p_org_id;
    if v_invoice_status in ('paid', 'partial') then
      raise exception 'The pay application invoice has payments and cannot be voided';
    end if;
  end if;

  update public.prime_sov_lines s
  set previous_billed_cents = s.previous_billed_cents - l.this_period_cents,
      stored_materials_cents = coalesce((l.metadata->>'previous_stored_materials_cents')::integer, s.stored_materials_cents),
      retainage_held_cents = s.retainage_held_cents - l.retainage_cents
  from public.pay_application_lines l
  where l.pay_application_id = p_pay_application_id
    and l.org_id = p_org_id
    and s.id = l.prime_sov_line_id
    and s.org_id = p_org_id;

  update public.pay_applications
  set status = 'void'
  where id = p_pay_application_id and org_id = p_org_id;

  return jsonb_build_object('pay_application_id', p_pay_application_id, 'invoice_id', v_app.invoice_id);
end;
$$;

create or replace function public.release_prime_sov_retainage(
  p_org_id uuid,
  p_contract_id uuid,
  p_amount_cents integer
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_available bigint;
  v_remaining integer := p_amount_cents;
  v_line record;
  v_take integer;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Release amount must be positive';
  end if;

  select coalesce(sum(retainage_held_cents - retainage_released_cents), 0) into v_available
  from public.prime_sov_lines
  where org_id = p_org_id and contract_id = p_contract_id;

  if v_available < p_amount_cents then
    raise exception 'Release amount exceeds retainage held (% cents available)', v_available;
  end if;

  for v_line in
    select id, retainage_held_cents, retainage_released_cents
    from public.prime_sov_lines
    where org_id = p_org_id
      and contract_id = p_contract_id
      and retainage_held_cents - retainage_released_cents > 0
    order by line_number
    for update
  loop
    exit when v_remaining <= 0;
    v_take := least(v_remaining, v_line.retainage_held_cents - v_line.retainage_released_cents);
    update public.prime_sov_lines
    set retainage_released_cents = retainage_released_cents + v_take
    where id = v_line.id and org_id = p_org_id;
    v_remaining := v_remaining - v_take;
  end loop;

  return jsonb_build_object('released_cents', p_amount_cents - v_remaining);
end;
$$;

grant execute on function public.post_pay_application(uuid, uuid, uuid, jsonb) to authenticated, service_role;
grant execute on function public.void_pay_application(uuid, uuid) to authenticated, service_role;
grant execute on function public.release_prime_sov_retainage(uuid, uuid, integer) to authenticated, service_role;
