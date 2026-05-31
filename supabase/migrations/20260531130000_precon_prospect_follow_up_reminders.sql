-- User-specific follow-up reminders: record who the follow-up is for and when it was emailed.
alter table prospects
  add column if not exists next_follow_up_user_id uuid references app_users(id) on delete set null,
  add column if not exists next_follow_up_notified_at timestamptz;

-- Index supporting the cron sweep: due, not-yet-notified follow-ups.
create index if not exists idx_prospects_follow_up_due
  on prospects (next_follow_up_at)
  where next_follow_up_at is not null and next_follow_up_notified_at is null;
