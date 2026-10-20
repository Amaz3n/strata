-- An opportunity has a date its price is due, and one tracked from a builder's
-- invitation remembers that invitation so it cannot be tracked twice.
--
-- Neutral columns on prospects: a builder's own bid deadlines use due_at too.
-- source_grant_id is the external_identity_grants row the invitation reached
-- this company through. That grant belongs to the inviting builder's org, so
-- it is a reference and not a foreign key; the service resolves it against the
-- member's verified identity before writing it.

alter table public.prospects
  add column if not exists due_at timestamptz,
  add column if not exists source_grant_id uuid;

comment on column public.prospects.due_at is
  'When the price is due to the customer (a bid or quote deadline). Null when nobody set one.';
comment on column public.prospects.source_grant_id is
  'The builder invitation (external_identity_grants.id in the inviting org) this opportunity was tracked from.';

create unique index if not exists prospects_org_source_grant_key
  on public.prospects (org_id, source_grant_id)
  where source_grant_id is not null;

create index if not exists prospects_org_open_due_idx
  on public.prospects (org_id, due_at)
  where due_at is not null and status not in ('won', 'lost');
