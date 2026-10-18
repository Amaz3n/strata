-- Which of the given migration versions this database has applied (EP14-08).
--
-- Feature flags that switch on a database path (lib/schema-flags.ts) name the
-- migrations that path needs. Before a flagged path runs, the server asks this
-- function which of those versions the ledger holds, and refuses loudly when any
-- is missing, so turning a flag on ahead of its migration fails at the switch
-- instead of half-way through a customer's request.
--
-- Read-only, service_role only: the ledger is deployment metadata, not tenant data.
-- Lock risk: none (one new function).

create or replace function public.applied_migration_versions(p_versions text[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.version order by m.version), '{}'::text[])
  from supabase_migrations.schema_migrations m
  where m.version = any(p_versions)
$$;

revoke all on function public.applied_migration_versions(text[]) from public, anon, authenticated;
grant execute on function public.applied_migration_versions(text[]) to service_role;
