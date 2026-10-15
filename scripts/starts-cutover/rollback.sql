-- Starts cutover rollback: lets the PREVIOUS code run its starts and drawing
-- writes again. Run by a human with psql, never by tooling:
--
--   psql "$DATABASE_URL" -v cutover_confirm=1 -f scripts/starts-cutover/rollback.sql
--
-- What it does, in one transaction:
--   1. Disables the starts and drawing fences and browser-write guards (the
--      triggers matched below). Functions, columns and data stay where they
--      are; nothing is dropped, so re-enabling is not a second migration.
--   2. Puts tokened starts and drawing jobs that are mid-flight back in the
--      queue with no claim, which is the shape the previous worker claims.
--   3. Clears the lease a release holds on a package that is still releasing,
--      so the previous worker can take it.
-- It does NOT touch the product rules EP07 added, which stay on: a house needs
-- a superintendent before it releases (queue_start_release), superintendent
-- and release-slot writes are locked to the new assignment path, a lot cannot
-- be re-pinned or detached under a release, and the financing-evidence and
-- throughput checks apply. Nor does it touch the fences other workstreams added
-- around purchase agreements, closings, permits, selections or sales. See
-- docs/reference/starts-cutover.md, "Rollback".
--
-- Reverse with reactivate.sql. Check with verify.sql.

\if :{?cutover_confirm}
\else
  \echo 'Refusing to run: pass -v cutover_confirm=1 to confirm this is the database you mean to change.'
  \quit
\endif

begin;

do $rollback$
declare
  v_trigger record;
  v_disabled integer := 0;
  v_jobs integer;
  v_packages integer;
begin
  for v_trigger in
    select t.tgrelid::regclass as table_name, t.tgname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname = 'public' and t.tgenabled <> 'D'
      and (t.tgname ~ '^starts_(job_browser_write_guard|worker_[a-z_]+_fence|generated_worker_fence|purchasing_worker_fence|land_posting_worker_fence|drawing_record_worker_fence)$'
        or t.tgname ~ '^drawing_worker_[a-z_]+_fence$'
        or t.tgname in ('drawing_job_browser_write_guard', 'projects_plan_drawing_copy_manifest_guard'))
    order by 1, 2
  loop
    execute format('alter table %s disable trigger %I', v_trigger.table_name, v_trigger.tgname);
    v_disabled := v_disabled + 1;
  end loop;

  update public.outbox
     set status = 'pending', start_claim_token = null, start_job_lease_expires_at = null,
         drawing_claim_token = null, drawing_lease_expires_at = null, updated_at = clock_timestamp()
   where status = 'processing'
     and (start_claim_token is not null or drawing_claim_token is not null);
  get diagnostics v_jobs = row_count;

  update public.start_packages
     set metadata = metadata - 'release_lease_token' - 'release_lease_at', updated_at = clock_timestamp()
   where status = 'releasing' and metadata ?| array['release_lease_token', 'release_lease_at'];
  get diagnostics v_packages = row_count;

  raise notice 'starts cutover rollback: % triggers disabled, % in-flight jobs requeued, % package leases cleared', v_disabled, v_jobs, v_packages;
end
$rollback$;

commit;
