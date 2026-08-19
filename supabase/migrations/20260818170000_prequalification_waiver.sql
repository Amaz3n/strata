-- Waiving prequalification is a decision, not the absence of one.
--
-- Some vendors never need a package: a sole proprietor doing $4k of punch work,
-- a supplier the builder has used for a decade, a utility with no alternative.
-- Before this, the only way to stop the commitment gate from complaining was to
-- run a full prequalification anyway or to leave a permanent warning on every
-- commitment. `waived` records the judgement, who made it, and why, on the same
-- row and with the same audit trail as any other decision — `reviewed_by`,
-- `reviewed_at` and `review_notes` all carry their usual meaning, and
-- `expires_at` lets a waiver be granted for a season rather than forever.

alter table public.prequalifications
  drop constraint if exists prequalifications_status_check;

alter table public.prequalifications
  add constraint prequalifications_status_check
    check (status in (
      'requested',
      'submitted',
      'under_review',
      'approved',
      'approved_with_limits',
      'declined',
      'expired',
      'waived'
    ));

comment on column public.prequalifications.status is
  'Lifecycle of one prequalification package. `waived` means the builder decided this vendor does not need one; it satisfies the commitment and bid gates exactly as an approval does, and expires the same way when `expires_at` passes.';
