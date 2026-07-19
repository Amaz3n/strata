-- Workstream 08 advisor follow-up for QBO-specific tables intentionally retained
-- outside the provider-neutral core.
set lock_timeout = '5s';
set statement_timeout = '120s';

create index if not exists qbo_connections_legacy_connected_by_idx
  on public.qbo_connections_legacy (connected_by);
create index if not exists qbo_import_cost_code_mappings_created_by_idx
  on public.qbo_import_cost_code_mappings (created_by);
create index if not exists qbo_import_cost_code_mappings_updated_by_idx
  on public.qbo_import_cost_code_mappings (updated_by);
create index if not exists qbo_invoice_reservations_reserved_by_idx
  on public.qbo_invoice_reservations (reserved_by);
create index if not exists qbo_invoice_reservations_used_by_invoice_idx
  on public.qbo_invoice_reservations (used_by_invoice_id);
