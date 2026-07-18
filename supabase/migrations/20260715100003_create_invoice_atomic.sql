-- Atomic invoice+lines creation.
--
-- createInvoice previously inserted the invoice header and its lines as two
-- separate statements with manual compensation (delete the header if the line
-- insert failed) — a crash between the two left a headerless/lineless invoice.
-- This RPC does both in one transaction. Validation, permission checks, and all
-- follow-up linking stay in lib/services/invoices.ts.

create or replace function public.create_invoice_atomic(
  p_org_id uuid,
  p_invoice jsonb,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
  v_line jsonb;
  v_line_id uuid;
  v_lines jsonb := '[]'::jsonb;
begin
  if p_org_id is null then
    raise exception 'org id is required';
  end if;

  -- Direct PostgREST callers must belong to the org; service-role calls
  -- (auth.uid() is null) are trusted, matching the other invoice RPCs.
  if auth.uid() is not null and not exists (
    select 1
    from public.memberships m
    where m.org_id = p_org_id
      and m.user_id = auth.uid()
  ) then
    raise exception 'Not authorized for this organization';
  end if;

  insert into public.invoices (
    org_id, project_id, token, invoice_number, title, status,
    issue_date, due_date, notes, client_visible,
    subtotal_cents, tax_cents, total_cents, balance_due_cents,
    source_type, source_draw_id, source_change_order_id, source_pay_application_id,
    metadata, sent_at, sent_to_emails
  )
  values (
    p_org_id,
    nullif(p_invoice->>'project_id', '')::uuid,
    nullif(p_invoice->>'token', ''),
    p_invoice->>'invoice_number',
    p_invoice->>'title',
    coalesce(nullif(p_invoice->>'status', ''), 'saved'),
    nullif(p_invoice->>'issue_date', '')::date,
    nullif(p_invoice->>'due_date', '')::date,
    nullif(p_invoice->>'notes', ''),
    coalesce((p_invoice->>'client_visible')::boolean, false),
    coalesce((p_invoice->>'subtotal_cents')::integer, 0),
    coalesce((p_invoice->>'tax_cents')::integer, 0),
    coalesce((p_invoice->>'total_cents')::integer, 0),
    coalesce((p_invoice->>'balance_due_cents')::integer, 0),
    nullif(p_invoice->>'source_type', ''),
    nullif(p_invoice->>'source_draw_id', '')::uuid,
    nullif(p_invoice->>'source_change_order_id', '')::uuid,
    nullif(p_invoice->>'source_pay_application_id', '')::uuid,
    coalesce(p_invoice->'metadata', '{}'::jsonb),
    nullif(p_invoice->>'sent_at', '')::timestamptz,
    case
      when p_invoice ? 'sent_to_emails' and jsonb_typeof(p_invoice->'sent_to_emails') = 'array'
        then (select array_agg(value) from jsonb_array_elements_text(p_invoice->'sent_to_emails'))
      else null
    end
  )
  returning * into v_invoice;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    insert into public.invoice_lines (
      org_id, invoice_id, cost_code_id, description, quantity, unit, unit_price_cents, metadata
    )
    values (
      p_org_id,
      v_invoice.id,
      nullif(v_line->>'cost_code_id', '')::uuid,
      coalesce(v_line->>'description', ''),
      coalesce((v_line->>'quantity')::numeric, 1),
      v_line->>'unit',
      coalesce((v_line->>'unit_price_cents')::integer, 0),
      coalesce(v_line->'metadata', '{}'::jsonb)
    )
    returning id into v_line_id;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('id', v_line_id, 'metadata', coalesce(v_line->'metadata', '{}'::jsonb))
    );
  end loop;

  return jsonb_build_object(
    'invoice', to_jsonb(v_invoice),
    'lines', v_lines
  );
end;
$$;

grant execute on function public.create_invoice_atomic(uuid, jsonb, jsonb) to authenticated, service_role;
