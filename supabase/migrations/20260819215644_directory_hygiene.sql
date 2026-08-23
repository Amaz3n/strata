-- Directory storage stops hiding facts in JSONB and stops modelling one
-- relationship two ways.
--
--   1. Archive state was `metadata->>'archived_at'` — unindexed, filtered on
--      every list query, and mutated by a non-atomic read-modify-write that
--      rewrites the whole blob.
--   2. A person's company was BOTH `contacts.primary_company_id` and a
--      `contact_company_links` row, so every reader had to union and dedupe
--      them by hand (six sites do exactly that today). The join table wins: it
--      is the only one of the two that can hold a person at two companies,
--      which is the normal case for a PM who moves subs or an agent at two
--      brokerages.
--   3. `company_type` / `contact_type` had no CHECK at all, which is how nine
--      trade strings ended up in `company_type` and forced every consumer to
--      guess. `20260819140000` cleaned those rows; this locks the door.

-- ── 1. Archive is a column ─────────────────────────────────────────────────
alter table public.companies add column if not exists archived_at timestamptz;
alter table public.contacts  add column if not exists archived_at timestamptz;

update public.companies
set archived_at = (metadata->>'archived_at')::timestamptz
where archived_at is null and metadata->>'archived_at' is not null;

update public.contacts
set archived_at = (metadata->>'archived_at')::timestamptz
where archived_at is null and metadata->>'archived_at' is not null;

-- Every directory list filters on this, so it leads the index.
create index if not exists companies_org_active_idx
  on public.companies (org_id, name) where archived_at is null;
create index if not exists contacts_org_active_idx
  on public.contacts (org_id, full_name) where archived_at is null;

comment on column public.companies.archived_at is
  'Soft delete. Replaces metadata->>archived_at, which could not be indexed and was rewritten as a whole JSONB blob on every archive.';

-- ── 2. One linkage between a person and a company ──────────────────────────
alter table public.contact_company_links
  add column if not exists is_primary boolean not null default false,
  add column if not exists title text;

comment on column public.contact_company_links.is_primary is
  'The company this person is reached at by default. Replaces contacts.primary_company_id, which could only ever hold one and duplicated this row.';
comment on column public.contact_company_links.title is
  'What this person does AT this company. A person can be an estimator at one and an owner at another, which a single contacts.role could not express.';

-- Every primary_company_id becomes a link row, marked primary.
insert into public.contact_company_links (org_id, contact_id, company_id, relationship, is_primary, title)
select c.org_id, c.id, c.primary_company_id, 'primary', true, c.role
from public.contacts c
where c.primary_company_id is not null
on conflict (contact_id, company_id) do update
  set is_primary = true,
      relationship = coalesce(contact_company_links.relationship, 'primary');

-- Links that predate the column and describe themselves as primary are primary.
update public.contact_company_links
set is_primary = true
where is_primary = false and relationship = 'primary';

-- The two sources above can disagree: a contact whose primary_company_id is A
-- while an older link to B already says relationship = 'primary' would end up
-- with two primaries and fail the index below. No row is in that state today,
-- but this migration is applied later than it is written, so it resolves the
-- conflict rather than assuming it away. contacts.primary_company_id wins —
-- it is what every reader has been treating as authoritative.
update public.contact_company_links l
set is_primary = false
where l.is_primary
  and exists (
    select 1 from public.contacts c
    where c.id = l.contact_id
      and c.primary_company_id is not null
      and c.primary_company_id <> l.company_id
  );

-- Anything still tied keeps its earliest link and demotes the rest, so the
-- index can be created unconditionally.
update public.contact_company_links l
set is_primary = false
where l.is_primary
  and l.id <> (
    select inner_link.id
    from public.contact_company_links inner_link
    where inner_link.contact_id = l.contact_id and inner_link.is_primary
    order by inner_link.created_at, inner_link.id
    limit 1
  );

-- At most one primary company per person.
create unique index if not exists contact_company_links_primary_uidx
  on public.contact_company_links (contact_id) where is_primary;
create index if not exists contact_company_links_company_idx
  on public.contact_company_links (org_id, company_id);
create index if not exists contact_company_links_contact_idx
  on public.contact_company_links (org_id, contact_id);

-- ── 3. The type columns can no longer hold a trade ─────────────────────────
-- Still written, still read, but now constrained. `party_roles` is the source
-- of truth; these become a denormalized convenience until the gated drop.
alter table public.companies
  drop constraint if exists companies_company_type_check;
alter table public.companies
  add constraint companies_company_type_check
    check (company_type is null or company_type in
      ('subcontractor','supplier','client','architect','engineer','other'));

alter table public.contacts
  drop constraint if exists contacts_contact_type_check;
alter table public.contacts
  add constraint contacts_contact_type_check
    check (contact_type is null or contact_type in
      ('internal','subcontractor','client','vendor','consultant','prospect','buyer','homeowner','agent'));

