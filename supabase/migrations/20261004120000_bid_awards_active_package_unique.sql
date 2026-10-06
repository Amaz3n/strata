-- A bid package may hold at most one ACTIVE award, not one award ever.
--
-- rescind_bid_award() keeps the award row as history and stamps
-- rescinded_at, but bid_awards_package_uidx was a plain unique index on
-- bid_package_id, so every re-award after a rescind failed with a unique
-- violation (verified live). The uniqueness now applies only to awards that
-- have not been rescinded, which is exactly what awardBidSubmission() checks
-- before converting (`rescinded_at is null`).

drop index if exists public.bid_awards_package_uidx;

create unique index if not exists bid_awards_active_package_uidx
  on public.bid_awards (bid_package_id)
  where rescinded_at is null;
