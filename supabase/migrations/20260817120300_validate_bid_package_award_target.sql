-- `20260718193938_bid_packages_community_plan.sql` added two check constraints
-- NOT VALID and never followed up, so neither has ever been enforced against
-- existing rows. Both are validated here.
--
-- `bid_packages_parent_context` had two violating rows carrying both a
-- project_id and a prospect_id — leftovers from testing the prospect-to-project
-- conversion path. Both are `award_target = 'commitment'` and both already
-- point at a real project, so the project pointer is the live one and the
-- prospect pointer is the stale half of the conversion. Clearing it satisfies
-- `bid_packages_parent_context` and leaves `bid_packages_award_target_context`
-- satisfied too (commitment + project_id).
--
-- Scoped to rows where BOTH are set, so a legitimate prospect-only bid package
-- is untouched.

begin;

update public.bid_packages
set prospect_id = null
where project_id is not null
  and prospect_id is not null;

alter table public.bid_packages validate constraint bid_packages_award_target_context;
alter table public.bid_packages validate constraint bid_packages_parent_context;

commit;
