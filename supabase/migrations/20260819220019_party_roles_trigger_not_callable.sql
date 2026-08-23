-- A trigger function has no business being an RPC endpoint.
--
-- `tg_party_roles_check_applies_to()` is SECURITY DEFINER so the taxonomy check
-- cannot be defeated by what the caller happens to be able to SELECT. But
-- PostgREST exposes every executable function in `public` at
-- `/rest/v1/rpc/<name>`, so both `anon` and `authenticated` could invoke it
-- directly — flagged by the database linter as
-- `anon_security_definer_function_executable`.
--
-- Revoking EXECUTE does not stop the trigger: Postgres runs trigger functions
-- as part of the DML itself and never checks the invoking role's EXECUTE
-- privilege on them. This only closes the RPC door.
revoke execute on function public.tg_party_roles_check_applies_to() from public;
revoke execute on function public.tg_party_roles_check_applies_to() from anon;
revoke execute on function public.tg_party_roles_check_applies_to() from authenticated;
