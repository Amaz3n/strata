-- Workstream 08 / Phase D2. Destructive cleanup: apply only after the Phase C
-- dual-read gate has remained at zero divergence for 14 days and new code is live.
set lock_timeout = '5s';
set statement_timeout = '120s';

update public.invoices
set metadata = metadata - 'qbo_customer_id'
where metadata ? 'qbo_customer_id';

create or replace function public.replace_invoice_lines_atomic(
  p_org_id uuid, p_invoice_id uuid, p_invoice_update jsonb, p_lines jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.invoices set
    invoice_number=coalesce(p_invoice_update->>'invoice_number',invoice_number),
    issue_date=coalesce((p_invoice_update->>'issue_date')::date,issue_date),
    due_date=coalesce((p_invoice_update->>'due_date')::date,due_date),
    notes=coalesce(p_invoice_update->>'notes',notes),
    status=coalesce(p_invoice_update->>'status',status),
    subtotal_cents=coalesce((p_invoice_update->>'subtotal_cents')::integer,subtotal_cents),
    tax_cents=coalesce((p_invoice_update->>'tax_cents')::integer,tax_cents),
    total_cents=coalesce((p_invoice_update->>'total_cents')::integer,total_cents),
    balance_due_cents=coalesce((p_invoice_update->>'balance_due_cents')::integer,balance_due_cents),
    updated_at=now()
  where org_id=p_org_id and id=p_invoice_id;
  if not found then raise exception 'Invoice not found'; end if;
  delete from public.invoice_lines where org_id=p_org_id and invoice_id=p_invoice_id;
  insert into public.invoice_lines (org_id,invoice_id,description,quantity,unit,unit_price_cents,metadata)
  select p_org_id,p_invoice_id,coalesce(line->>'description',''),
    coalesce((line->>'quantity')::numeric,1),line->>'unit',
    coalesce((line->>'unit_price_cents')::integer,0),coalesce(line->'metadata','{}'::jsonb)
  from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) line;
end;
$$;
revoke all on function public.replace_invoice_lines_atomic(uuid,uuid,jsonb,jsonb) from public;
grant execute on function public.replace_invoice_lines_atomic(uuid,uuid,jsonb,jsonb) to service_role;

drop index if exists public.invoices_qbo_sync_idx;
drop index if exists public.project_expenses_qbo_sync_idx;
drop index if exists public.vendor_bills_qbo_sync_idx;

alter table public.invoices
  drop column if exists qbo_id,
  drop column if exists qbo_synced_at,
  drop column if exists qbo_sync_status;
alter table public.project_expenses
  drop column if exists qbo_id,
  drop column if exists qbo_synced_at,
  drop column if exists qbo_sync_status,
  drop column if exists qbo_sync_error,
  drop column if exists qbo_transaction_type,
  drop column if exists qbo_expense_account_id,
  drop column if exists qbo_expense_account_name,
  drop column if exists qbo_payment_account_id,
  drop column if exists qbo_payment_account_name,
  drop column if exists qbo_ap_account_id,
  drop column if exists qbo_ap_account_name,
  drop column if exists qbo_vendor_id,
  drop column if exists qbo_vendor_name,
  drop column if exists qbo_class_id,
  drop column if exists qbo_class_name;
alter table public.vendor_bills
  drop column if exists qbo_id,
  drop column if exists qbo_synced_at,
  drop column if exists qbo_sync_status,
  drop column if exists qbo_sync_error,
  drop column if exists qbo_expense_account_id,
  drop column if exists qbo_expense_account_name,
  drop column if exists qbo_ap_account_id,
  drop column if exists qbo_ap_account_name,
  drop column if exists qbo_vendor_id,
  drop column if exists qbo_vendor_name,
  drop column if exists qbo_class_id,
  drop column if exists qbo_class_name;
alter table public.projects
  drop column if exists qbo_class_id,
  drop column if exists qbo_class_name,
  drop column if exists qbo_customer_id,
  drop column if exists qbo_customer_name;
alter table public.companies
  drop column if exists qbo_vendor_id,
  drop column if exists qbo_vendor_name,
  drop column if exists qbo_vendor_synced_at,
  drop column if exists qbo_vendor_sync_status;
