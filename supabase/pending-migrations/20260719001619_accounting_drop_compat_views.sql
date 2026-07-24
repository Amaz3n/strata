-- Workstream 08 / Phase B3. Apply only after the Phase B application deploy
-- has been verified and no old server instance is serving traffic.
set lock_timeout = '5s';

drop view if exists public.qbo_sync_records;
drop view if exists public.qbo_connections;
drop function if exists public.qbo_claim_sync_create(uuid, uuid, text, uuid, interval);
drop table if exists public.qbo_connections_legacy;
alter table public.accounting_connections drop column if exists credentials;
drop index if exists public.accounting_sync_records_entity_idx;
alter table public.qbo_import_cost_code_mappings
  drop constraint if exists qbo_import_cost_code_mappings_unique;
