-- Workstream 08 follow-up: cover foreign keys used by deletes/joins and remove
-- direct API execution from a legacy SECURITY DEFINER trigger function.
set lock_timeout = '5s';
set statement_timeout = '120s';

create index if not exists accounting_connections_connected_by_idx
  on public.accounting_connections (connected_by);
create index if not exists accounting_entity_map_division_fk_idx
  on public.accounting_entity_map (division_id);
create index if not exists accounting_entity_map_community_fk_idx
  on public.accounting_entity_map (community_id);
create index if not exists accounting_entity_map_project_fk_idx
  on public.accounting_entity_map (project_id);
create index if not exists accounting_entity_map_created_by_idx
  on public.accounting_entity_map (created_by);
create index if not exists accounting_entity_map_reassignment_by_idx
  on public.accounting_entity_map (reassignment_acknowledged_by);

-- Trigger functions execute through their trigger and need no direct RPC grant.
revoke all on function public.sync_qbo_invoice_opening_payment() from public, anon, authenticated;
