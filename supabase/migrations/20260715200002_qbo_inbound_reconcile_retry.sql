do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.invoices'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%qbo_sync_status%';

  if constraint_name is not null then
    execute format('alter table public.invoices drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.invoices
  add constraint invoices_qbo_sync_status_check
  check (qbo_sync_status is null or qbo_sync_status in ('pending', 'synced', 'error', 'skipped', 'needs_review'));

alter table public.qbo_webhook_events
  add column if not exists attempts integer not null default 0,
  add column if not exists next_attempt_at timestamptz;

create index if not exists qbo_webhook_events_retry_idx
  on public.qbo_webhook_events (process_status, next_attempt_at, attempts, received_at);

create or replace function public.replace_invoice_lines_atomic(
  p_org_id uuid,
  p_invoice_id uuid,
  p_invoice_update jsonb,
  p_lines jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.invoices
  set
    invoice_number = coalesce(p_invoice_update->>'invoice_number', invoice_number),
    issue_date = coalesce((p_invoice_update->>'issue_date')::date, issue_date),
    due_date = coalesce((p_invoice_update->>'due_date')::date, due_date),
    notes = coalesce(p_invoice_update->>'notes', notes),
    status = coalesce(p_invoice_update->>'status', status),
    subtotal_cents = coalesce((p_invoice_update->>'subtotal_cents')::integer, subtotal_cents),
    tax_cents = coalesce((p_invoice_update->>'tax_cents')::integer, tax_cents),
    total_cents = coalesce((p_invoice_update->>'total_cents')::integer, total_cents),
    balance_due_cents = coalesce((p_invoice_update->>'balance_due_cents')::integer, balance_due_cents),
    qbo_id = coalesce(p_invoice_update->>'qbo_id', qbo_id),
    qbo_sync_status = coalesce(p_invoice_update->>'qbo_sync_status', qbo_sync_status),
    qbo_synced_at = coalesce((p_invoice_update->>'qbo_synced_at')::timestamptz, qbo_synced_at),
    updated_at = now()
  where org_id = p_org_id
    and id = p_invoice_id;

  if not found then
    raise exception 'Invoice not found';
  end if;

  delete from public.invoice_lines
  where org_id = p_org_id
    and invoice_id = p_invoice_id;

  insert into public.invoice_lines (
    org_id,
    invoice_id,
    description,
    quantity,
    unit,
    unit_price_cents,
    metadata
  )
  select
    p_org_id,
    p_invoice_id,
    coalesce(line->>'description', ''),
    coalesce((line->>'quantity')::numeric, 1),
    line->>'unit',
    coalesce((line->>'unit_price_cents')::integer, 0),
    coalesce(line->'metadata', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as line;
end;
$$;

grant execute on function public.replace_invoice_lines_atomic(uuid, uuid, jsonb, jsonb) to service_role;
