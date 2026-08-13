-- Hosted projects may carry broad schema-level default table privileges. Make
-- the effective table grants match the service-only mutation design explicitly.

begin;

revoke all on table public.invoice_deliveries
  from public, anon, authenticated, service_role;
revoke all on table public.invoice_approval_requests
  from public, anon, authenticated, service_role;

grant select on table public.invoice_deliveries to authenticated;
grant select on table public.invoice_approval_requests to authenticated;

grant select, insert, update on table public.invoice_deliveries to service_role;
grant select, insert, update on table public.invoice_approval_requests to service_role;

commit;
