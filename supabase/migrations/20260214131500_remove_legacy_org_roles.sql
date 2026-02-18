-- Remove legacy org role keys once memberships are migrated.

begin;

do $$
begin
  if exists (
    select 1
    from public.memberships m
    join public.roles r on r.id = m.role_id
    where r.scope = 'org'
      and r.key in ('owner', 'admin', 'staff', 'readonly')
  ) then
    raise exception 'Cannot remove legacy org roles while memberships still reference them';
  end if;
end
$$;

delete from public.roles
where scope = 'org'
  and key in ('owner', 'admin', 'staff', 'readonly');

create or replace function public.is_org_admin_member(check_org_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.org_id = check_org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and r.scope = 'org'
      and r.key in ('org_owner', 'org_admin')
  );
$$;

comment on function public.is_org_admin_member(uuid)
  is 'Returns true when the current auth user has an active org_owner or org_admin membership.';

commit;
