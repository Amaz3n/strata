-- RBAC Phase 1 (part A)
-- Add enum values required for platform/external role scopes.

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    where t.typnamespace = 'public'::regnamespace
      and t.typname = 'role_scope'
      and e.enumlabel = 'platform'
  ) then
    alter type public.role_scope add value 'platform';
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    where t.typnamespace = 'public'::regnamespace
      and t.typname = 'role_scope'
      and e.enumlabel = 'external'
  ) then
    alter type public.role_scope add value 'external';
  end if;
end
$$;
