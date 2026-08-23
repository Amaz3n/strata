-- Every org gets the base directory taxonomy, not just the ones that existed
-- in July.
--
-- `20260705035513_directory_intelligence_schema.sql` seeded the nine base
-- relationship types with a one-shot INSERT over the orgs alive at the time,
-- and nothing has seeded them since — org provisioning does not create them.
-- Two orgs created after that date ("Acme Production" and the QA acceptance
-- org) therefore had no `subcontractor`, `client` or `other` type at all.
--
-- That was invisible while `relationship_type_id` was write-only. The moment
-- `20260819140000` made roles the source of truth it stopped being cosmetic:
-- its backfill joins parties to their type by key, so eight companies in those
-- two orgs came out of it with NO role — which under pure role math means no
-- account tabs, no vendor lens, and no compliance watch.
--
-- This seeds the full set everywhere (idempotent) and then re-runs the same
-- backfill for any party still without a role.

insert into public.directory_relationship_types
  (org_id, key, label, canonical_category, applies_to, is_system, is_active, sort_order)
select
  o.id, seed.key, seed.label, seed.canonical_category, seed.applies_to, true, true, seed.sort_order
from public.orgs o
cross join (values
  ('subcontractor', 'Subcontractor', 'vendor',   'both',    10),
  ('supplier',      'Supplier',      'vendor',   'company', 20),
  ('vendor',        'Vendor',        'vendor',   'contact', 30),
  ('consultant',    'Consultant',    'vendor',   'contact', 40),
  ('client',        'Client',        'client',   'both',    50),
  ('architect',     'Architect',     'design',   'company', 60),
  ('engineer',      'Engineer',      'design',   'company', 70),
  ('internal',      'Internal',      'internal', 'contact', 80),
  ('other',         'Other',         'other',    'both',    90)
) as seed(key, label, canonical_category, applies_to, sort_order)
on conflict (org_id, key) do nothing;

-- Re-run the backfill for whatever the missing taxonomy stranded. Identical
-- rules to 20260819140000 §4; both are guarded so a party that already has its
-- role is untouched.
insert into public.party_roles (org_id, company_id, relationship_type_id, status, source, since)
select c.org_id, c.id, rt.id, 'active', 'backfill', c.created_at
from public.companies c
join public.directory_relationship_types rt
  on rt.org_id = c.org_id
 and rt.key = coalesce(nullif(c.company_type, ''), 'other')
where rt.applies_to in ('company', 'both')
  and not exists (select 1 from public.party_roles pr where pr.company_id = c.id)
on conflict do nothing;

insert into public.party_roles (org_id, contact_id, relationship_type_id, status, source, since)
select ct.org_id, ct.id, rt.id, 'active', 'backfill', ct.created_at
from public.contacts ct
join public.directory_relationship_types rt
  on rt.org_id = ct.org_id
 and rt.key = coalesce(nullif(ct.contact_type, ''), 'other')
where rt.applies_to in ('contact', 'both')
  and not exists (select 1 from public.party_roles pr where pr.contact_id = ct.id)
on conflict do nothing;

insert into public.party_roles (org_id, company_id, relationship_type_id, status, source, since)
select c.org_id, c.id, rt.id, 'active', 'backfill', c.created_at
from public.companies c
join public.directory_relationship_types rt on rt.org_id = c.org_id and rt.key = 'other'
where not exists (select 1 from public.party_roles pr where pr.company_id = c.id)
on conflict do nothing;

insert into public.party_roles (org_id, contact_id, relationship_type_id, status, source, since)
select ct.org_id, ct.id, rt.id, 'active', 'backfill', ct.created_at
from public.contacts ct
join public.directory_relationship_types rt on rt.org_id = ct.org_id and rt.key = 'other'
where not exists (select 1 from public.party_roles pr where pr.contact_id = ct.id)
on conflict do nothing;
