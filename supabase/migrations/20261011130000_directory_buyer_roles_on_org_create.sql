-- A new organisation's directory vocabulary is the whole default set, buyer roles included.
--
-- 20260819215425 added prospect, buyer, homeowner and agent to the taxonomy for the
-- orgs alive that day; 20261006112832 made org creation seed the base taxonomy but
-- copied only the nine original types. An org created since then has no `prospect`
-- role to promote an inquiry into, so registering a buyer fails with
-- `Unknown directory role "prospect"`. The seed function is the one list of
-- defaults; this redefines it with all thirteen, and runs it for every org so any
-- org missing any default type is completed. Existing rows (and any label an org
-- has renamed) are left alone.
begin;

create or replace function public.seed_org_directory_relationship_types(p_org_id uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.directory_relationship_types
    (org_id, key, label, canonical_category, applies_to, is_system, is_active, sort_order)
  select p_org_id, seed.key, seed.label, seed.canonical_category, seed.applies_to, true, true, seed.sort_order
  from (values
    ('subcontractor', 'Subcontractor', 'vendor',   'both',    10),
    ('supplier',      'Supplier',      'vendor',   'company', 20),
    ('vendor',        'Vendor',        'vendor',   'contact', 30),
    ('consultant',    'Consultant',    'vendor',   'contact', 40),
    ('client',        'Client',        'client',   'both',    50),
    ('architect',     'Architect',     'design',   'company', 60),
    ('engineer',      'Engineer',      'design',   'company', 70),
    ('internal',      'Internal',      'internal', 'contact', 80),
    ('other',         'Other',         'other',    'both',    90),
    ('prospect',      'Prospect',      'client',   'both',    100),
    ('buyer',         'Buyer',         'client',   'both',    101),
    ('homeowner',     'Homeowner',     'client',   'both',    102),
    ('agent',         'Agent',         'other',    'both',    103)
  ) as seed(key, label, canonical_category, applies_to, sort_order)
  on conflict (org_id, key) do nothing;
$$;
revoke all on function public.seed_org_directory_relationship_types(uuid) from public, anon, authenticated;

select public.seed_org_directory_relationship_types(o.id) from public.orgs o;

commit;
