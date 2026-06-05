-- Phase 1 financial ecosystem hardening:
-- the approved-cost invoice RPC should not trust stale client/app previews.
-- It still accepts a preview for line shape, but verifies selected costs and
-- totals against locked billable_costs inside the transaction before insert.

create or replace function public.create_invoice_from_billable_costs_atomic(
  p_org_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_invoice_number text,
  p_token text,
  p_title text,
  p_issue_date date,
  p_due_date date,
  p_from_date date,
  p_to_date date,
  p_group_by text,
  p_cost_ids uuid[],
  p_preview jsonb,
  p_idempotency_key text default null,
  p_reservation_id uuid default null,
  p_status text default 'saved',
  p_client_visible boolean default false,
  p_notes text default null,
  p_sent_to_emails text[] default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_response jsonb;
  v_invoice_id uuid;
  v_locked_ids uuid[];
  v_preview_cost_ids uuid[];
  v_line jsonb;
  v_line_id uuid;
  v_line_cost_ids uuid[];
  v_totals jsonb;
  v_cost_count integer;
  v_distinct_cost_count integer;
  v_actual_cost_cents integer;
  v_actual_markup_cents integer;
  v_actual_billable_cents integer;
  v_line_actual_cost_cents integer;
  v_line_actual_markup_cents integer;
  v_line_actual_billable_cents integer;
begin
  if p_org_id is null or p_project_id is null then
    raise exception 'Organization and project are required';
  end if;

  if p_cost_ids is null or cardinality(p_cost_ids) = 0 then
    raise exception 'At least one billable cost is required';
  end if;

  select count(distinct cost_id)
    into v_distinct_cost_count
    from unnest(p_cost_ids) as input_costs(cost_id);

  if v_distinct_cost_count <> cardinality(p_cost_ids) then
    raise exception 'Approved-cost invoice includes duplicate costs. Refresh and try again.';
  end if;

  if p_preview is null or jsonb_typeof(p_preview->'lines') <> 'array' then
    raise exception 'Invoice preview lines are required';
  end if;

  if p_idempotency_key is not null then
    select response
      into v_existing_response
      from public.idempotency_keys
      where org_id = p_org_id
        and scope = 'generate_invoice_from_costs'
        and key = p_idempotency_key
      limit 1;

    if (v_existing_response->>'invoiceId') is not null then
      return v_existing_response;
    end if;
  end if;

  select coalesce(array_agg(id), '{}'::uuid[])
    into v_locked_ids
    from (
      select id
      from public.billable_costs
      where org_id = p_org_id
        and project_id = p_project_id
        and status = 'open'
        and is_billable = true
        and id = any(p_cost_ids)
      for update
    ) locked;

  if cardinality(v_locked_ids) <> cardinality(p_cost_ids) then
    raise exception 'Some costs were already claimed by another invoice. Refresh and try again.';
  end if;

  select coalesce(array_agg(distinct cost_id), '{}'::uuid[])
    into v_preview_cost_ids
    from (
      select jsonb_array_elements_text(coalesce(line.value->'billable_cost_ids', '[]'::jsonb))::uuid as cost_id
      from jsonb_array_elements(p_preview->'lines') as line(value)
    ) preview_ids;

  if cardinality(v_preview_cost_ids) <> cardinality(p_cost_ids)
    or not (v_preview_cost_ids @> p_cost_ids and p_cost_ids @> v_preview_cost_ids) then
    raise exception 'Approved-cost invoice preview is stale. Refresh and try again.';
  end if;

  select
    coalesce(sum(cost_cents), 0)::integer,
    coalesce(sum(markup_cents), 0)::integer,
    coalesce(sum(billable_cents), 0)::integer
  into
    v_actual_cost_cents,
    v_actual_markup_cents,
    v_actual_billable_cents
  from public.billable_costs
  where org_id = p_org_id
    and project_id = p_project_id
    and id = any(p_cost_ids);

  v_totals := coalesce(p_preview->'totals', '{}'::jsonb);

  if coalesce((v_totals->>'cost_cents')::integer, 0) <> v_actual_cost_cents
    or coalesce((v_totals->>'markup_cents')::integer, 0) <> v_actual_markup_cents
    or coalesce((v_totals->>'billable_cents')::integer, 0) <> v_actual_billable_cents then
    raise exception 'Approved-cost invoice preview is stale. Refresh and try again.';
  end if;

  for v_line in
    select value
    from jsonb_array_elements(p_preview->'lines') as value
  loop
    v_line_cost_ids := coalesce(
      array(select jsonb_array_elements_text(coalesce(v_line->'billable_cost_ids', '[]'::jsonb))::uuid),
      '{}'::uuid[]
    );

    if cardinality(v_line_cost_ids) = 0 then
      raise exception 'Approved-cost invoice line is missing linked costs. Refresh and try again.';
    end if;

    select
      coalesce(sum(cost_cents), 0)::integer,
      coalesce(sum(markup_cents), 0)::integer,
      coalesce(sum(billable_cents), 0)::integer
    into
      v_line_actual_cost_cents,
      v_line_actual_markup_cents,
      v_line_actual_billable_cents
    from public.billable_costs
    where org_id = p_org_id
      and project_id = p_project_id
      and id = any(v_line_cost_ids)
      and id = any(p_cost_ids);

    if coalesce((v_line->>'cost_cents')::integer, 0) <> v_line_actual_cost_cents
      or coalesce((v_line->>'markup_cents')::integer, 0) <> v_line_actual_markup_cents
      or coalesce((v_line->>'billable_cents')::integer, 0) <> v_line_actual_billable_cents then
      raise exception 'Approved-cost invoice preview is stale. Refresh and try again.';
    end if;
  end loop;

  v_cost_count := cardinality(p_cost_ids);

  insert into public.invoices (
    org_id,
    project_id,
    token,
    invoice_number,
    title,
    status,
    issue_date,
    due_date,
    notes,
    client_visible,
    subtotal_cents,
    tax_cents,
    total_cents,
    balance_due_cents,
    metadata,
    sent_to_emails
  )
  values (
    p_org_id,
    p_project_id,
    p_token,
    p_invoice_number,
    p_title,
    coalesce(nullif(p_status, ''), 'saved'),
    p_issue_date,
    p_due_date,
    p_notes,
    coalesce(p_client_visible, false),
    v_actual_billable_cents,
    0,
    v_actual_billable_cents,
    v_actual_billable_cents,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'source_type', 'from_costs',
      'date_range', jsonb_build_object('from', p_from_date, 'to', p_to_date),
      'group_by', p_group_by,
      'cost_count', v_cost_count,
      'total_cost_cents', v_actual_cost_cents,
      'total_markup_cents', v_actual_markup_cents,
      'idempotency_key', p_idempotency_key,
      'totals', jsonb_build_object(
        'subtotal_cents', v_actual_billable_cents,
        'tax_cents', 0,
        'total_cents', v_actual_billable_cents,
        'balance_due_cents', v_actual_billable_cents
      ),
      'created_by', p_actor_id
    ),
    p_sent_to_emails
  )
  returning id into v_invoice_id;

  update public.billable_costs
     set status = 'locked'
   where org_id = p_org_id
     and id = any(p_cost_ids);

  for v_line in
    select value
    from jsonb_array_elements(p_preview->'lines') as value
  loop
    v_line_cost_ids := coalesce(
      array(select jsonb_array_elements_text(coalesce(v_line->'billable_cost_ids', '[]'::jsonb))::uuid),
      '{}'::uuid[]
    );

    insert into public.invoice_lines (
      org_id,
      invoice_id,
      cost_code_id,
      description,
      quantity,
      unit,
      unit_price_cents,
      sort_order,
      metadata
    )
    values (
      p_org_id,
      v_invoice_id,
      nullif(v_line->>'cost_code_id', '')::uuid,
      coalesce(v_line->>'description', 'Approved costs'),
      1,
      'LS',
      coalesce((v_line->>'billable_cents')::integer, 0),
      coalesce((v_line->>'sort_order')::integer, 0),
      jsonb_build_object(
        'source_type', 'from_costs',
        'billable_cost_ids', coalesce(v_line->'billable_cost_ids', '[]'::jsonb),
        'cost_cents', coalesce((v_line->>'cost_cents')::integer, 0),
        'markup_cents', coalesce((v_line->>'markup_cents')::integer, 0),
        'markup_percent', coalesce((v_line->>'markup_percent')::numeric, 0)
      )
    )
    returning id into v_line_id;

    update public.billable_costs
       set invoice_id = v_invoice_id,
           invoice_line_id = v_line_id,
           status = 'billed',
           billed_at = now()
     where org_id = p_org_id
       and project_id = p_project_id
       and id = any(v_line_cost_ids)
       and id = any(p_cost_ids);
  end loop;

  if exists (
    select 1
    from public.billable_costs
    where org_id = p_org_id
      and id = any(p_cost_ids)
      and status <> 'billed'
  ) then
    raise exception 'Not all billable costs were linked to invoice lines';
  end if;

  if p_reservation_id is not null then
    update public.qbo_invoice_reservations
       set status = 'used',
           used_by_invoice_id = v_invoice_id
     where org_id = p_org_id
       and id = p_reservation_id
       and status = 'reserved';
  end if;

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (org_id, key, scope, response)
    values (
      p_org_id,
      p_idempotency_key,
      'generate_invoice_from_costs',
      jsonb_build_object('invoiceId', v_invoice_id, 'invoicePreview', p_preview)
    )
    on conflict (org_id, scope, key)
    do update set response = excluded.response;
  end if;

  return jsonb_build_object('invoiceId', v_invoice_id, 'invoicePreview', p_preview);
end;
$$;

grant execute on function public.create_invoice_from_billable_costs_atomic(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  date,
  date,
  date,
  date,
  text,
  uuid[],
  jsonb,
  text,
  uuid,
  text,
  boolean,
  text,
  text[],
  jsonb
) to authenticated, service_role;
