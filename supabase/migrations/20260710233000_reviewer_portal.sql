-- Workstream 04 (Phase 1): reviewer portal seats.
-- Adds the third external persona — architect/engineer/owner's-rep reviewer —
-- on the existing portal token infrastructure. Additive and backward-compatible.

alter table public.portal_access_tokens
  drop constraint if exists portal_access_tokens_portal_type_check;

alter table public.portal_access_tokens
  add constraint portal_access_tokens_portal_type_check
    check (portal_type = any (array['client'::text, 'sub'::text, 'reviewer'::text]));

alter table public.portal_access_tokens
  add column if not exists can_review_submittals boolean not null default false,
  add column if not exists reviewer_role text;

alter table public.portal_access_tokens
  drop constraint if exists portal_access_tokens_reviewer_role_check;

alter table public.portal_access_tokens
  add constraint portal_access_tokens_reviewer_role_check
    check (reviewer_role is null
      or reviewer_role in ('architect', 'engineer', 'owner_rep', 'consultant', 'other'));

comment on column public.portal_access_tokens.reviewer_role is
  'Design-review persona for reviewer-type tokens (architect/engineer/owner_rep/consultant/other). Null for client/sub tokens.';
comment on column public.portal_access_tokens.can_review_submittals is
  'Reviewer capability: may decide submittal review steps routed to this seat.';
