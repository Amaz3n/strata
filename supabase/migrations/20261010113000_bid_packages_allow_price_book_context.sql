-- A community/plan rebid (award_target = 'price_agreement') has neither a
-- project nor a prospect: bid_packages_award_target_context requires exactly
-- that. But bid_packages_precon_context_chk (20260530120000) still demands a
-- project or a prospect on every package, so the two constraints together made
-- every price-book package impossible to insert (verified against production,
-- where both are validated). The newer pair already says everything the old
-- check meant for commitment packages — a commitment package needs a project,
-- a prospect package is a commitment package, and at most one parent context
-- is set (bid_packages_parent_context) — so the old check is dropped.

alter table public.bid_packages drop constraint if exists bid_packages_precon_context_chk;
