-- Owner decision (EP09/EP10): the superintendent sees the scope and confirmed
-- options released to a home, never prices. The released-to-home page used to gate
-- those sections on `commitment.read` and `selections.read`, but both keys also
-- open amounts (commitment values, PO positions, the cash forecast; selected and
-- allowance prices), and superintendents deliberately lack them. Two price-free
-- keys gate only the released-to-home sections:
--
--   commitment.scope.read    awarded scope titles and lines, no amounts
--   selections.released.read confirmed option names, no prices
--
-- Every role that holds the broad key keeps the same view through the new one,
-- and the superintendent role gains the new keys only.

insert into public.permissions (key, description) values
  ('commitment.scope.read', 'View the awarded scope released to a home (no amounts)'),
  ('selections.released.read', 'View the confirmed options released to a home (no prices)')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select rp.role_id, 'commitment.scope.read' from public.role_permissions rp where rp.permission_key = 'commitment.read'
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select rp.role_id, 'selections.released.read' from public.role_permissions rp where rp.permission_key = 'selections.read'
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['commitment.scope.read','selections.released.read']) p(permission_key)
where r.key = 'org_superintendent'
on conflict (role_id, permission_key) do nothing;
