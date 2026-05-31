-- Re-add follow-up scheduling for first-class prospects.
-- The legacy CRM stored follow-ups in contacts.metadata; the precon redesign moved to a
-- dedicated prospects table that lacked the field. This restores it as a typed column.

alter table prospects
  add column if not exists next_follow_up_at timestamptz;

-- Partial index for the pipeline "follow-ups due" lookups (org-scoped, only rows with a date).
create index if not exists idx_prospects_next_follow_up_at
  on prospects (org_id, next_follow_up_at)
  where next_follow_up_at is not null;
