-- Production pipeline health for the watchdog (EP13-05, EP13-06).
--
-- Payment and accounting jobs already raise incidents for the organizations they
-- affect. Starts, imports and warranty did not: a release parked in attention, a
-- cutover whose claim lapsed, a warranty enrollment that exhausted its retries
-- were visible only to someone who went looking. This function returns, per
-- finding, every affected organization with a count and a sample of the failed
-- units, in one round trip. The org lists are complete (not paged), because the
-- incident synchronizer treats a missing organization as recovered.
--
-- The `*_backlog` and `warranty_requests_open` codes are not failures: they are
-- the organizations with work waiting on a pipeline's scheduled job, used to
-- address an alert when that job was not started or died mid-run.

create or replace function public.operations_pipeline_findings()
returns table(code text, org_id uuid, unit_count bigint, sample_ids text[])
language sql
stable
set search_path to ''
as $$
  with units(code, org_id, unit_id, at) as (
    select 'starts_release_attention', p.org_id, p.id::text, p.updated_at
    from public.start_packages p where p.status = 'attention'
    union all
    select 'starts_jobs_failed', o.org_id, o.id::text, o.updated_at
    from public.outbox o
    where o.status = 'failed' and o.updated_at >= now() - interval '1 day'
      and o.job_type in ('start_release', 'trade_schedule_change_notice', 'start_release_trade_notice', 'start_package_notice')
    union all
    select 'import_failed', b.org_id, b.id::text, b.updated_at
    from public.import_batches b
    where b.status = 'failed' and b.updated_at >= now() - interval '1 day' and not (b.report ? 'cancelled')
    union all
    select 'import_stalled', b.org_id, b.id::text, b.updated_at
    from public.import_batches b
    where b.status = 'committing'
      and ((b.importer = 'open_wip' and coalesce(b.commit_lease_expires_at, b.updated_at) < now() - interval '30 minutes')
        or (b.importer <> 'open_wip' and b.updated_at < now() - interval '30 minutes'))
    union all
    select 'warranty_jobs_failed', o.org_id, o.id::text, o.updated_at
    from public.outbox o
    where o.status = 'failed' and o.updated_at >= now() - interval '1 day' and o.job_type like 'warranty\_%'
    union all
    select 'starts_backlog', o.org_id, o.id::text, o.created_at
    from public.outbox o
    where o.status in ('pending', 'processing')
      and o.job_type in ('start_release', 'trade_schedule_change_notice', 'start_release_trade_notice', 'start_package_notice')
    union all
    select 'imports_backlog', b.org_id, b.id::text, b.updated_at
    from public.import_batches b where b.status = 'committing'
    union all
    select 'warranty_jobs_backlog', o.org_id, o.id::text, o.created_at
    from public.outbox o where o.status in ('pending', 'processing') and o.job_type like 'warranty\_%'
    union all
    select 'warranty_requests_open', r.org_id, r.id::text, r.created_at
    from public.warranty_requests r where r.closed_at is null
  )
  select u.code, u.org_id, count(*)::bigint, (array_agg(u.unit_id order by u.at desc))[1:20]
  from units u
  group by u.code, u.org_id
$$;

revoke all on function public.operations_pipeline_findings() from public, anon, authenticated;
grant execute on function public.operations_pipeline_findings() to service_role;
