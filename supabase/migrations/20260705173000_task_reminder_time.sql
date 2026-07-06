-- Give task reminders time-of-day precision: reminder_at goes from a date to a
-- full timestamp so a reminder can fire at a chosen time, not just a day. The
-- cron now sweeps every 15 min for reminder_at <= now(). The column is empty
-- (reminders shipped the same day), so the cast touches no data.

drop index if exists tasks_reminder_pending_idx;

alter table public.tasks
  alter column reminder_at type timestamptz using reminder_at::timestamptz;

comment on column public.tasks.reminder_at is
  'Self-reminder instant. A cron emails the task creator once now() passes it.';

create index if not exists tasks_reminder_pending_idx
  on public.tasks (reminder_at)
  where reminder_sent_at is null and reminder_at is not null;
