-- Phase 6 of docs/external-access-gameplan.md — a bidder is a vendor.
--
-- Bid access grew its own token table, so an Arc-account vendor invited to bid
-- was bounced to a second portal with a second chrome for the same builder
-- relationship. A bid invite is "a person on a project, pre-award": the same
-- shape `portal_access_tokens` already models.
--
-- This adds the scoped pointer so bid invites can mint portal tokens, following
-- the existing `scoped_rfi_id` / `scoped_change_event_rfq_id` /
-- `scoped_submittal_revision_id` convention. `bid_access_tokens` stays readable
-- for links already in the wild; `/b/[token]` redirects to the portal token.

alter table public.portal_access_tokens
  add column if not exists scoped_bid_invite_id uuid
    references public.bid_invites(id) on delete cascade;

comment on column public.portal_access_tokens.scoped_bid_invite_id is
  'Set when this access record was minted from a bid invite. The holder sees the sub portal with a Bids section rather than a separate /b portal.';

-- One live portal token per bid invite. Reissuing revokes the old row first, so
-- the partial index only constrains live rows.
create unique index if not exists portal_access_tokens_bid_invite_live_idx
  on public.portal_access_tokens (scoped_bid_invite_id)
  where scoped_bid_invite_id is not null and revoked_at is null;

-- The roster and the portal both filter on this column; it is also the join key
-- for loading a company's live invites inside the sub portal.
create index if not exists portal_access_tokens_scoped_bid_invite_idx
  on public.portal_access_tokens (org_id, scoped_bid_invite_id)
  where scoped_bid_invite_id is not null;
