-- Invoice correction is a financial transaction, not a chain of compensating
-- browser writes. These routines serialize the invoice and move every source
-- ownership record in the same database transaction.
set lock_timeout = '5s';
set statement_timeout = '120s';

-- PostgREST ON CONFLICT cannot infer a partial index. NULL values remain freely
-- repeatable under an ordinary unique index, while provider reversal ids become
-- a usable retry-safe conflict target.
drop index if exists public.payment_reversals_provider_uq;
create unique index payment_reversals_provider_uq
  on public.payment_reversals (org_id, provider_reversal_id);

begin;

create or replace function public.void_invoice_atomic(
  p_org_id uuid,
  p_invoice_id uuid,
  p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_invoice public.invoices%rowtype;
  v_period public.project_billing_periods%rowtype;
  v_next_invoice_ids uuid[];
begin
  if auth.uid() is not null and not public.is_org_member(p_org_id) then
    raise exception 'Not authorized for this organization';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and org_id = p_org_id
  for update;
  if v_invoice.id is null then raise exception 'Invoice not found'; end if;
  if v_invoice.status = 'void' then return to_jsonb(v_invoice); end if;
  if v_invoice.status in ('partial', 'paid') then
    raise exception 'Paid or partially paid invoices cannot be voided';
  end if;
  if v_invoice.source_pay_application_id is not null and exists (
    select 1 from public.pay_applications application
    where application.id = v_invoice.source_pay_application_id
      and application.org_id = p_org_id
      and application.status not in ('draft', 'void')
  ) then
    raise exception 'Void the pay application so its schedule-of-values rollups reverse with the invoice';
  end if;
  if exists (
    select 1 from public.payments
    where org_id = p_org_id and invoice_id = p_invoice_id and status <> 'failed'
  ) or exists (
    select 1
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.org_id = p_org_id
      and allocation.invoice_id = p_invoice_id
      and payment.status <> 'failed'
  ) then
    raise exception 'Invoices with recorded payments cannot be voided';
  end if;

  if v_invoice.billing_period_id is not null then
    select * into v_period
    from public.project_billing_periods
    where id = v_invoice.billing_period_id and org_id = p_org_id
    for update;
    if v_period.id is not null then
      select coalesce(array_agg(item), '{}'::uuid[]) into v_next_invoice_ids
      from unnest(v_period.invoice_ids) item
      where item <> p_invoice_id;
      update public.project_billing_periods
      set invoice_ids = v_next_invoice_ids,
          status = case
            when cardinality(v_next_invoice_ids) > 0 then 'invoiced'
            when status in ('open', 'reviewing') then status
            else 'reopened'
          end,
          reopened_at = case
            when cardinality(v_next_invoice_ids) = 0 and status not in ('open', 'reviewing')
              then now()
            else reopened_at
          end,
          metadata = metadata || jsonb_build_object(
            'last_invoice_id', v_next_invoice_ids[cardinality(v_next_invoice_ids)],
            'released_invoice_id', p_invoice_id,
            'released_at', now()
          )
      where id = v_period.id;
    end if;
  end if;

  update public.draw_schedules
  set invoice_id = null,
      status = case when status in ('paid', 'partial') then status else 'pending' end
  where org_id = p_org_id and invoice_id = p_invoice_id;

  with allocations as (
    select (item ->> 'line_id')::uuid as line_id,
           sum(coalesce((item ->> 'amount_cents')::integer, 0))::integer as amount_cents
    from public.project_fee_billings billing
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(billing.metadata -> 'allocations') = 'array'
        then billing.metadata -> 'allocations' else '[]'::jsonb end
    ) item
    where billing.org_id = p_org_id
      and billing.invoice_id = p_invoice_id
      and billing.status <> 'voided'
      and nullif(item ->> 'line_id', '') is not null
    group by (item ->> 'line_id')::uuid
  ), next_lines as (
    select line.id,
           greatest(0, line.billed_fee_cents - allocations.amount_cents) as next_billed,
           line.scheduled_fee_cents,
           line.earned_fee_cents
    from public.project_fee_schedule_lines line
    join allocations on allocations.line_id = line.id
    where line.org_id = p_org_id
  )
  update public.project_fee_schedule_lines line
  set billed_fee_cents = next_lines.next_billed,
      invoice_id = null,
      invoice_line_id = null,
      billed_at = case when next_lines.next_billed > 0 then line.billed_at else null end,
      status = case
        when next_lines.next_billed <= 0 and next_lines.earned_fee_cents > 0 then 'earned'
        when next_lines.next_billed <= 0 then 'unbilled'
        when next_lines.next_billed >= next_lines.scheduled_fee_cents then 'billed'
        else 'partially_billed'
      end
  from next_lines
  where line.id = next_lines.id;

  update public.project_fee_billings
  set status = 'voided', voided_at = now()
  where org_id = p_org_id and invoice_id = p_invoice_id and status <> 'voided';

  update public.billable_costs
  set invoice_id = null, invoice_line_id = null, billing_period_id = null,
      status = 'open', billed_at = null
  where org_id = p_org_id and invoice_id = p_invoice_id;

  delete from public.retainage
  where org_id = p_org_id and invoice_id = p_invoice_id and status <> 'paid';

  update public.invoices
  set status = 'void', client_visible = false, token = null,
      balance_due_cents = 0, billing_period_id = null,
      source_draw_id = null, source_change_order_id = null,
      source_pay_application_id = null, delivery_status = 'not_sent',
      metadata = metadata || jsonb_build_object(
        'voided_at', now(), 'voided_by', p_actor_id
      )
  where id = p_invoice_id and org_id = p_org_id
  returning * into v_invoice;

  return to_jsonb(v_invoice);
