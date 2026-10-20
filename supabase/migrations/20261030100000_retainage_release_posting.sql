-- A retainage release application has no lines, so post_pay_application's
-- line and schedule-of-values reconciliation refuses it every time, and the
-- service released the SOV with the member's client, which may not run
-- release_prime_sov_retainage. Releasing and posting now happen together, in
-- one transaction, as the service.
begin;

create or replace function public.post_retainage_release(
  p_org_id uuid,
  p_pay_application_id uuid,
  p_invoice_id uuid,
  p_amount_cents integer,
  p_summary jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app record;
begin
  perform 1 from public.contracts
   where id = (select contract_id from public.pay_applications where id = p_pay_application_id and org_id = p_org_id)
     and org_id = p_org_id
   for update;
  select * into v_app from public.pay_applications
   where id = p_pay_application_id and org_id = p_org_id
   for update;
  if not found then
    raise exception 'Pay application not found';
  end if;
  if v_app.status <> 'draft' then
    raise exception 'Pay application has already been submitted';
  end if;
  if coalesce(v_app.metadata->>'type', '') <> 'retainage_release'
     or (v_app.metadata->>'release_amount_cents')::bigint is distinct from p_amount_cents then
    raise exception 'This application is not the retainage release being posted';
  end if;
  if exists (select 1 from public.pay_application_lines where org_id = p_org_id and pay_application_id = p_pay_application_id) then
    raise exception 'A retainage release carries no schedule-of-values lines';
  end if;
  if not exists (select 1 from public.invoices where id = p_invoice_id and org_id = p_org_id and project_id = v_app.project_id
    and source_pay_application_id = p_pay_application_id and status = 'draft' and total_cents = p_amount_cents) then
    raise exception 'Release invoice does not reconcile to the release amount';
  end if;

  perform public.release_prime_sov_retainage(p_org_id, v_app.contract_id, p_amount_cents);

  update public.pay_applications
  set status = 'invoiced',
      invoice_id = p_invoice_id,
      submitted_at = now(),
      original_contract_sum_cents = coalesce((p_summary->>'original_contract_sum_cents')::bigint, 0),
      change_order_sum_cents = coalesce((p_summary->>'change_order_sum_cents')::bigint, 0),
      contract_sum_to_date_cents = coalesce((p_summary->>'contract_sum_to_date_cents')::bigint, 0),
      total_completed_stored_cents = coalesce((p_summary->>'total_completed_stored_cents')::bigint, 0),
      retainage_cents = coalesce((p_summary->>'retainage_cents')::bigint, 0),
      total_earned_less_retainage_cents = coalesce((p_summary->>'total_earned_less_retainage_cents')::bigint, 0),
      previous_certificates_cents = coalesce((p_summary->>'previous_certificates_cents')::bigint, 0),
      current_payment_due_cents = p_amount_cents,
      balance_to_finish_cents = coalesce((p_summary->>'balance_to_finish_cents')::bigint, 0),
      metadata = coalesce(v_app.metadata, '{}'::jsonb) || coalesce(p_summary->'metadata', '{}'::jsonb)
  where id = p_pay_application_id and org_id = p_org_id;

  perform public.rebase_pay_application_drafts(p_org_id, v_app.contract_id);
  return jsonb_build_object('pay_application_id', p_pay_application_id, 'invoice_id', p_invoice_id, 'released_cents', p_amount_cents);
end;
$$;

revoke all on function public.post_retainage_release(uuid, uuid, uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.post_retainage_release(uuid, uuid, uuid, integer, jsonb) to service_role;

commit;
