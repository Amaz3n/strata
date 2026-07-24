-- Complete the neutral accounting backfill without removing compatibility data.
-- Safe to apply before the application deploy: all writes are additive or make
-- the neutral ledger preserve an existing legacy review state.
set lock_timeout = '5s';
set statement_timeout = '120s';

-- Normalize the first D1 JSON shape (`vendor`/`class`) to the canonical runtime
-- shape (`counterparty`/`dimensions.class`) and fill all remaining references
-- from the still-present compatibility columns.
update public.project_expenses e
set accounting_coding =
  (coalesce(e.accounting_coding, '{}'::jsonb) - 'vendor' - 'class')
  || jsonb_strip_nulls(jsonb_build_object(
    'transaction_type',
      coalesce(e.accounting_coding->'transaction_type', to_jsonb(e.qbo_transaction_type)),
    'expense_account',
      coalesce(
        e.accounting_coding->'expense_account',
        case when e.qbo_expense_account_id is not null then
          jsonb_build_object('id', e.qbo_expense_account_id, 'name', e.qbo_expense_account_name)
        end
      ),
    'payment_account',
      coalesce(
        e.accounting_coding->'payment_account',
        case when e.qbo_payment_account_id is not null then
          jsonb_build_object('id', e.qbo_payment_account_id, 'name', e.qbo_payment_account_name)
        end
      ),
    'ap_account',
      coalesce(
        e.accounting_coding->'ap_account',
        case when e.qbo_ap_account_id is not null then
          jsonb_build_object('id', e.qbo_ap_account_id, 'name', e.qbo_ap_account_name)
        end
      ),
    'counterparty',
      coalesce(
        e.accounting_coding->'counterparty',
        e.accounting_coding->'vendor',
        case when e.vendor_company_id is null and e.qbo_vendor_id is not null then
          jsonb_build_object('id', e.qbo_vendor_id, 'name', e.qbo_vendor_name)
        end
      ),
    'dimensions',
      coalesce(e.accounting_coding->'dimensions', '{}'::jsonb)
      || case
        when coalesce(e.accounting_coding#>'{dimensions,class}', e.accounting_coding->'class') is not null
          then jsonb_build_object(
            'class',
            coalesce(e.accounting_coding#>'{dimensions,class}', e.accounting_coding->'class')
          )
        when e.qbo_class_id is not null
          then jsonb_build_object(
            'class',
            jsonb_build_object('id', e.qbo_class_id, 'name', e.qbo_class_name)
          )
        else '{}'::jsonb
      end
  ))
where e.accounting_coding ? 'vendor'
   or e.accounting_coding ? 'class'
   or (e.qbo_transaction_type is not null and e.accounting_coding->'transaction_type' is null)
   or (e.qbo_expense_account_id is not null and e.accounting_coding->'expense_account' is null)
   or (e.qbo_payment_account_id is not null and e.accounting_coding->'payment_account' is null)
   or (e.qbo_ap_account_id is not null and e.accounting_coding->'ap_account' is null)
   or (e.vendor_company_id is null and e.qbo_vendor_id is not null and e.accounting_coding->'counterparty' is null)
   or (e.qbo_class_id is not null and e.accounting_coding#>'{dimensions,class}' is null);

update public.vendor_bills b
set accounting_coding =
  (coalesce(b.accounting_coding, '{}'::jsonb) - 'vendor' - 'class')
  || jsonb_strip_nulls(jsonb_build_object(
    'expense_account',
      coalesce(
        b.accounting_coding->'expense_account',
        case when b.qbo_expense_account_id is not null then
          jsonb_build_object('id', b.qbo_expense_account_id, 'name', b.qbo_expense_account_name)
        end
      ),
    'ap_account',
      coalesce(
        b.accounting_coding->'ap_account',
        case when b.qbo_ap_account_id is not null then
          jsonb_build_object('id', b.qbo_ap_account_id, 'name', b.qbo_ap_account_name)
        end
      ),
    'counterparty',
      coalesce(
        b.accounting_coding->'counterparty',
        b.accounting_coding->'vendor',
        case when b.company_id is null and b.qbo_vendor_id is not null then
          jsonb_build_object('id', b.qbo_vendor_id, 'name', b.qbo_vendor_name)
        end
      ),
    'dimensions',
      coalesce(b.accounting_coding->'dimensions', '{}'::jsonb)
      || case
        when coalesce(b.accounting_coding#>'{dimensions,class}', b.accounting_coding->'class') is not null
          then jsonb_build_object(
            'class',
            coalesce(b.accounting_coding#>'{dimensions,class}', b.accounting_coding->'class')
          )
        when b.qbo_class_id is not null
          then jsonb_build_object(
            'class',
            jsonb_build_object('id', b.qbo_class_id, 'name', b.qbo_class_name)
          )
        else '{}'::jsonb
      end
  ))
where b.accounting_coding ? 'vendor'
   or b.accounting_coding ? 'class'
   or (b.qbo_expense_account_id is not null and b.accounting_coding->'expense_account' is null)
   or (b.qbo_ap_account_id is not null and b.accounting_coding->'ap_account' is null)
   or (b.company_id is null and b.qbo_vendor_id is not null and b.accounting_coding->'counterparty' is null)
   or (b.qbo_class_id is not null and b.accounting_coding#>'{dimensions,class}' is null);

-- Preserve legacy needs-review semantics in the canonical ledger. Legacy
-- `skipped` remains represented as status=synced + pushable=false.
update public.accounting_sync_records r
set status = 'needs_review',
    error_message = coalesce(r.error_message, e.qbo_sync_error),
    metadata = coalesce(r.metadata, '{}'::jsonb)
      || jsonb_build_object('legacy_review_state_preserved_at', now())
from public.project_expenses e
where r.org_id = e.org_id
  and r.entity_id = e.id
  and r.entity_type in ('project_expense', 'purchase')
  and r.external_id = e.qbo_id
  and e.qbo_sync_status = 'needs_review'
  and r.status is distinct from 'needs_review';

update public.accounting_sync_records r
set status = 'needs_review',
    error_message = coalesce(r.error_message, b.qbo_sync_error),
    metadata = coalesce(r.metadata, '{}'::jsonb)
      || jsonb_build_object('legacy_review_state_preserved_at', now())
from public.vendor_bills b
where r.org_id = b.org_id
  and r.entity_id = b.id
  and r.entity_type in ('bill', 'vendor_credit')
  and r.external_id = b.qbo_id
  and b.qbo_sync_status = 'needs_review'
  and r.status is distinct from 'needs_review';

-- Choose a deterministic historical connection for organizations that no
-- longer have an active connection: active first, then the connection already
-- owning the most sync records, then the most recently connected row.
with connection_usage as (
  select c.id, c.org_id, c.provider, c.status, c.connected_at, count(r.id) as sync_rows
  from public.accounting_connections c
  left join public.accounting_sync_records r
    on r.org_id = c.org_id and r.connection_id = c.id
  where c.provider = 'qbo'
  group by c.id, c.org_id, c.provider, c.status, c.connected_at
), preferred_connection as (
  select distinct on (org_id) id, org_id, provider
  from connection_usage
  order by org_id, (status = 'active') desc, sync_rows desc, connected_at desc, id
)
insert into public.accounting_entity_map (
  org_id, connection_id, project_id, dimensions
)
select p.org_id, c.id, p.id,
  jsonb_strip_nulls(jsonb_build_object(
    'class', case when p.qbo_class_id is not null then
      jsonb_build_object('id', p.qbo_class_id, 'name', p.qbo_class_name) end,
    'customer', case when p.qbo_customer_id is not null then
      jsonb_build_object('id', p.qbo_customer_id, 'name', p.qbo_customer_name) end
  ))
from public.projects p
join preferred_connection c on c.org_id = p.org_id
where p.qbo_class_id is not null or p.qbo_customer_id is not null
on conflict (org_id, project_id) where project_id is not null do nothing;

with connection_usage as (
  select c.id, c.org_id, c.provider, c.status, c.connected_at, count(r.id) as sync_rows
  from public.accounting_connections c
  left join public.accounting_sync_records r
    on r.org_id = c.org_id and r.connection_id = c.id
  where c.provider = 'qbo'
  group by c.id, c.org_id, c.provider, c.status, c.connected_at
), preferred_connection as (
  select distinct on (org_id) id, org_id, provider
  from connection_usage
  order by org_id, (status = 'active') desc, sync_rows desc, connected_at desc, id
)
insert into public.accounting_counterparty_links (
  org_id, connection_id, provider, role, entity_type, entity_id,
  external_id, external_name, status, last_synced_at
)
select c.org_id, pc.id, pc.provider, 'vendor', 'company', c.id,
  c.qbo_vendor_id, c.qbo_vendor_name,
  case c.qbo_vendor_sync_status
    when 'needs_review' then 'needs_review'
    when 'error' then 'error'
    else 'synced'
  end,
  c.qbo_vendor_synced_at
from public.companies c
join preferred_connection pc on pc.org_id = c.org_id
where c.qbo_vendor_id is not null
on conflict (org_id, connection_id, role, entity_type, entity_id)
do update set
  external_id = excluded.external_id,
  external_name = excluded.external_name,
  status = excluded.status,
  last_synced_at = excluded.last_synced_at,
  updated_at = now();
