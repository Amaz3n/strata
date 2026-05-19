-- Restore QBO account/vendor references expected by the AP vendor bill flows.

alter table if exists public.vendor_bills
  add column if not exists qbo_expense_account_id text,
  add column if not exists qbo_expense_account_name text,
  add column if not exists qbo_ap_account_id text,
  add column if not exists qbo_ap_account_name text,
  add column if not exists qbo_vendor_id text,
  add column if not exists qbo_vendor_name text;

create index if not exists vendor_bills_qbo_sync_idx
  on public.vendor_bills (org_id, qbo_sync_status)
  where qbo_sync_status is not null;

create index if not exists vendor_bills_qbo_id_idx
  on public.vendor_bills (org_id, qbo_id)
  where qbo_id is not null;
