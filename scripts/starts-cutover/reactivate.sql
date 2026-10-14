-- Starts cutover re-activation: turns the fences and guards that rollback.sql
-- disabled back on. Run by a human with psql, never by tooling:
--
--   psql "$DATABASE_URL" -v cutover_confirm=1 -f scripts/starts-cutover/reactivate.sql
--
-- Stop the previous worker first (pause the starts cron and wait six minutes):
-- a legacy claim that is still processing when the fences return is drained by
-- the new worker like any other tokenless claim, but it must not be writing.
-- Check with verify.sql afterwards.

\if :{?cutover_confirm}
\else
  \echo 'Refusing to run: pass -v cutover_confirm=1 to confirm this is the database you mean to change.'
  \quit
\endif

begin;

do $reactivate$
declare
  v_trigger record;
  v_enabled integer := 0;
begin
  for v_trigger in
    select t.tgrelid::regclass as table_name, t.tgname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname = 'public' and t.tgenabled = 'D'
      and (t.tgname ~ '^starts_(job_browser_write_guard|worker_[a-z_]+_fence|generated_worker_fence|purchasing_worker_fence|land_posting_worker_fence|drawing_record_worker_fence)$'
        or t.tgname ~ '^drawing_worker_[a-z_]+_fence$'
        or t.tgname in ('drawing_job_browser_write_guard', 'projects_plan_drawing_copy_manifest_guard'))
    order by 1, 2
  loop
    execute format('alter table %s enable trigger %I', v_trigger.table_name, v_trigger.tgname);
    v_enabled := v_enabled + 1;
  end loop;
  raise notice 'starts cutover reactivation: % triggers enabled', v_enabled;
end
$reactivate$;

commit;
