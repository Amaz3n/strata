-- Division-scoped approval routing.
--
-- The roster carried an amount ceiling and a sort order, which cannot express
-- how construction orgs actually delegate: one person approves anything in the
-- Westside division, another approves anything over a threshold anywhere. With
-- only a ceiling, scoping approval to a division meant giving someone authority
-- over every division at that amount.
--
-- Null means org-wide, which is what every existing roster row already means, so
-- the column is additive with no backfill.
--
-- RECOVERED FROM PRODUCTION 2026-09-01 (WS-A5). This migration was applied
-- through the Supabase MCP and never written back to the repository, so the repo
-- could not reproduce production. The file carries the live ledger's version
-- number so the two sides agree; the SQL is the ledger's recorded statement
-- verbatim. Do not re-apply — it is already in production.
alter table public.payment_run_approvers
  add column if not exists division_id uuid references public.divisions(id) on delete cascade;

comment on column public.payment_run_approvers.division_id is
  'Restricts this approver to runs whose bills all sit in this division. Null is org-wide.';

-- One roster row per person per scope: the same person can hold a low org-wide
-- ceiling and a higher one inside their own division.
drop index if exists public.payment_run_approvers_org_user_key;
create unique index if not exists payment_run_approvers_org_user_scope_idx
  on public.payment_run_approvers (org_id, user_id, coalesce(division_id, '00000000-0000-0000-0000-000000000000'::uuid));

create index if not exists payment_run_approvers_division_idx
  on public.payment_run_approvers (org_id, division_id)
  where division_id is not null;
