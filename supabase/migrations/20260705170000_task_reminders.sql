-- Task self-reminders.
--
-- Personal tasks on the org-wide /tasks hub can carry a reminder date. A daily
-- cron (/api/jobs/task-reminders) emails the task's creator on/after that date,
-- then stamps reminder_sent_at so it fires exactly once. Changing the reminder
-- date clears reminder_sent_at so a fresh reminder can go out.

alter table public.tasks
  add column if not exists reminder_at date,
  add column if not exists reminder_sent_at timestamptz;

comment on column public.tasks.reminder_at is
  'Self-reminder date. A daily cron emails the task creator on/after this date.';
comment on column public.tasks.reminder_sent_at is
  'When the reminder email was sent; NULL means still pending. Reset when reminder_at changes.';

-- Partial index keeps the cron sweep cheap: it only scans still-pending reminders.
create index if not exists tasks_reminder_pending_idx
  on public.tasks (reminder_at)
  where reminder_sent_at is null and reminder_at is not null;
