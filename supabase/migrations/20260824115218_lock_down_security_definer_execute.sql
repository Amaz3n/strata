-- Close the SECURITY DEFINER RPC surface to the PostgREST roles.
--
-- Postgres grants EXECUTE on new functions to PUBLIC, so every SECURITY DEFINER
-- function in `public` has been reachable as `/rest/v1/rpc/<name>` by anyone
-- holding the publishable anon key. That includes the money-mutating family —
-- apply_invoice_payment_atomic, apply_invoice_late_fee_atomic, post_pay_application,
-- release_project_retainage_atomic, replace_invoice_lines_atomic and the rest —
-- which take p_org_id as an argument and trust it. They run as the definer, so
-- RLS does not contain them: the argument IS the tenant scope.
--
-- Every one of those is called from server code through the service-role client,
-- which holds an explicit EXECUTE grant on all 95 of these functions and so is
-- unaffected. Revoking the caller-facing grants removes the exposure without
-- touching a single working call path.
--
-- Two categories keep their grants, both deliberate:
--
--   * RLS policy helpers (is_org_member and friends). A policy expression is
--     evaluated as the querying role, so `authenticated` genuinely needs EXECUTE
--     or every policy that calls one starts erroring. They key off auth.uid()
--     and return false for a caller with no session, so leaving `anon` on them
--     leaks nothing and keeps anonymous reads returning empty instead of 42501.
--   * The two functions the browser calls directly against the session-scoped
--     client: get_user_sessions and revoke_user_session, both of which scope
--     themselves to auth.uid() internally.

set lock_timeout = '5s';
set statement_timeout = '60s';

do $$
declare
  fn record;
  -- Safe for a caller with no session; policies depend on them resolving.
  rls_helpers constant text[] := array[
    'is_org_member',
    'is_org_admin_member',
    'is_project_member',
    'has_org_permission',
    'shares_org_with_current_user',
    'can_manage_members'
  ];
  -- Called from the browser with the user's own session.
  session_scoped constant text[] := array[
    'get_user_sessions',
    'revoke_user_session'
  ];
begin
  for fn in
    select p.oid,
           p.proname,
           pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and not (p.proname = any(rls_helpers))
      and not (p.proname = any(session_scoped))
  loop
    execute format(
      'revoke all on function public.%I(%s) from public, anon, authenticated',
      fn.proname,
      fn.args
    );
  end loop;

  -- The helpers stay reachable, but only through the two PostgREST roles that
  -- have a reason to evaluate them — not PUBLIC at large.
  for fn in
    select p.oid,
           p.proname,
           pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and (p.proname = any(rls_helpers) or p.proname = any(session_scoped))
  loop
    execute format('revoke all on function public.%I(%s) from public', fn.proname, fn.args);
    execute format('grant execute on function public.%I(%s) to authenticated', fn.proname, fn.args);
    if fn.proname = any(rls_helpers) then
      execute format('grant execute on function public.%I(%s) to anon', fn.proname, fn.args);
    end if;
  end loop;
end
$$;

-- Stop the hole reopening. Without this every future CREATE FUNCTION grants
-- EXECUTE to PUBLIC again and the next SECURITY DEFINER function ships exposed.
-- A function that genuinely needs a caller-facing grant now has to say so.
--
-- Default privileges can only be altered for a role you are a member of, and
-- which role runs a migration differs between the CLI, the dashboard and the
-- management API. Skip the ones this session cannot change rather than failing
-- the whole migration — the revocations above are the part that must land.
do $$
declare
  owner_role text;
begin
  foreach owner_role in array array[current_user, 'postgres'] loop
    if exists (select 1 from pg_roles where rolname = owner_role) then
      begin
        execute format(
          'alter default privileges for role %I in schema public revoke execute on functions from public',
          owner_role
        );
      exception
        when insufficient_privilege then
          raise notice 'Skipped default privileges for %: not a member of that role', owner_role;
      end;
    end if;
  end loop;
end
$$;
