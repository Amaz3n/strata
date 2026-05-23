-- Per-user email notification category preferences.
-- Missing keys are treated as enabled by the application so existing users keep current behavior.
alter table public.user_notification_prefs
  add column if not exists weekly_snapshot_enabled boolean not null default false;

alter table public.user_notification_prefs
  add column if not exists weekly_snapshot_last_sent_for_week date;

alter table public.user_notification_prefs
  add column if not exists email_type_settings jsonb not null default '{}'::jsonb;

comment on column public.user_notification_prefs.email_type_settings
  is 'JSON map of notification_type => boolean for email delivery. Missing keys default to enabled.';

create index if not exists user_notification_prefs_weekly_snapshot_idx
  on public.user_notification_prefs (org_id, weekly_snapshot_enabled, email_enabled);
