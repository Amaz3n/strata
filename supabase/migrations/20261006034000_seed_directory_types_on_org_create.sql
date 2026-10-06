-- Every organisation needs the base directory taxonomy: party roles are the
-- source of truth (directory_party_roles), so an org without `vendor` or
-- `client` types cannot create a payable or invoice a customer ("Unknown
-- directory role"). 20260819215549 seeded the orgs alive that day, but org
-- provisioning never created them, so every later org (e.g. one created
-- 2026-10-02) starts broken. Seed on insert, and backfill whoever is missing.
begin;

create function public.seed_org_directory_relationship_types(p_org_id uuid)
returns void language sql security definer set search_path = public, pg_catalog as $$
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
    ('other',         'Other',         'other',    'both',    90)
  ) as seed(key, label, canonical_category, applies_to, sort_order)
  on conflict (org_id, key) do nothing;
$$;
revoke all on function public.seed_org_directory_relationship_types(uuid) from public, anon, authenticated;

create function public.tg_seed_org_directory_relationship_types()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  perform public.seed_org_directory_relationship_types(new.id);
  return new;
end $$;
revoke all on function public.tg_seed_org_directory_relationship_types() from public, anon, authenticated;

create trigger seed_org_directory_relationship_types after insert on public.orgs
for each row execute function public.tg_seed_org_directory_relationship_types();

select public.seed_org_directory_relationship_types(id) from public.orgs;

commit;
