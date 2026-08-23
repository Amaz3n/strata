-- The directory stops classifying a party with a single type column.
--
-- `companies.company_type` and `contacts.contact_type` are two enums that do
-- not agree with each other (`supplier` vs `vendor`), are enforced nowhere in
-- the database, and can hold only ONE value — so a subcontractor who buys a
-- spec home, or a prospect who becomes a buyer and then a homeowner, has never
-- been representable. Every domain that needed a party in a relationship the
-- type column could not express grew its own table instead: `prospect_contacts`
-- shadows `contacts`, `vendor_entities` shadows `companies`.
--
-- A party is now a company or a contact. What it IS to this org is a SET of
-- roles with lifecycle state, drawn from `directory_relationship_types` — the
-- taxonomy table that has existed and been seeded since July but is written and
-- never read. This migration makes it the source of truth.
--
-- The type columns are deliberately left in place and still written. They are
-- dropped in a later gated migration once every reader has moved.

-- ── 1. Taxonomy: the roles the sales and design lifecycles always needed ───
-- `applies_to` is respected by the CHECK on party_roles below, so a role that
-- only makes sense for a person cannot be attached to a company.
insert into public.directory_relationship_types
  (org_id, key, label, canonical_category, applies_to, is_system, is_active, sort_order)
select
  o.id, seed.key, seed.label, seed.canonical_category, seed.applies_to, true, true, seed.sort_order
from public.orgs o
cross join (values
  ('prospect',  'Prospect',  'client',  'both',    100),
  ('buyer',     'Buyer',     'client',  'both',    101),
  ('homeowner', 'Homeowner', 'client',  'both',    102),
  ('agent',     'Agent',     'other',   'both',    103)
) as seed(key, label, canonical_category, applies_to, sort_order)
on conflict (org_id, key) do nothing;

-- ── 2. party_roles ─────────────────────────────────────────────────────────
create table if not exists public.party_roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  relationship_type_id uuid not null references public.directory_relationship_types(id) on delete restrict,
  -- One vocabulary, read against the role's canonical_category:
  --   vendor  → prospective → invited → active → inactive
  --   client  → inquiry → qualified → under_contract → closed → inactive
  --   design/internal/other → active | inactive
  -- Kept as one column because a role has exactly one state at a time and the
  -- resolver already knows the category; a per-category column would be four
  -- nullable columns where three are always null.
  status text not null default 'active'
    check (status in (
      'prospective','invited','active','inactive',
      'inquiry','qualified','under_contract','closed'
    )),
  since timestamptz not null default now(),
  until timestamptz,
  -- How the role got here. The promotion paths and the backfill both write it,
  -- and the merge review needs it to tell an imported guess from a human's call.
  source text not null default 'manual'
    check (source in ('manual','import','promotion','backfill','system')),
  notes text,
  -- No created_by: `recordAudit` is this codebase's actor record, and a column
  -- here would be a second, weaker answer to the same question.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint party_roles_exactly_one_party
    check (num_nonnulls(company_id, contact_id) = 1)
);

comment on table public.party_roles is
  'What a directory party is to this org. A set, not a scalar: a company can be a subcontractor and a client at once, and a person moves prospect → buyer → homeowner without changing rows in any other table.';
comment on column public.party_roles.until is
  'Set when a role ends without being deleted, so the history of a relationship survives. A role with until in the past is not current but is still evidence.';

-- One row per party per role. Deliberately NOT partial indexes: `nulls
-- distinct` (the default) means the company index never constrains contact rows
-- — every one of them has company_id null, and nulls never conflict — and vice
-- versa, so each index enforces exactly its own side. Full indexes are also
-- what ON CONFLICT can infer from a column list, which a partial index cannot,
-- and the role upsert in lib/services/party-roles.ts depends on that.
create unique index if not exists party_roles_company_type_uidx
  on public.party_roles (org_id, company_id, relationship_type_id);
