-- A reopened and reclosed period keeps every statement set it was ever closed
-- on (snapshots are immutable), so the period itself must say which set its
-- current close stands on. Written in the same update that locks the period.
alter table public.accounting_periods add column close_snapshot_ids uuid[];

comment on column public.accounting_periods.close_snapshot_ids is
  'financial_statement_snapshots rows the current close (close_digest) was taken on; earlier sets remain for history.';
