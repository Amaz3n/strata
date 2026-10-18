-- One technician, or one trade, cannot be booked into two houses at once.
--
-- Dispatch checks the assignee's calendar before it books, but the check and
-- the insert are two statements: two coordinators booking the same tech for
-- the same morning both saw a free window and both booked. These exclusion
-- constraints make the calendar the fence. The window is half-open, so a
-- visit ending at 10:00 and the next starting at 10:00 are back to back, not
-- a conflict — the same rule `findOverlappingVisits` applies.
--
-- A coordinator may still double-book on purpose (two-man jobs, a quick stop
-- on the way). Such a visit is written with `overlap_allowed`, which takes it
-- out of the constraint; the deliberate decision is on the row. Finished and
-- canceled visits no longer hold their window.
--
-- Production had no service visits when this was written, so the constraints
-- build clean.

create extension if not exists btree_gist;

alter table public.warranty_service_visits
  add column if not exists overlap_allowed boolean not null default false;

comment on column public.warranty_service_visits.overlap_allowed is
  'Set when dispatch knowingly booked this visit over another for the same assignee; such a visit is exempt from the double-booking constraints.';

alter table public.warranty_service_visits
  add constraint warranty_service_visits_tech_no_double_book
  exclude using gist (
    org_id with =,
    assigned_user_id with =,
    tstzrange(window_start, window_end, '[)') with &&
  )
  where (assigned_user_id is not null and status not in ('canceled', 'completed') and not overlap_allowed);

alter table public.warranty_service_visits
  add constraint warranty_service_visits_trade_no_double_book
  exclude using gist (
    org_id with =,
    assigned_company_id with =,
    tstzrange(window_start, window_end, '[)') with &&
  )
  where (assigned_company_id is not null and status not in ('canceled', 'completed') and not overlap_allowed);