end;
$$;

create or replace function public.revise_invoice_atomic(
  p_org_id uuid,
  p_invoice_id uuid,
  p_actor_id uuid,
  p_invoice_number text,
  p_reservation_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_original public.invoices%rowtype;
  v_replacement public.invoices%rowtype;
  v_line public.invoice_lines%rowtype;
  v_new_line_id uuid;
begin
  if auth.uid() is not null and not public.is_org_member(p_org_id) then
    raise exception 'Not authorized for this organization';
  end if;
  if nullif(btrim(p_invoice_number), '') is null then
    raise exception 'A replacement invoice number is required';
  end if;

  select * into v_original
  from public.invoices
  where id = p_invoice_id and org_id = p_org_id
  for update;
  if v_original.id is null then raise exception 'Invoice not found'; end if;
  if v_original.status in ('draft', 'saved') and v_original.sent_at is null then
    raise exception 'This invoice is still editable and does not need a revision';
  end if;
  if v_original.status in ('partial', 'paid') then
    raise exception 'Paid or partially paid invoices require a credit or adjustment';
  end if;
  if v_original.status = 'void' then raise exception 'Invoice is already void'; end if;
  if v_original.source_pay_application_id is not null then
    raise exception 'Revise the pay application so schedule-of-values history remains authoritative';
  end if;
  if exists (
    select 1 from public.payments
    where org_id = p_org_id and invoice_id = p_invoice_id and status <> 'failed'
  ) or exists (
    select 1
    from public.payment_allocations allocation
    join public.payments payment on payment.id = allocation.payment_id
    where allocation.org_id = p_org_id
      and allocation.invoice_id = p_invoice_id
      and payment.status <> 'failed'
  ) then
    raise exception 'Invoices with recorded payments require a credit or adjustment';
  end if;

  -- Clear the live source uniqueness keys on the original before inserting the
  -- replacement. A later failure rolls this update back with the whole function.
  update public.invoices
  set status = 'void', client_visible = false, token = null,
      balance_due_cents = 0, delivery_status = 'not_sent',
      source_draw_id = null, source_change_order_id = null,
      source_pay_application_id = null,
      metadata = metadata || jsonb_build_object(
        'voided_at', now(), 'voided_by', p_actor_id
      )
  where id = v_original.id;

  insert into public.invoices (
    org_id, project_id, invoice_number, status, issue_date, due_date,
    total_cents, currency, recipient_contact_id, metadata, title, notes,
    client_visible, subtotal_cents, tax_cents, balance_due_cents, tax_rate,
    sent_at, sent_to_emails, billing_period_id, source_type, source_draw_id,
    source_change_order_id, source_pay_application_id, product_posture,
    approval_status, delivery_status, issued_snapshot, tax_jurisdiction_id
  ) values (
    p_org_id, v_original.project_id, p_invoice_number, 'saved', current_date,
    v_original.due_date, v_original.total_cents, v_original.currency,
    v_original.recipient_contact_id,
    (v_original.metadata - 'sent_at' - 'viewed_at') || jsonb_build_object(
      'revision_of_invoice_id', v_original.id,
      'revision_of_invoice_number', v_original.invoice_number,
      'created_by', p_actor_id
    ),
    v_original.title, v_original.notes, false, v_original.subtotal_cents,
    v_original.tax_cents, v_original.total_cents, v_original.tax_rate,
    null, null, v_original.billing_period_id, v_original.source_type,
    v_original.source_draw_id, v_original.source_change_order_id, null,
    v_original.product_posture,
    case when v_original.product_posture = 'commercial' then 'draft' else 'not_required' end,
    'not_sent', null, v_original.tax_jurisdiction_id
  ) returning * into v_replacement;

  for v_line in
    select * from public.invoice_lines
    where org_id = p_org_id and invoice_id = v_original.id
    order by id
  loop
    insert into public.invoice_lines (
      org_id, invoice_id, cost_code_id, description, quantity, unit,
      unit_price_cents, metadata
    ) values (
      p_org_id, v_replacement.id, v_line.cost_code_id, v_line.description,
      v_line.quantity, v_line.unit, v_line.unit_price_cents, v_line.metadata
    ) returning id into v_new_line_id;

    update public.billable_costs
    set invoice_id = v_replacement.id, invoice_line_id = v_new_line_id
    where org_id = p_org_id and invoice_id = v_original.id
      and invoice_line_id = v_line.id;
    update public.project_fee_schedule_lines
    set invoice_id = v_replacement.id, invoice_line_id = v_new_line_id
    where org_id = p_org_id and invoice_id = v_original.id
      and invoice_line_id = v_line.id;
  end loop;

  update public.billable_costs
  set invoice_id = v_replacement.id
  where org_id = p_org_id and invoice_id = v_original.id;
  update public.project_fee_schedule_lines
  set invoice_id = v_replacement.id
  where org_id = p_org_id and invoice_id = v_original.id;
  update public.project_fee_billings
  set invoice_id = v_replacement.id
  where org_id = p_org_id and invoice_id = v_original.id and status <> 'voided';
  update public.retainage
  set invoice_id = v_replacement.id
  where org_id = p_org_id and invoice_id = v_original.id and status <> 'paid';
  update public.draw_schedules
  set invoice_id = v_replacement.id,
      status = case when status in ('paid', 'partial') then status else 'invoiced' end
  where org_id = p_org_id and invoice_id = v_original.id;
  update public.project_billing_periods
  set invoice_ids = array(
    select case when item = v_original.id then v_replacement.id else item end
    from unnest(invoice_ids) item
  ),
      metadata = metadata || jsonb_build_object(
        'last_invoice_id', v_replacement.id,
        'revised_invoice_id', v_original.id,
        'revised_at', now()
      )
  where org_id = p_org_id and id = v_original.billing_period_id;

  update public.invoices
  set metadata = metadata || jsonb_build_object(
    'replaced_by_invoice_id', v_replacement.id
  )
  where id = v_original.id;

  if p_reservation_id is not null then
    update public.qbo_invoice_reservations
    set status = 'used', used_by_invoice_id = v_replacement.id
    where id = p_reservation_id and org_id = p_org_id
      and reserved_number = p_invoice_number and status = 'reserved';
    if not found then raise exception 'Invoice number reservation is no longer valid'; end if;
  end if;

  return jsonb_build_object(
    'original', (select to_jsonb(invoice_row) from public.invoices invoice_row where id = v_original.id),
    'replacement', to_jsonb(v_replacement)
  );
end;
$$;

revoke all on function public.void_invoice_atomic(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.revise_invoice_atomic(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.void_invoice_atomic(uuid, uuid, uuid) to service_role;
grant execute on function public.revise_invoice_atomic(uuid, uuid, uuid, text, uuid) to service_role;

commit;
