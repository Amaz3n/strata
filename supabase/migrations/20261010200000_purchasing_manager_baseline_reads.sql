-- The production purchasing manager role was seeded with only its purchasing
-- keys. It held neither `org.member` nor `project.read`, so every project-scoped
-- check denied it (hasAllProjectAccess needs project.read) and its own
-- /purchasing desk refused. Grant the baseline read set every other production
-- desk role already carries (starts coordinator, superintendent), plus the
-- cost-side reads the desk's price book and variance tabs use. No write keys,
-- no admin keys.
--
--   org_purchasing_manager += org.member, org.read, project.read,
--                             directory.read, budget.read, report.read,
--                             schedule.read
--
-- Design coordinator, starts, sales, land, superintendent and warranty already
-- hold org.member + org.read + project.read in production; unchanged.

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array[
  'org.member','org.read','project.read','directory.read','budget.read','report.read','schedule.read'
]) p(permission_key)
where r.key = 'org_purchasing_manager'
on conflict (role_id, permission_key) do nothing;
