-- Financials Trust & Billing Modes Refactor - Phase 2 follow-up
-- Keep the approved-cost invoice RPC callable by app users and service jobs, but not by anon/PUBLIC.

revoke execute on function public.create_invoice_from_billable_costs_atomic(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  date,
  date,
  date,
  date,
  text,
  uuid[],
  jsonb,
  text,
  uuid,
  text,
  boolean,
  text,
  text[],
  jsonb
) from public, anon, authenticated, service_role;

grant execute on function public.create_invoice_from_billable_costs_atomic(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  date,
  date,
  date,
  date,
  text,
  uuid[],
  jsonb,
  text,
  uuid,
  text,
  boolean,
  text,
  text[],
  jsonb
) to authenticated, service_role;