create unique index if not exists party_roles_contact_type_uidx
  on public.party_roles (org_id, contact_id, relationship_type_id);

-- No separate (org_id, company_id) / (org_id, contact_id) indexes: the unique
-- indexes above lead with exactly those columns, so a btree prefix scan already
-- serves every "roles for this party" lookup the view and the resolver make.
--
-- This one earns its place on the FK: relationship_type_id is ON DELETE
-- RESTRICT, so deactivating a role type has to prove no rows reference it.
create index if not exists party_roles_type_idx
  on public.party_roles (org_id, relationship_type_id);

alter table public.party_roles enable row level security;
-- Mirrors companies/contacts/contact_company_links: membership at the row level,
-- `directory.read` / `directory.write` enforced in lib/services/party-roles.ts.
create policy party_roles_access on public.party_roles
  for all to authenticated
  using (((select auth.role()) = 'service_role') or public.is_org_member(org_id))
  with check (((select auth.role()) = 'service_role') or public.is_org_member(org_id));
grant select, insert, update, delete on public.party_roles to authenticated;
grant all on public.party_roles to service_role;
create trigger party_roles_set_updated_at
  before update on public.party_roles
  for each row execute function public.tg_set_updated_at();

-- ── 3. A role cannot contradict its taxonomy ───────────────────────────────
-- `applies_to` has been decorative until now. Enforcing it here is what makes
-- the resolver able to trust a role row without re-checking which side it is on.
create or replace function public.tg_party_roles_check_applies_to()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_applies_to text;
  v_type_org uuid;
begin
  select applies_to, org_id into v_applies_to, v_type_org
  from public.directory_relationship_types
  where id = new.relationship_type_id;

  if v_applies_to is null then
    raise exception 'Unknown directory relationship type %', new.relationship_type_id;
  end if;
  if v_type_org <> new.org_id then
    raise exception 'Relationship type belongs to a different organization';
  end if;
  if new.company_id is not null and v_applies_to = 'contact' then
    raise exception 'Relationship type % applies to people, not companies', new.relationship_type_id;
  end if;
  if new.contact_id is not null and v_applies_to = 'company' then
    raise exception 'Relationship type % applies to companies, not people', new.relationship_type_id;
  end if;
  return new;
end;
$$;

create trigger party_roles_check_applies_to
  before insert or update on public.party_roles
  for each row execute function public.tg_party_roles_check_applies_to();

-- ── 4. Backfill: the type columns become role rows ─────────────────────────
-- Nine companies carry a trade string where a type belongs ('plumbing',
-- 'roofing', 'appliances'…) because the CSV importer coerced anything it did
-- not recognize. Those are subcontractors whose trade was written to the wrong
-- column; the trade itself is recovered into directory_trades below.
insert into public.directory_trades (org_id, name, normalized_name, is_active, metadata)
select distinct
  c.org_id,
  initcap(c.company_type),
  public.directory_normalize_name(c.company_type),
  true,
  jsonb_build_object('source', 'company_type_backfill')
from public.companies c
where c.company_type is not null
  and c.company_type not in ('subcontractor','supplier','client','architect','engineer','other','vendor')
on conflict (org_id, normalized_name) do nothing;

update public.companies c
set trade_id = t.id,
    metadata = c.metadata || jsonb_build_object('trade', coalesce(c.metadata->>'trade', initcap(c.company_type))),
    company_type = 'subcontractor'
from public.directory_trades t
where t.org_id = c.org_id
  and t.normalized_name = public.directory_normalize_name(c.company_type)
  and c.company_type is not null
  and c.company_type not in ('subcontractor','supplier','client','architect','engineer','other','vendor');

-- The lone 'vendor' company is a supplier under the company vocabulary.
update public.companies set company_type = 'supplier' where company_type = 'vendor';

