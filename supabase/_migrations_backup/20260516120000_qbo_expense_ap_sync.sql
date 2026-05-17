-- QBO AP/expense sync foundation.
-- Keeps Arc receipts/approvals distinct from the accounting transaction posted to QBO.

alter table if exists public.project_expenses
  add column if not exists qbo_id text,
  add column if not exists qbo_synced_at timestamptz,
  add column if not exists qbo_sync_status text check (
    qbo_sync_status is null or qbo_sync_status in ('pending','synced','error','skipped','needs_review')
  ),
  add column if not exists qbo_transaction_type text check (
    qbo_transaction_type is null or qbo_transaction_type in ('purchase','bill')
  ),
  add column if not exists qbo_expense_account_id text,
  add column if not exists qbo_expense_account_name text,
  add column if not exists qbo_payment_account_id text,
  add column if not exists qbo_payment_account_name text,
  add column if not exists qbo_ap_account_id text,
  add column if not exists qbo_ap_account_name text,
  add column if not exists qbo_vendor_id text,
  add column if not exists qbo_vendor_name text,
  add column if not exists qbo_sync_error text;

create index if not exists project_expenses_qbo_sync_idx
  on public.project_expenses (org_id, qbo_sync_status)
  where qbo_sync_status is not null;

create index if not exists project_expenses_qbo_id_idx
  on public.project_expenses (org_id, qbo_id)
  where qbo_id is not null;

alter table if exists public.vendor_bills
  add column if not exists qbo_id text,
  add column if not exists qbo_synced_at timestamptz,
  add column if not exists qbo_sync_status text check (
    qbo_sync_status is null or qbo_sync_status in ('pending','synced','error','skipped','needs_review')
  ),
  add column if not exists qbo_expense_account_id text,
  add column if not exists qbo_expense_account_name text,
  add column if not exists qbo_ap_account_id text,
  add column if not exists qbo_ap_account_name text,
  add column if not exists qbo_vendor_id text,
  add column if not exists qbo_vendor_name text,
  add column if not exists qbo_sync_error text;

create index if not exists vendor_bills_qbo_sync_idx
  on public.vendor_bills (org_id, qbo_sync_status)
  where qbo_sync_status is not null;

create index if not exists vendor_bills_qbo_id_idx
  on public.vendor_bills (org_id, qbo_id)
  where qbo_id is not null;

alter table if exists public.qbo_sync_records
  drop constraint if exists qbo_sync_records_entity_type_check;

alter table if exists public.qbo_sync_records
  add constraint qbo_sync_records_entity_type_check check (
    entity_type in (
      'invoice',
      'payment',
      'customer',
      'item',
      'vendor',
      'vendor_bill',
      'project_expense',
      'purchase',
      'bill',
      'bill_payment',
      'purchase_order',
      'vendor_credit',
      'account'
    )
  );
