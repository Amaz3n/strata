begin;
select plan(2);
select is(
  (select count(*)::integer from public.role_permissions rp join public.roles admin on admin.id = rp.role_id
   where admin.key = 'org_admin'
     and not exists (select 1 from public.role_permissions o join public.roles owner on owner.id = o.role_id
                     where owner.key = 'org_owner' and o.permission_key = rp.permission_key)),
  0, 'an owner holds every permission an admin holds');
select ok(exists (select 1 from public.role_permissions o join public.roles owner on owner.id = o.role_id
                  where owner.key = 'org_owner' and o.permission_key = 'drawing.read'), 'an owner can read drawings');
select * from finish();
rollback;
