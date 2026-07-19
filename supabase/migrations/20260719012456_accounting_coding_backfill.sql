-- Workstream 08 / Phase D1: neutral transaction coding and sync-ledger backfill.
set lock_timeout = '5s';
set statement_timeout = '120s';

alter table public.project_expenses
  add column if not exists accounting_coding jsonb not null default '{}'::jsonb;
alter table public.vendor_bills
  add column if not exists accounting_coding jsonb not null default '{}'::jsonb;

update public.project_expenses set accounting_coding = accounting_coding || jsonb_strip_nulls(jsonb_build_object(
  'expense_account', case when qbo_expense_account_id is not null then jsonb_build_object('id',qbo_expense_account_id,'name',qbo_expense_account_name) end,
  'payment_account', case when qbo_payment_account_id is not null then jsonb_build_object('id',qbo_payment_account_id,'name',qbo_payment_account_name) end,
  'ap_account', case when qbo_ap_account_id is not null then jsonb_build_object('id',qbo_ap_account_id,'name',qbo_ap_account_name) end,
  'vendor', case when vendor_company_id is null and qbo_vendor_id is not null then jsonb_build_object('id',qbo_vendor_id,'name',qbo_vendor_name) end,
  'class', case when qbo_class_id is not null then jsonb_build_object('id',qbo_class_id,'name',qbo_class_name) end
))
where qbo_expense_account_id is not null or qbo_payment_account_id is not null
   or qbo_ap_account_id is not null or qbo_vendor_id is not null or qbo_class_id is not null;

update public.vendor_bills set accounting_coding = accounting_coding || jsonb_strip_nulls(jsonb_build_object(
  'expense_account', case when qbo_expense_account_id is not null then jsonb_build_object('id',qbo_expense_account_id,'name',qbo_expense_account_name) end,
  'ap_account', case when qbo_ap_account_id is not null then jsonb_build_object('id',qbo_ap_account_id,'name',qbo_ap_account_name) end,
  'vendor', case when company_id is null and qbo_vendor_id is not null then jsonb_build_object('id',qbo_vendor_id,'name',qbo_vendor_name) end,
  'class', case when qbo_class_id is not null then jsonb_build_object('id',qbo_class_id,'name',qbo_class_name) end
))
where qbo_expense_account_id is not null or qbo_ap_account_id is not null
   or qbo_vendor_id is not null or qbo_class_id is not null;

update public.accounting_sync_records r
set metadata = coalesce(r.metadata, '{}'::jsonb)
  || jsonb_build_object('transaction_shape', e.qbo_transaction_type)
from public.project_expenses e
where r.org_id=e.org_id and r.entity_type='project_expense' and r.entity_id=e.id
  and e.qbo_transaction_type is not null
  and not (coalesce(r.metadata, '{}'::jsonb) ? 'transaction_shape');

with default_connection as (
  select distinct on (org_id) org_id, id
  from public.accounting_connections where status='active'
  order by org_id, connected_at, id
)
insert into public.accounting_sync_records (
  org_id, connection_id, provider, entity_type, entity_id, external_id,
  last_synced_at, status, metadata
)
select c.org_id, dc.id, 'qbo', 'vendor', c.id, c.qbo_vendor_id,
  coalesce(c.qbo_vendor_synced_at, now()),
  case c.qbo_vendor_sync_status when 'linked' then 'synced' when 'created' then 'synced'
    when 'needs_review' then 'needs_review' when 'error' then 'error' else 'synced' end,
  jsonb_build_object('display_name', c.qbo_vendor_name)
from public.companies c join default_connection dc on dc.org_id=c.org_id
where c.qbo_vendor_id is not null
on conflict (org_id, entity_type, entity_id) do nothing;

update public.invoices
set metadata = metadata
  || jsonb_build_object('accounting_customer_ref', metadata->'qbo_customer_id')
where metadata ? 'qbo_customer_id'
  and not (metadata ? 'accounting_customer_ref');