-- ── 4. Duplicate prevention where the data allows it ───────────────────────
-- Zero duplicate company names exist today, so this holds and stops the CSV
-- importer and the prospect-promotion path from creating the next one.
-- Contact email is deliberately NOT unique: four legitimate duplicate-email
-- groups exist (shared office addresses), so those go through the merge review
-- instead of being rejected at write time.
-- Fail with something an operator can act on. Postgres' own message for this
-- would name the index and one offending key, not which companies collided.
do $$
declare
  v_dupes text;
begin
  select string_agg(format('%s (org %s, %s rows)', nm, org_id, n), '; ')
  into v_dupes
  from (
    select org_id, public.directory_normalize_name(name) as nm, count(*) as n
    from public.companies
    where archived_at is null
    group by 1, 2
    having count(*) > 1
  ) d;

  if v_dupes is not null then
    raise exception
      'Cannot enforce unique company names — these collide: %. Merge or archive the duplicates, then re-run.', v_dupes;
  end if;
end $$;

create unique index if not exists companies_org_normalized_name_uidx
  on public.companies (org_id, public.directory_normalize_name(name))
  where archived_at is null;

create index if not exists contacts_org_email_idx
  on public.contacts (org_id, email) where email is not null and archived_at is null;

-- ── 5. The directory reads from one place ──────────────────────────────────
-- `listDirectoryPage` fetched offset+pageSize rows from BOTH tables, sorted
-- them in JavaScript and sliced — so cost grew with page number, sorting was
-- only correct within what had been fetched, and `total` was the sum of two
-- counts that did not describe the merged list. One view, one count, keyset-able.
create or replace view public.directory_entries
with (security_invoker = true)
as
select
  'company'::text as kind,
  c.id,
  c.org_id,
  c.name,
  public.directory_normalize_name(c.name) as sort_name,
  c.email,
  c.phone,
  t.name as trade,
  null::text as title,
  -- The secondary column the list shows and sorts on: a company's trade, a
  -- person's title. One column so a mixed list can order by something real.
  t.name as detail,
  null::uuid as primary_company_id,
  null::text as primary_company_name,
  c.archived_at,
  c.created_at,
  c.updated_at,
  coalesce(
    (select array_agg(distinct rt.key order by rt.key)
     from public.party_roles pr
     join public.directory_relationship_types rt on rt.id = pr.relationship_type_id
     where pr.company_id = c.id and pr.until is null),
    array[]::text[]
  ) as role_keys,
  coalesce(
    (select array_agg(distinct rt.canonical_category order by rt.canonical_category)
     from public.party_roles pr
     join public.directory_relationship_types rt on rt.id = pr.relationship_type_id
     where pr.company_id = c.id and pr.until is null),
    array[]::text[]
  ) as role_categories,
  -- Keys and categories are what the lens filters on (array overlap); this is
  -- what the row renders, because a role without its lifecycle state cannot say
  -- the difference between a prospect and a buyer.
  coalesce(
    (select jsonb_agg(jsonb_build_object('key', rt.key, 'label', rt.label, 'status', pr.status)
              order by rt.sort_order, rt.label)
     from public.party_roles pr
     join public.directory_relationship_types rt on rt.id = pr.relationship_type_id
     where pr.company_id = c.id and pr.until is null),
    '[]'::jsonb
  ) as role_states
from public.companies c
left join public.directory_trades t on t.id = c.trade_id
union all
select
  'contact'::text,
  ct.id,
  ct.org_id,
  ct.full_name,
  public.directory_normalize_name(ct.full_name),
  ct.email,
  ct.phone,
  null::text,
  ct.role,
  ct.role,
  link.company_id,
  comp.name,
  ct.archived_at,
  ct.created_at,
  ct.updated_at,
  coalesce(
    (select array_agg(distinct rt.key order by rt.key)
     from public.party_roles pr
     join public.directory_relationship_types rt on rt.id = pr.relationship_type_id
     where pr.contact_id = ct.id and pr.until is null),
    array[]::text[]
  ),
  coalesce(
    (select array_agg(distinct rt.canonical_category order by rt.canonical_category)
     from public.party_roles pr
     join public.directory_relationship_types rt on rt.id = pr.relationship_type_id
     where pr.contact_id = ct.id and pr.until is null),
    array[]::text[]
  ),
  coalesce(
    (select jsonb_agg(jsonb_build_object('key', rt.key, 'label', rt.label, 'status', pr.status)
              order by rt.sort_order, rt.label)
     from public.party_roles pr
     join public.directory_relationship_types rt on rt.id = pr.relationship_type_id
     where pr.contact_id = ct.id and pr.until is null),
    '[]'::jsonb
  )
from public.contacts ct
left join lateral (
  select l.company_id from public.contact_company_links l
  where l.contact_id = ct.id
  order by l.is_primary desc, l.created_at
  limit 1
) link on true
left join public.companies comp on comp.id = link.company_id;

comment on view public.directory_entries is
  'One row per directory party, company or person, with its current roles. security_invoker so the underlying org RLS on companies/contacts still applies to whoever selects from it.';

grant select on public.directory_entries to authenticated;
grant select on public.directory_entries to service_role;
