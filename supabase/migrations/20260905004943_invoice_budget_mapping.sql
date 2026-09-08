-- Preserve project budget allocations through invoice creation, draft updates, and revisions.
-- Existing authorization, financial guards, and grants remain unchanged.

begin;

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
  v_issued boolean := coalesce((p_invoice ->> 'client_visible')::boolean, false);
  v_status text;
begin
  if p_org_id is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Invoice requires an organization and at least one line';
  end if;
  if auth.uid() is not null and not public.is_org_member(p_org_id) then
    raise exception 'Not authorized for this organization';
  end if;

  -- A new invoice is either a draft or freshly issued. Anything else — paid,
  -- partial, overdue, void — is a state the ledger reaches on its own.
  if coalesce(nullif(p_invoice ->> 'status', ''), case when v_issued then 'sent' else 'draft' end)
     not in ('draft', 'sent') then
    raise exception 'An invoice cannot be created in state %', p_invoice ->> 'status';
  end if;
  v_status := case when v_issued then 'sent' else 'draft' end;

  if p_invoice ->> 'product_posture' = 'commercial'
    and v_issued
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
    p_invoice ->> 'title', v_status,
    nullif(p_invoice ->> 'issue_date', '')::date,
    nullif(p_invoice ->> 'due_date', '')::date, nullif(p_invoice ->> 'notes', ''),
    v_issued,
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
    if nullif(v_line ->> 'budget_line_id', '') is not null and not exists (
      select 1 from public.budget_lines bl
      join public.budgets b on b.id = bl.budget_id and b.org_id = bl.org_id
      where bl.id = (v_line ->> 'budget_line_id')::uuid and bl.org_id = p_org_id
        and b.project_id = v_invoice.project_id
    ) then
      raise exception 'Invoice budget allocation must belong to its project';
    end if;
    insert into public.invoice_lines (
      org_id, invoice_id, cost_code_id, budget_line_id, description, quantity, unit,
      unit_price_cents, metadata
    ) values (
      p_org_id, v_invoice.id, nullif(v_line ->> 'cost_code_id', '')::uuid, nullif(v_line ->> 'budget_line_id', '')::uuid,
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
  v_issued boolean := coalesce((p_invoice ->> 'client_visible')::boolean, false);
  v_status text;
  v_project_id uuid;
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
    or v_existing.status <> 'draft' then
    raise exception 'Issued invoices are immutable; void and reissue instead';
  end if;
  if p_expected_updated_at is not null and v_existing.updated_at <> p_expected_updated_at then
    raise exception 'Invoice changed in another session; refresh before saving';
  end if;

  -- An edit may not relocate the invoice. The caller was authorized against the
  -- project this invoice is already in; moving it is `move_invoice_to_project`,
  -- which authorizes BOTH sides and releases the source project's links.
  v_project_id := nullif(p_invoice ->> 'project_id', '')::uuid;
  if v_project_id is distinct from v_existing.project_id then
    raise exception 'An invoice edit cannot change its project';
  end if;

  if coalesce(nullif(p_invoice ->> 'status', ''), case when v_issued then 'sent' else 'draft' end)
     not in ('draft', 'sent') then
    raise exception 'An invoice edit cannot set state %', p_invoice ->> 'status';
  end if;
  v_status := case when v_issued then 'sent' else 'draft' end;

  if p_invoice ->> 'product_posture' = 'commercial'
    and v_issued
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
    token = nullif(p_invoice ->> 'token', ''),
    invoice_number = p_invoice ->> 'invoice_number', title = p_invoice ->> 'title',
    status = v_status,
    issue_date = nullif(p_invoice ->> 'issue_date', '')::date,
    due_date = nullif(p_invoice ->> 'due_date', '')::date,
    notes = nullif(p_invoice ->> 'notes', ''),
    client_visible = v_issued,
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
    if nullif(v_line ->> 'budget_line_id', '') is not null and not exists (
      select 1 from public.budget_lines bl
      join public.budgets b on b.id = bl.budget_id and b.org_id = bl.org_id
      where bl.id = (v_line ->> 'budget_line_id')::uuid and bl.org_id = p_org_id
        and b.project_id = v_invoice.project_id
    ) then
      raise exception 'Invoice budget allocation must belong to its project';
    end if;
    insert into public.invoice_lines (
      org_id, invoice_id, cost_code_id, budget_line_id, description, quantity, unit,
      unit_price_cents, metadata
    ) values (
      p_org_id, p_invoice_id, nullif(v_line ->> 'cost_code_id', '')::uuid, nullif(v_line ->> 'budget_line_id', '')::uuid,
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
    p_org_id, v_original.project_id, p_invoice_number, 'draft', current_date,
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
      org_id, invoice_id, cost_code_id, budget_line_id, description, quantity, unit,
      unit_price_cents, metadata
    ) values (
      p_org_id, v_replacement.id, v_line.cost_code_id, v_line.budget_line_id, v_line.description,
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

commit;
