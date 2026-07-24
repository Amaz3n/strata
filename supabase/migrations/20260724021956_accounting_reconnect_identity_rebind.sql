-- Reconnects to the same provider account must preserve Arc's connection-scoped
-- identities. Move dependent rows from inactive duplicate connections to the
-- active connection only when provider, org, and external account all match.
set lock_timeout = '5s';

with reconnect_pairs as (
  select old_connection.id as old_connection_id,
         active_connection.id as active_connection_id
  from public.accounting_connections old_connection
  join public.accounting_connections active_connection
    on active_connection.org_id = old_connection.org_id
   and active_connection.provider = old_connection.provider
   and active_connection.external_account_id = old_connection.external_account_id
   and active_connection.status = 'active'
   and active_connection.id <> old_connection.id
  where old_connection.status <> 'active'
)
update public.accounting_sync_records record
set connection_id = pair.active_connection_id,
    metadata = coalesce(record.metadata, '{}'::jsonb) || jsonb_build_object(
      'connection_rebound_from', pair.old_connection_id,
      'connection_rebound_at', now()
    )
from reconnect_pairs pair
where record.connection_id = pair.old_connection_id
  and not exists (
    select 1
    from public.accounting_sync_records active_record
    where active_record.org_id = record.org_id
      and active_record.connection_id = pair.active_connection_id
      and active_record.entity_type = record.entity_type
      and active_record.entity_id = record.entity_id
      and active_record.id <> record.id
  );

with reconnect_pairs as (
  select old_connection.id as old_connection_id,
         active_connection.id as active_connection_id
  from public.accounting_connections old_connection
  join public.accounting_connections active_connection
    on active_connection.org_id = old_connection.org_id
   and active_connection.provider = old_connection.provider
   and active_connection.external_account_id = old_connection.external_account_id
   and active_connection.status = 'active'
   and active_connection.id <> old_connection.id
  where old_connection.status <> 'active'
)
update public.accounting_counterparty_links link
set connection_id = pair.active_connection_id,
    metadata = coalesce(link.metadata, '{}'::jsonb) || jsonb_build_object(
      'connection_rebound_from', pair.old_connection_id,
      'connection_rebound_at', now()
    )
from reconnect_pairs pair
where link.connection_id = pair.old_connection_id
  and not exists (
    select 1
    from public.accounting_counterparty_links active_link
    where active_link.org_id = link.org_id
      and active_link.connection_id = pair.active_connection_id
      and active_link.role = link.role
      and active_link.entity_type = link.entity_type
      and active_link.entity_id = link.entity_id
      and active_link.id <> link.id
  );

with reconnect_pairs as (
  select old_connection.id as old_connection_id,
         active_connection.id as active_connection_id
  from public.accounting_connections old_connection
  join public.accounting_connections active_connection
    on active_connection.org_id = old_connection.org_id
   and active_connection.provider = old_connection.provider
   and active_connection.external_account_id = old_connection.external_account_id
   and active_connection.status = 'active'
   and active_connection.id <> old_connection.id
  where old_connection.status <> 'active'
)
update public.accounting_import_claims claim
set connection_id = pair.active_connection_id
from reconnect_pairs pair
where claim.connection_id = pair.old_connection_id
  and not exists (
    select 1
    from public.accounting_import_claims active_claim
    where active_claim.connection_id = pair.active_connection_id
      and active_claim.external_entity_type = claim.external_entity_type
      and active_claim.external_id = claim.external_id
      and active_claim.id <> claim.id
  );

with reconnect_pairs as (
  select old_connection.id as old_connection_id,
         active_connection.id as active_connection_id
  from public.accounting_connections old_connection
  join public.accounting_connections active_connection
    on active_connection.org_id = old_connection.org_id
   and active_connection.provider = old_connection.provider
   and active_connection.external_account_id = old_connection.external_account_id
   and active_connection.status = 'active'
   and active_connection.id <> old_connection.id
  where old_connection.status <> 'active'
)
update public.qbo_import_cost_code_mappings mapping
set connection_id = pair.active_connection_id
from reconnect_pairs pair
where mapping.connection_id = pair.old_connection_id
  and not exists (
    select 1
    from public.qbo_import_cost_code_mappings active_mapping
    where active_mapping.org_id = mapping.org_id
      and active_mapping.connection_id = pair.active_connection_id
      and active_mapping.qbo_ref_type = mapping.qbo_ref_type
      and active_mapping.qbo_ref_id = mapping.qbo_ref_id
      and active_mapping.id <> mapping.id
  );
