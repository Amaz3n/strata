begin;
-- Workstream 08 / Phase D2. Destructive cleanup: apply only after the Phase C
-- dual-read gate has remained at zero divergence for 14 days and new code is live.
set lock_timeout = '5s';
set statement_timeout = '120s';

select public.assert_accounting_d2_ready();

-- Current neutral routine replacements must already be deployed. This file never
-- redefines a financial routine from a historical implementation.
-- Persisted acceptance and explicit operator approval remain required.
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

commit;
