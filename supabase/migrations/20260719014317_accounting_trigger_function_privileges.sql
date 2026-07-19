-- Trigger functions are invoked by their triggers and do not need Data API
-- EXECUTE privileges.
revoke all on function public.validate_accounting_entity_map_scope() from public, anon, authenticated;
revoke all on function public.guard_accounting_project_reassignment() from public, anon, authenticated;
