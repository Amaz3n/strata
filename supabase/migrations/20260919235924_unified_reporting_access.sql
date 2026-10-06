-- Reports can contain privileged Books/margin data. The server evaluates the
-- current definition and project permissions for every read, export and run.
-- A broad report.read Data API policy cannot express that contract safely.
revoke all on public.report_runs, public.saved_report_configs, public.report_schedules from anon, authenticated;
grant select, insert, update, delete on public.saved_report_configs, public.report_schedules to service_role;
grant select, insert on public.report_runs to service_role;

-- Claim delivery without moving the occurrence date; retries reuse its snapshot
-- and email idempotency key, even after a worker stops unexpectedly.
alter table public.report_schedules
  add column if not exists delivery_claimed_until timestamptz,
  add column if not exists last_error text,
  add column if not exists delivery_payload jsonb;
