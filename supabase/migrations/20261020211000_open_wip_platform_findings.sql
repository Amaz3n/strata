-- Open-WIP cutovers alert platform operations, not the builder (EP13 review).
--
-- An Open-WIP cutover is run by Arc's onboarding team from the platform admin,
-- never by the builder, so a failed or stalled one was emailed to the people who
-- could do nothing about it. Those batches now report as `open_wip_attention`,
-- a platform finding the watchdog raises for operators only; `import_failed` and
-- `import_stalled` keep alerting builders about the imports they run
-- themselves. `imports_backlog` is gone: only the Open-WIP resume waited on a
-- scheduled job, and other importers commit inline.

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
      and b.importer <> 'open_wip'
    union all
    select 'import_stalled', b.org_id, b.id::text, b.updated_at
    from public.import_batches b
    where b.status = 'committing' and b.importer <> 'open_wip' and b.updated_at < now() - interval '30 minutes'
    union all
    select 'open_wip_attention', b.org_id, b.id::text, b.updated_at
    from public.import_batches b
    where b.importer = 'open_wip'
      and ((b.status = 'failed' and b.updated_at >= now() - interval '1 day' and not (b.report ? 'cancelled'))
        or (b.status = 'committing' and coalesce(b.commit_lease_expires_at, b.updated_at) < now() - interval '30 minutes'))
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
