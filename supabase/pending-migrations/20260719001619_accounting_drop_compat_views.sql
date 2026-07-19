-- Workstream 08 / Phase B3. Apply only after the Phase B application deploy
-- has been verified and no old server instance is serving traffic.
set lock_timeout = '5s';

drop view if exists public.qbo_sync_records;
drop view if exists public.qbo_connections;
drop function if exists public.qbo_claim_sync_create(uuid, uuid, text, uuid, interval);
drop table if exists public.qbo_connections_legacy;
