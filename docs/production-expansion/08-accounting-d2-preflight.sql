-- READ ONLY. Accounting D2 safety preflight for Patagonia Development LLC.
-- Every `blocking_*` value must be zero before the destructive D2 migration is
-- promoted. Never turn these checks into an UPDATE: conflicting neutral values
-- require review because the neutral value may be newer than the legacy cache.

with target as (
  select o.id as org_id, c.id as connection_id, c.external_account_id
  from public.orgs o
  join public.accounting_connections c
    on c.org_id = o.id and c.provider = 'qbo' and c.status = 'active'
  where o.name = 'Patagonia Development LLC'
)
select
  count(*) as active_target_rows,
  count(*) filter (where external_account_id = '9341456671106880') as expected_realm_rows
from target;

with target as (
  select o.id as org_id, c.id as connection_id
  from public.orgs o
  join public.accounting_connections c
    on c.org_id = o.id and c.provider = 'qbo' and c.status = 'active'
  where o.name = 'Patagonia Development LLC'
), blockers as (
  select 'blocking_invoice_identity' metric, count(*)::bigint value
  from public.invoices i cross join target t
  where i.org_id = t.org_id and nullif(i.qbo_id, '') is not null
    and not exists (
      select 1 from public.accounting_sync_records r
      where r.org_id = i.org_id and r.connection_id = t.connection_id
        and r.entity_type = 'invoice' and r.entity_id = i.id
        and r.external_id = i.qbo_id
    )
  union all
  select 'blocking_expense_identity', count(*)::bigint
  from public.project_expenses e cross join target t
  where e.org_id = t.org_id and nullif(e.qbo_id, '') is not null
    and not exists (
      select 1 from public.accounting_sync_records r
      where r.org_id = e.org_id and r.connection_id = t.connection_id
        and r.entity_type in ('project_expense', 'purchase') and r.entity_id = e.id
        and r.external_id = e.qbo_id
    )
  union all
  select 'blocking_bill_identity', count(*)::bigint
  from public.vendor_bills b cross join target t
  where b.org_id = t.org_id and nullif(b.qbo_id, '') is not null
    and not exists (
      select 1 from public.accounting_sync_records r
      where r.org_id = b.org_id and r.connection_id = t.connection_id
        and r.entity_type in ('bill', 'vendor_credit') and r.entity_id = b.id
        and r.external_id = b.qbo_id
    )
  union all
  select 'blocking_expense_coding', count(*)::bigint
  from public.project_expenses e cross join target t
  where e.org_id = t.org_id and (
    (e.qbo_expense_account_id is not null and e.accounting_coding#>>'{expense_account,id}' is distinct from e.qbo_expense_account_id)
    or (e.qbo_payment_account_id is not null and e.accounting_coding#>>'{payment_account,id}' is distinct from e.qbo_payment_account_id)
    or (e.qbo_ap_account_id is not null and e.accounting_coding#>>'{ap_account,id}' is distinct from e.qbo_ap_account_id)
    or (e.qbo_vendor_id is not null and coalesce(e.accounting_coding#>>'{counterparty,id}', e.accounting_coding#>>'{vendor,id}') is distinct from e.qbo_vendor_id)
    or (e.qbo_class_id is not null and coalesce(e.accounting_coding#>>'{dimensions,class,id}', e.accounting_coding#>>'{class,id}') is distinct from e.qbo_class_id)
    or (e.qbo_transaction_type is not null and e.accounting_coding->>'transaction_type' is distinct from e.qbo_transaction_type)
  )
  union all
  select 'blocking_bill_coding', count(*)::bigint
  from public.vendor_bills b cross join target t
  where b.org_id = t.org_id and (
    (b.qbo_expense_account_id is not null and b.accounting_coding#>>'{expense_account,id}' is distinct from b.qbo_expense_account_id)
    or (b.qbo_ap_account_id is not null and b.accounting_coding#>>'{ap_account,id}' is distinct from b.qbo_ap_account_id)
    or (b.qbo_vendor_id is not null and coalesce(b.accounting_coding#>>'{counterparty,id}', b.accounting_coding#>>'{vendor,id}') is distinct from b.qbo_vendor_id)
    or (b.qbo_class_id is not null and coalesce(b.accounting_coding#>>'{dimensions,class,id}', b.accounting_coding#>>'{class,id}') is distinct from b.qbo_class_id)
  )
  union all
  select 'blocking_project_mapping', count(*)::bigint
  from public.projects p cross join target t
  where p.org_id = t.org_id and (p.qbo_customer_id is not null or p.qbo_class_id is not null)
    and not exists (
      select 1 from public.accounting_entity_map m
      where m.org_id = p.org_id and m.connection_id = t.connection_id and m.project_id = p.id
        and (p.qbo_customer_id is null or m.dimensions#>>'{customer,id}' = p.qbo_customer_id)
        and (p.qbo_class_id is null or m.dimensions#>>'{class,id}' = p.qbo_class_id)
    )
  union all
  select 'blocking_company_vendor_link', count(*)::bigint
  from public.companies c cross join target t
  where c.org_id = t.org_id and c.qbo_vendor_id is not null
    and not exists (
      select 1 from public.accounting_counterparty_links l
      where l.org_id = c.org_id and l.connection_id = t.connection_id
        and l.role = 'vendor' and l.entity_type = 'company' and l.entity_id = c.id
        and l.external_id = c.qbo_vendor_id
    )
)
select metric, value from blockers order by metric;

-- PostgreSQL dependencies that must be explicitly rewritten/dropped before the
-- column drops. A non-empty result is a blocker; never bypass dependency checks.
with drop_tokens(token) as (values
  ('qbo_id'), ('qbo_synced_at'), ('qbo_sync_status'), ('qbo_sync_error'),
  ('qbo_transaction_type'), ('qbo_expense_account_id'), ('qbo_expense_account_name'),
  ('qbo_payment_account_id'), ('qbo_payment_account_name'), ('qbo_ap_account_id'),
  ('qbo_ap_account_name'), ('qbo_vendor_id'), ('qbo_vendor_name'),
  ('qbo_class_id'), ('qbo_class_name'), ('qbo_customer_id'), ('qbo_customer_name'),
  ('qbo_vendor_synced_at'), ('qbo_vendor_sync_status')
), definitions as (
  select 'routine' object_type, n.nspname || '.' || p.proname object_name,
    pg_get_functiondef(p.oid) definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
  union all
  select 'view', schemaname || '.' || viewname, definition
  from pg_views where schemaname = 'public'
  union all
  select 'index', schemaname || '.' || indexname, indexdef
  from pg_indexes where schemaname = 'public'
)
select distinct object_type, object_name
from definitions d
join drop_tokens t on d.definition ~ ('\\m' || t.token || '\\M')
order by object_type, object_name;
