-- The party survives its own lifecycle.
--
-- Four places lose the human being at exactly the moment the relationship
-- becomes real:
--
--   * `commitments` has no contact. The person who bid the job is known on
--     `bid_invites` and forgotten at award, so the subcontract, every bill
--     against it and every waiver chase address a company with no one at it.
--   * `contracts` — including purchase agreements — has no buyer column. The
--     buyer on the largest transaction Arc touches is reachable only by
--     joining out to projects.client_id.
--   * `closings` has no buyer reference at all.
--   * `project_emails` has neither contact nor company, so correspondence is
--     attributable to a project but never to a party. That is the gap that
--     keeps the directory from being a CRM.
--
-- Plus the identity link: `external_identities` is global and has no pointer to
-- the directory person it is, so the only path from a signed-in portal user
-- back to a contact is a two-hop join through a token — which breaks entirely
-- for bid-scoped grants that have no token.

-- ── 1. The bidder survives the award ───────────────────────────────────────
alter table public.commitments
  add column if not exists contact_id uuid references public.contacts(id) on delete set null;

comment on column public.commitments.contact_id is
  'The person at the company this commitment is with. Carried from the bid invite at award so notices, waiver chases and portal invites have someone to address.';

create index if not exists commitments_contact_idx
  on public.commitments (org_id, contact_id) where contact_id is not null;

-- Recover it for existing subcontracts where the award chain still knows.
-- A company can have been invited to several packages with different people on
-- them; `distinct on` makes the pick the earliest invite rather than whichever
-- row the planner happened to reach first.
with invite as (
  select distinct on (bi.org_id, bi.company_id)
         bi.org_id, bi.company_id, bi.contact_id
  from public.bid_invites bi
  where bi.contact_id is not null
  order by bi.org_id, bi.company_id, bi.id
)
update public.commitments c
set contact_id = invite.contact_id
from invite
where c.contact_id is null
  and c.company_id is not null
  and invite.org_id = c.org_id
  and invite.company_id = c.company_id;

-- ── 2. The buyer is on the paper ───────────────────────────────────────────
alter table public.contracts
  add column if not exists buyer_contact_id uuid references public.contacts(id) on delete set null,
  add column if not exists co_buyer_contact_id uuid references public.contacts(id) on delete set null;

comment on column public.contracts.buyer_contact_id is
  'Counterparty on the agreement. For a purchase agreement this is the buyer; for an owner contract, the owner. Previously reachable only through projects.client_id, which is the project''s current client and not necessarily who signed.';

create index if not exists contracts_buyer_idx
  on public.contracts (org_id, buyer_contact_id) where buyer_contact_id is not null;

alter table public.closings
  add column if not exists buyer_contact_id uuid references public.contacts(id) on delete set null;

create index if not exists closings_buyer_idx
  on public.closings (org_id, buyer_contact_id) where buyer_contact_id is not null;

-- A purchase agreement reached through a reservation already knows its buyer.
update public.contracts ct
set buyer_contact_id = r.buyer_contact_id,
    co_buyer_contact_id = r.co_buyer_contact_id
from public.lot_reservations r
where ct.buyer_contact_id is null
  and r.contract_id = ct.id
  and r.buyer_contact_id is not null;

-- Everything else takes the project's client, which is what the UI showed anyway.
update public.contracts ct
set buyer_contact_id = p.client_id
from public.projects p
where ct.buyer_contact_id is null
  and p.id = ct.project_id
  and p.client_id is not null;

update public.closings cl
set buyer_contact_id = p.client_id
from public.projects p
where cl.buyer_contact_id is null
  and p.id = cl.project_id
  and p.client_id is not null;

-- ── 3. Correspondence attributes to a party ────────────────────────────────
alter table public.project_emails
  add column if not exists contact_id uuid references public.contacts(id) on delete set null,
  add column if not exists company_id uuid references public.companies(id) on delete set null;

comment on column public.project_emails.contact_id is
  'The directory person this message is with, matched on the counterparty address at ingest. Null when the address matches nobody — an unmatched message is still a project record.';

create index if not exists project_emails_contact_idx
  on public.project_emails (org_id, contact_id, sent_at desc) where contact_id is not null;
create index if not exists project_emails_company_idx
  on public.project_emails (org_id, company_id, sent_at desc) where company_id is not null;

-- Backfill inbound mail from the sender, outbound from the first recipient.
-- citext equality on contacts.email makes this case-insensitive already.
update public.project_emails pe
set contact_id = c.id
from public.contacts c
where pe.contact_id is null
  and c.org_id = pe.org_id
  and c.archived_at is null
  and c.email is not null
  and c.email = (case when pe.direction = 'inbound'
                      then pe.from_address
                      else pe.to_addresses[1] end)::citext;

update public.project_emails pe
set company_id = l.company_id
from public.contact_company_links l
where pe.company_id is null
  and pe.contact_id is not null
  and l.contact_id = pe.contact_id
  and l.org_id = pe.org_id
  and l.is_primary;

-- ── 4. A portal identity knows which directory person it is ────────────────
-- Global identity, org-scoped meaning: one identity is at most one contact per
-- org, and one contact is at most one identity. Both directions are enforced.
alter table public.contacts
  add column if not exists external_identity_id uuid
    references public.external_identities(id) on delete set null;

comment on column public.contacts.external_identity_id is
  'The claimed portal account for this person, when they have one. Replaces the two-hop join through portal_access_tokens and the metadata.has_portal_access shadow flag, neither of which survived a token being revoked or scoped to a bid package.';

create unique index if not exists contacts_external_identity_uidx
  on public.contacts (org_id, external_identity_id)
  where external_identity_id is not null;

-- Recover the link from the tokens that already carry both sides.
--
-- `distinct on (org_id, identity_id)` is what makes this safe against the
-- unique index created just above: a NOT EXISTS guard would read the
-- pre-statement snapshot, so two contacts sharing one identity would both pass
-- it and the second would raise 23505, rolling back this whole migration.
-- Nothing is in that state today; this makes the file replay-safe anywhere.
with claim as (
  select distinct on (t.org_id, g.identity_id)
         t.org_id, t.contact_id, g.identity_id
  from public.external_identity_grants g
  join public.portal_access_tokens t on t.id = g.portal_access_token_id
  where g.identity_id is not null
    and t.contact_id is not null
  order by t.org_id, g.identity_id, t.id
)
update public.contacts c
set external_identity_id = claim.identity_id
from claim
where c.external_identity_id is null
  and c.id = claim.contact_id
  and c.org_id = claim.org_id;
