-- Retention pruning (July 2026 DB access review, phase 2).
--
-- outbox, notifications, and events grew without bound; nothing ever pruned
-- them. Nightly pg_cron jobs keep the hot tables small:
-- - outbox: completed jobs after 30 days, failed jobs after 90 (kept longer
--   for debugging); pending is never touched.
-- - notifications: read notifications after 180 days; unread are kept.
-- - events: after 365 days — the activity feed shows recents and the admin
--   usage trends look back 6 months, so a year of history covers every reader.
-- - audit_log is deliberately NOT pruned (compliance record).

create extension if not exists pg_cron;

select cron.schedule(
  'prune-outbox',
  '17 3 * * *',
  $$
    delete from public.outbox
    where (status = 'completed' and created_at < now() - interval '30 days')
       or (status = 'failed' and created_at < now() - interval '90 days')
  $$
);

select cron.schedule(
  'prune-notifications',
  '23 3 * * *',
  $$
    delete from public.notifications
    where read_at is not null
      and created_at < now() - interval '180 days'
  $$
);

select cron.schedule(
  'prune-events',
  '29 3 * * *',
  $$
    delete from public.events
    where created_at < now() - interval '365 days'
  $$
);
