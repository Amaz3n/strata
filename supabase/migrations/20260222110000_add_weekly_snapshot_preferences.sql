-- Weekly executive snapshot email preferences.
alter table public.user_notification_prefs
  add column if not exists weekly_snapshot_enabled boolean not null default false;

alter table public.user_notification_prefs
  add column if not exists weekly_snapshot_last_sent_for_week date;

comment on column public.user_notification_prefs.weekly_snapshot_enabled
  is 'When true, send the Friday weekly executive snapshot email to this user for the org.';

comment on column public.user_notification_prefs.weekly_snapshot_last_sent_for_week
  is 'ISO date (week start) for idempotent weekly snapshot delivery.';

create index if not exists user_notification_prefs_weekly_snapshot_idx
  on public.user_notification_prefs (org_id, weekly_snapshot_enabled, email_enabled);
