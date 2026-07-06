-- Financials Trust & Billing Modes Refactor - Phase 2
-- Treat builder fee as a first-class invoice presentation concept.

alter table public.contracts
  add column if not exists fee_presentation text not null default 'embedded';

alter table public.contracts
  drop constraint if exists contracts_fee_presentation_check,
  add constraint contracts_fee_presentation_check
    check (fee_presentation in ('embedded', 'separate_total', 'separate_by_code'));

comment on column public.contracts.fee_presentation is
  'Approved-cost invoice fee display: embedded in cost lines, one separate total, or one separate fee line per cost code.';

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
  v_line_metadata jsonb;
  v_line_unit text;
  v_line_kind text;
  v_line_cost_kind text;
  v_line_billable_cents integer;
  v_totals jsonb;
  v_cost_count integer;
  v_distinct_cost_count integer;
  v_actual_cost_cents integer;
  v_actual_markup_cents integer;
  v_actual_billable_cents integer;
  v_line_actual_cost_cents integer;
  v_line_actual_markup_cents integer;
  v_line_actual_billable_cents integer;
  v_preview_gross_line_cents integer := 0;
  v_preview_cost_markup_fee_cents integer := 0;
  v_preview_fixed_fee_cents integer := 0;
  v_allowed_fixed_fee_cents integer := 0;
  v_contract_id uuid;
  v_retainage_percent numeric := 0;
  v_retainage_cents integer := 0;
  v_invoice_total_cents integer := 0;
  v_invoice_preview jsonb;
  v_preview_has_retainage boolean := false;
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
      where jsonb_array_length(coalesce(line.value->'billable_cost_ids', '[]'::jsonb)) > 0
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
    or coalesce((v_totals->>'markup_cents')::integer, 0) <> v_actual_markup_cents then
    raise exception 'Approved-cost invoice preview is stale. Refresh and try again.';
  end if;

  if coalesce(p_metadata->>'earned_fee_cents', '') ~ '^-?[0-9]+$' then
    v_allowed_fixed_fee_cents := coalesce((p_metadata->>'earned_fee_cents')::integer, 0);
  end if;

  for v_line in
    select value
    from jsonb_array_elements(p_preview->'lines') as value
  loop
    v_line_metadata := coalesce(v_line->'metadata', '{}'::jsonb);
    v_line_unit := lower(coalesce(v_line->>'unit', ''));
    v_line_kind := coalesce(v_line_metadata->>'fee_line_kind', '');
    v_line_cost_kind := coalesce(v_line_metadata->>'cost_line_kind', '');
    v_line_billable_cents := coalesce((v_line->>'billable_cents')::integer, 0);
    v_line_cost_ids := coalesce(
      array(select jsonb_array_elements_text(coalesce(v_line->'billable_cost_ids', '[]'::jsonb))::uuid),
      '{}'::uuid[]
    );

    if v_line_unit = 'retainage' or v_line_metadata->>'system_generated_kind' = 'retainage_hold' then
      continue;
    end if;

    v_preview_gross_line_cents := v_preview_gross_line_cents + v_line_billable_cents;

    if cardinality(v_line_cost_ids) > 0 then
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

      if v_line_cost_kind = 'reimbursable_cost' then
        if coalesce((v_line->>'cost_cents')::integer, 0) <> v_line_actual_cost_cents
          or coalesce((v_line->>'markup_cents')::integer, 0) <> 0
          or v_line_billable_cents <> v_line_actual_cost_cents then
          raise exception 'Approved-cost invoice preview is stale. Refresh and try again.';
        end if;
      elsif coalesce((v_line->>'cost_cents')::integer, 0) <> v_line_actual_cost_cents
        or coalesce((v_line->>'markup_cents')::integer, 0) <> v_line_actual_markup_cents
        or v_line_billable_cents <> v_line_actual_billable_cents then
        raise exception 'Approved-cost invoice preview is stale. Refresh and try again.';
      end if;
    elsif v_line_unit = 'fee' or v_line_kind in ('cost_markup', 'fixed_fee_earned') then
      if v_line_kind = 'cost_markup' then
        v_preview_cost_markup_fee_cents := v_preview_cost_markup_fee_cents + v_line_billable_cents;
      elsif v_line_kind = 'fixed_fee_earned' then
        v_preview_fixed_fee_cents := v_preview_fixed_fee_cents + v_line_billable_cents;
      else
        raise exception 'Approved-cost invoice preview includes an unsupported fee line.';
      end if;
    elsif v_line_billable_cents <> 0 then
      raise exception 'Approved-cost invoice preview includes an unsupported line.';
    end if;
  end loop;

  if v_preview_cost_markup_fee_cents <> 0 and v_preview_cost_markup_fee_cents <> v_actual_markup_cents then
    raise exception 'Approved-cost invoice preview is stale. Refresh and try again.';
  end if;

  if v_preview_fixed_fee_cents <> v_allowed_fixed_fee_cents then
    raise exception 'Approved-cost invoice preview includes an unavailable earned fee.';
  end if;

  if v_preview_gross_line_cents <> v_actual_billable_cents + v_preview_fixed_fee_cents then
    raise exception 'Approved-cost invoice preview is stale. Refresh and try again.';
  end if;

  select id, coalesce(retainage_percent, 0)
    into v_contract_id, v_retainage_percent
    from public.contracts
    where org_id = p_org_id
      and project_id = p_project_id
      and status = 'active'
    order by created_at desc
    limit 1;

  if coalesce(v_retainage_percent, 0) > 0 then
    v_retainage_cents := round(greatest(v_actual_billable_cents, 0) * (v_retainage_percent / 100.0))::integer;
  end if;
  v_invoice_total_cents := v_preview_gross_line_cents - coalesce(v_retainage_cents, 0);
  v_cost_count := cardinality(p_cost_ids);

  v_invoice_preview := p_preview;
  select exists (
    select 1
    from jsonb_array_elements(coalesce(v_invoice_preview->'lines', '[]'::jsonb)) as preview_line(value)
    where coalesce(preview_line.value->>'unit', '') = 'retainage'
      or lower(coalesce(preview_line.value->>'description', '')) like 'retainage held%'
      or preview_line.value->'metadata'->>'system_generated_kind' = 'retainage_hold'
  ) into v_preview_has_retainage;

  if v_retainage_cents > 0 and not v_preview_has_retainage then
    v_invoice_preview := jsonb_set(
      v_invoice_preview,
      '{lines}',
      coalesce(v_invoice_preview->'lines', '[]'::jsonb) || jsonb_build_array(
        jsonb_build_object(
          'description', 'Retainage held (' || v_retainage_percent::text || '%)',
          'unit', 'retainage',
          'cost_cents', 0,
          'markup_cents', 0,
          'billable_cents', -abs(v_retainage_cents),
          'markup_percent', 0,
          'billable_cost_ids', '[]'::jsonb,
          'sort_order', jsonb_array_length(coalesce(v_invoice_preview->'lines', '[]'::jsonb)),
          'metadata', jsonb_build_object(
            'system_generated_kind', 'retainage_hold',
            'retainage_percent', v_retainage_percent,
            'retainage_amount_cents', v_retainage_cents
          )
        )
      )
    );
  end if;

  v_invoice_preview := jsonb_set(
    v_invoice_preview,
    '{totals}',
    jsonb_build_object(
      'cost_cents', v_actual_cost_cents,
      'markup_cents', v_actual_markup_cents,
      'earned_fee_cents', v_preview_fixed_fee_cents,
      'cost_billable_cents', v_actual_billable_cents,
      'gross_billable_cents', v_preview_gross_line_cents,
      'retainage_cents', v_retainage_cents,
      'billable_cents', v_invoice_total_cents
    )
  );

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
    v_invoice_total_cents,
    0,
    v_invoice_total_cents,
    v_invoice_total_cents,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'source_type', 'from_costs',
      'date_range', jsonb_build_object('from', p_from_date, 'to', p_to_date),
      'group_by', p_group_by,
      'cost_count', v_cost_count,
      'total_cost_cents', v_actual_cost_cents,
      'total_markup_cents', v_actual_markup_cents,
      'earned_fee_cents', case when v_preview_fixed_fee_cents > 0 then v_preview_fixed_fee_cents else null end,
      'gross_billable_cents', v_preview_gross_line_cents,
      'cost_billable_cents', v_actual_billable_cents,
      'retainage_percent', case when v_retainage_cents > 0 then v_retainage_percent else null end,
      'retainage_amount_cents', case when v_retainage_cents > 0 then v_retainage_cents else null end,
      'source_contract_id', v_contract_id,
      'idempotency_key', p_idempotency_key,
      'totals', jsonb_build_object(
        'subtotal_cents', v_invoice_total_cents,
        'tax_cents', 0,
        'total_cents', v_invoice_total_cents,
        'balance_due_cents', v_invoice_total_cents,
        'gross_billable_cents', v_preview_gross_line_cents,
        'cost_billable_cents', v_actual_billable_cents,
        'earned_fee_cents', v_preview_fixed_fee_cents,
        'retainage_cents', v_retainage_cents
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
    v_line_metadata := coalesce(v_line->'metadata', '{}'::jsonb);
    v_line_unit := lower(coalesce(v_line->>'unit', ''));
    v_line_kind := coalesce(v_line_metadata->>'fee_line_kind', '');
    v_line_cost_ids := coalesce(
      array(select jsonb_array_elements_text(coalesce(v_line->'billable_cost_ids', '[]'::jsonb))::uuid),
      '{}'::uuid[]
    );

    if v_line_unit = 'retainage' or v_line_metadata->>'system_generated_kind' = 'retainage_hold' then
      continue;
    end if;

    if cardinality(v_line_cost_ids) = 0 and not (v_line_unit = 'fee' and v_line_kind in ('cost_markup', 'fixed_fee_earned')) then
      continue;
    end if;

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
      case
        when coalesce(v_line->>'cost_code_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (v_line->>'cost_code_id')::uuid
        else null
      end,
      coalesce(v_line->>'description', case when v_line_unit = 'fee' then 'Builder''s fee' else 'Approved costs' end),
      1,
      coalesce(nullif(v_line->>'unit', ''), 'LS'),
      coalesce((v_line->>'billable_cents')::integer, 0),
      coalesce((v_line->>'sort_order')::integer, 0),
      v_line_metadata || jsonb_build_object(
        'source_type', 'from_costs',
        'billable_cost_ids', coalesce(v_line->'billable_cost_ids', '[]'::jsonb),
        'cost_cents', coalesce((v_line->>'cost_cents')::integer, 0),
        'markup_cents', coalesce((v_line->>'markup_cents')::integer, 0),
        'markup_percent', coalesce((v_line->>'markup_percent')::numeric, 0)
      )
    )
    returning id into v_line_id;

    if cardinality(v_line_cost_ids) > 0 then
      update public.billable_costs
         set invoice_id = v_invoice_id,
             invoice_line_id = v_line_id,
             status = 'billed',
             billed_at = now()
       where org_id = p_org_id
         and project_id = p_project_id
         and id = any(v_line_cost_ids)
         and id = any(p_cost_ids);
    end if;
  end loop;

  if v_retainage_cents > 0 then
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
      null,
      'Retainage held (' || v_retainage_percent::text || '%)',
      1,
      'retainage',
      -abs(v_retainage_cents),
      jsonb_array_length(coalesce(p_preview->'lines', '[]'::jsonb)),
      jsonb_build_object(
        'taxable', false,
        'system_generated_kind', 'retainage_hold',
        'retainage_percent', v_retainage_percent,
        'retainage_amount_cents', v_retainage_cents
      )
    );

    insert into public.retainage (
      org_id,
      project_id,
      contract_id,
      invoice_id,
      amount_cents,
      status,
      metadata
    )
    values (
      p_org_id,
      p_project_id,
      v_contract_id,
      v_invoice_id,
      v_retainage_cents,
      'held',
      jsonb_build_object(
        'source_type', 'from_costs',
        'gross_billable_cents', v_actual_billable_cents,
        'retainage_percent', v_retainage_percent
      )
    );
  end if;

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
      jsonb_build_object('invoiceId', v_invoice_id, 'invoicePreview', v_invoice_preview)
    )
    on conflict (org_id, scope, key)
    do update set response = excluded.response;
  end if;

  return jsonb_build_object('invoiceId', v_invoice_id, 'invoicePreview', v_invoice_preview);
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
