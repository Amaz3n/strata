-- Remove legacy client role from internal project memberships.
-- Clients should access shared data through portal tokens, not project_members roles.

begin;

do $$
declare
  client_role_id uuid;
  fallback_role_id uuid;
begin
  select id
  into client_role_id
  from public.roles
  where scope = 'project'
    and key = 'client'
  limit 1;

  if client_role_id is null then
    return;
  end if;

  select id
  into fallback_role_id
  from public.roles
  where scope = 'project'
    and key in ('field', 'member', 'pm')
  order by case key when 'field' then 0 when 'member' then 1 else 2 end
  limit 1;

  if fallback_role_id is null then
    raise exception 'Cannot remove project role "client" because no fallback role exists (expected one of: field, member, pm).';
  end if;

  update public.project_members
  set role_id = fallback_role_id
  where role_id = client_role_id;

  delete from public.role_permissions
  where role_id = client_role_id;

  delete from public.roles
  where id = client_role_id;
end
$$;

commit;
