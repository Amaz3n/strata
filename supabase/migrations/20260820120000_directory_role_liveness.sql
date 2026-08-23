-- Directory role liveness: one definition, shared by SQL and TypeScript.
--
-- Three answers to "is this role current?" disagreed:
--   * lib/directory/roles.ts honoured a future `until` and ignored `status`
--   * directory_entries tested `until is null` and ignored `status`
--   * resolvePartyCapabilities ignored `status` too
--
-- So a vendor marked `inactive` kept its account tabs and stayed on the
-- compliance watch list, and a role scheduled to end disappeared from the list
-- while staying live everywhere else. The directory decides who Arc pays, so
-- the list and the account page have to agree.
--
-- `directory_role_is_live` is the SQL half of `isCurrentRole` in
-- lib/directory/roles.ts. The two must move together.

-- ── 1. The predicate ───────────────────────────────────────────────────────
-- STABLE, not IMMUTABLE: it reads now(). That is fine for a view, and it is
-- why role liveness is not itself indexable — the indexes below narrow on the
-- columns instead.
create or replace function public.directory_role_is_live(
  p_status text,
  p_until timestamptz
)
returns boolean
language sql
stable
as $$
  -- `inactive` and `closed` are exits. `prospective`, `invited`, `inquiry`,
  -- `qualified` and `under_contract` are stages on the way in, and stay live.
  select p_status is distinct from 'inactive'
     and p_status is distinct from 'closed'
     and (p_until is null or p_until > now());
$$;

comment on function public.directory_role_is_live(text, timestamptz) is
  'Whether a party_roles row counts as a current relationship. SQL half of isCurrentRole() in lib/directory/roles.ts — change both together.';

grant execute on function public.directory_role_is_live(text, timestamptz) to authenticated;
grant execute on function public.directory_role_is_live(text, timestamptz) to service_role;

-- ── 2. The view uses it ────────────────────────────────────────────────────
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
     where pr.company_id = c.id
       and public.directory_role_is_live(pr.status, pr.until)),
    array[]::text[]
  ) as role_keys,
  coalesce(
    (select array_agg(distinct rt.canonical_category order by rt.canonical_category)
     from public.party_roles pr
     join public.directory_relationship_types rt on rt.id = pr.relationship_type_id
     where pr.company_id = c.id
       and public.directory_role_is_live(pr.status, pr.until)),
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
     where pr.company_id = c.id
       and public.directory_role_is_live(pr.status, pr.until)),
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
     where pr.contact_id = ct.id
       and public.directory_role_is_live(pr.status, pr.until)),
    array[]::text[]
  ),
  coalesce(
    (select array_agg(distinct rt.canonical_category order by rt.canonical_category)
     from public.party_roles pr
     join public.directory_relationship_types rt on rt.id = pr.relationship_type_id
     where pr.contact_id = ct.id
       and public.directory_role_is_live(pr.status, pr.until)),
    array[]::text[]
  ),
  coalesce(
    (select jsonb_agg(jsonb_build_object('key', rt.key, 'label', rt.label, 'status', pr.status)
              order by rt.sort_order, rt.label)
     from public.party_roles pr
     join public.directory_relationship_types rt on rt.id = pr.relationship_type_id
     where pr.contact_id = ct.id
       and public.directory_role_is_live(pr.status, pr.until)),
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
  'One row per directory party, company or person, with its current roles (directory_role_is_live). security_invoker so the underlying org RLS on companies/contacts still applies to whoever selects from it.';

grant select on public.directory_entries to authenticated;
grant select on public.directory_entries to service_role;

-- ── 3. Indexes the view actually needs ─────────────────────────────────────
-- The default sort is on sort_name. Companies already had a matching expression
-- index (companies_org_normalized_name_uidx); contacts were sorting on a raw
-- full_name index that cannot serve directory_normalize_name(full_name), so
-- every default contact page paid for a sort node.
create index if not exists contacts_org_normalized_name_idx
  on public.contacts (org_id, public.directory_normalize_name(full_name))
  where archived_at is null;

-- The role subqueries filter by party then evaluate liveness. Carrying status
-- and until in the index lets that stay an index-only scan.
create index if not exists party_roles_company_live_idx
  on public.party_roles (company_id, relationship_type_id)
  include (status, until)
  where company_id is not null;

create index if not exists party_roles_contact_live_idx
  on public.party_roles (contact_id, relationship_type_id)
  include (status, until)
  where contact_id is not null;
