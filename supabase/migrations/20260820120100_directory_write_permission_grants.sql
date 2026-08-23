-- Make `directory.write` mean something.
--
-- Every directory mutation was gated on `org.member OR directory.write`, and
-- `org.member` is held by essentially every internal role — so `directory.write`
-- restricted nobody. An `org_user` seeded with read-only directory access
-- passed the write gate anyway.
--
-- lib/directory/permissions.ts now gates writes on `directory.write` alone.
-- This grants it to the roles that were relying on `org.member` and should keep
-- the capability, so the gate tightens without taking the directory away from
-- the people who maintain it.
--
-- Deliberately NOT granted: org_user (generic member — the leak this closes),
-- org_sales_agent, org_land_manager, org_starts_coordinator and
-- org_design_studio_coordinator. Those read the directory and act through
-- their own desks; vendor and client records are created by the people
-- accountable for paying and billing them.
--
-- Read stays open to any org member on purpose: vendor pickers, client pickers,
-- assignee lists and the command bar all need it.

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['directory.write']) p(permission_key)
where r.key in (
  'org_owner',          -- accountable for the whole org
  'org_office_admin',   -- does the directory data entry
  'org_project_lead',   -- PMs add subs as jobs staff up
  'org_superintendent'  -- field staff onboard a trade they just engaged
)
on conflict (role_id, permission_key) do nothing;

-- Roles that hold org.member but were never granted directory.read explicitly;
-- they read the directory today only because the read gate also accepts
-- org.member. Granting it makes the intent explicit and survives any future
-- tightening of the read gate.
insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['directory.read']) p(permission_key)
where r.key in (
  'org_owner',
  'org_office_admin',
  'org_project_lead',
  'org_superintendent',
  'org_starts_coordinator',
  'org_design_studio_coordinator'
)
on conflict (role_id, permission_key) do nothing;
