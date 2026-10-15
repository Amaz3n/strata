-- Starts cutover verification. Read-only: one row per check, `ok` false means
-- the window is not finished. Run with psql after the forward migrations, after
-- a rollback, and after a re-activation:
--
--   psql "$DATABASE_URL" -f scripts/starts-cutover/verify.sql
--
-- The fence count differs by release (each workstream adds triggers); record it
-- before the window and compare it after a re-activation. `fences enabled` is
-- ok only when none of them is disabled, so a half-enabled set fails.

with fence_triggers as (
  select t.tgenabled
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and n.nspname = 'public'
    and (t.tgname ~ '^starts_(job_browser_write_guard|worker_[a-z_]+_fence|generated_worker_fence|purchasing_worker_fence|land_posting_worker_fence|drawing_record_worker_fence)$'
      or t.tgname ~ '^drawing_worker_[a-z_]+_fence$'
      or t.tgname in ('drawing_job_browser_write_guard', 'projects_plan_drawing_copy_manifest_guard'))
)
select 'schema marker (starts_cutover_ready proves every EP07 migration)' as check,
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public' and p.proname = 'starts_cutover_ready')
            then public.starts_cutover_ready() else false end as ok,
       null::bigint as n
union all
select 'claim protocol (claim_starts_jobs exists)',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'claim_starts_jobs'), null
union all
select 'fences enabled (none disabled)', (select count(*) from fence_triggers where tgenabled = 'D') = 0 and (select count(*) from fence_triggers) > 0, (select count(*) from fence_triggers where tgenabled <> 'D')
union all
select 'fences disabled (nonzero only after a rollback)', (select count(*) from fence_triggers where tgenabled = 'D') = 0, (select count(*) from fence_triggers where tgenabled = 'D')
union all
select 'tokenless starts jobs still processing (legacy claims awaiting the drain)', count(*) = 0, count(*)
  from public.outbox
  where status = 'processing' and start_claim_token is null
    and job_type in ('start_release', 'trade_schedule_change_notice', 'start_release_trade_notice', 'start_package_notice')
union all
select 'releases processing under a token', true, count(*)
  from public.outbox where status = 'processing' and start_claim_token is not null and job_type = 'start_release'
union all
select 'starts jobs failed', count(*) = 0, count(*)
  from public.outbox
  where status = 'failed' and job_type in ('start_release', 'trade_schedule_change_notice', 'start_release_trade_notice', 'start_package_notice')
union all
select 'packages releasing with no live release job', count(*) = 0, count(*)
  from public.start_packages s
  where s.status = 'releasing' and not exists (
    select 1 from public.outbox o
    where o.org_id = s.org_id and o.job_type = 'start_release' and o.payload->>'start_package_id' = s.id::text
      and o.status in ('pending', 'processing'))
union all
select 'abandoned drawing copies awaiting the sweep', true, count(*)
  from public.projects where metadata->'plan_instantiation'->'drawing_copy_attempt'->>'status' in ('reserved', 'abandoned');