insert into public.party_roles (org_id, company_id, relationship_type_id, status, source, since)
select c.org_id, c.id, rt.id, 'active', 'backfill', c.created_at
from public.companies c
join public.directory_relationship_types rt
  on rt.org_id = c.org_id
 and rt.key = coalesce(nullif(c.company_type, ''), 'other')
where rt.applies_to in ('company', 'both')
on conflict do nothing;

-- Contacts whose type has no company-side equivalent map onto their own keys;
-- `vendor` and `consultant` are contact-only in the seeded taxonomy already.
insert into public.party_roles (org_id, contact_id, relationship_type_id, status, source, since)
select ct.org_id, ct.id, rt.id, 'active', 'backfill', ct.created_at
from public.contacts ct
join public.directory_relationship_types rt
  on rt.org_id = ct.org_id
 and rt.key = coalesce(nullif(ct.contact_type, ''), 'other')
where rt.applies_to in ('contact', 'both')
on conflict do nothing;

-- Anything the joins above could not classify still belongs in the directory.
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

-- If this org's money has run through a company, that company is a vendor
-- whatever anyone typed it as. `resolveCompanyPosture` has been inferring this
-- at read time ("vendor = not architect/engineer") precisely because the type
-- column could not be trusted; recording it as data is what lets the resolver
-- become pure role math. Zero rows qualify today — this exists so a company
-- created between now and apply, and every future one, is caught. The ongoing
-- guarantee is `ensureVendorRole` on the commitment path.
insert into public.party_roles (org_id, company_id, relationship_type_id, status, source, since)
select distinct c.org_id, c.id, rt.id, 'active', 'backfill', c.created_at
from public.companies c
join public.directory_relationship_types rt on rt.org_id = c.org_id and rt.key = 'subcontractor'
where (
    exists (select 1 from public.commitments m where m.company_id = c.id)
    or exists (select 1 from public.vendor_bills b where b.company_id = c.id)
  )
  and not exists (
    select 1 from public.party_roles pr
    join public.directory_relationship_types prt on prt.id = pr.relationship_type_id
    where pr.company_id = c.id and prt.canonical_category = 'vendor'
  )
on conflict do nothing;

-- ── 5. Buyers and prospects already in the sales tables earn their roles ───
-- A person who reserved a lot is a buyer whether or not anyone said so in the
-- directory, and this is what makes them findable there.
insert into public.party_roles (org_id, contact_id, relationship_type_id, status, source, since)
select distinct r.org_id, r.buyer_contact_id, rt.id, 'under_contract', 'backfill', r.created_at
from public.lot_reservations r
join public.directory_relationship_types rt on rt.org_id = r.org_id and rt.key = 'buyer'
where r.buyer_contact_id is not null
on conflict do nothing;

insert into public.party_roles (org_id, contact_id, relationship_type_id, status, source, since)
select distinct r.org_id, r.co_buyer_contact_id, rt.id, 'under_contract', 'backfill', r.created_at
from public.lot_reservations r
join public.directory_relationship_types rt on rt.org_id = r.org_id and rt.key = 'buyer'
where r.co_buyer_contact_id is not null
on conflict do nothing;

insert into public.party_roles (org_id, contact_id, relationship_type_id, status, source, since)
select distinct p.org_id, p.legacy_contact_id, rt.id, 'inquiry', 'backfill', p.created_at
from public.prospects p
join public.directory_relationship_types rt on rt.org_id = p.org_id and rt.key = 'prospect'
where p.legacy_contact_id is not null
on conflict do nothing;

insert into public.party_roles (org_id, contact_id, relationship_type_id, status, source, since)
select distinct pc.org_id, coalesce(pc.promoted_contact_id, pc.contact_id), rt.id, 'inquiry', 'backfill', pc.created_at
from public.prospect_contacts pc
join public.directory_relationship_types rt on rt.org_id = pc.org_id and rt.key = 'prospect'
where coalesce(pc.promoted_contact_id, pc.contact_id) is not null
on conflict do nothing;
