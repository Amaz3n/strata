-- Workstream 08: Supabase grants function EXECUTE through role defaults in some
-- projects. Explicitly limit internal accounting RPCs and trigger functions.
revoke execute on function public.accounting_claim_sync_create(uuid, uuid, text, uuid, interval)
  from anon, authenticated;
revoke execute on function public.qbo_claim_sync_create(uuid, uuid, text, uuid, interval)
  from anon, authenticated;
revoke execute on function public.update_qbo_cdc_cursor(uuid, timestamptz)
  from anon, authenticated;
revoke execute on function public.validate_accounting_entity_map_scope()
  from anon, authenticated;
revoke execute on function public.guard_accounting_project_reassignment()
  from anon, authenticated;

grant execute on function public.accounting_claim_sync_create(uuid, uuid, text, uuid, interval)
  to service_role;
grant execute on function public.qbo_claim_sync_create(uuid, uuid, text, uuid, interval)
  to service_role;
grant execute on function public.update_qbo_cdc_cursor(uuid, timestamptz)
  to service_role;
