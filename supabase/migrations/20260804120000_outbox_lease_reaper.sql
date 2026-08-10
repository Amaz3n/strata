-- Outbox lease expiry.
--
-- `claim_jobs` already claims atomically with FOR UPDATE SKIP LOCKED, but nothing
-- ever returned a claimed row to the queue. A worker that times out mid-batch
-- leaves its rows in `processing` forever: for an email that is a lost send, and
-- for the payment-release job added alongside this migration it is a scheduled
-- payment that silently never happens and never retries.
--
-- The lease clock is `updated_at`, which `claim_jobs` already stamps at claim
-- time, so no new column is needed and `outbox_processing_updated_idx` already
-- indexes exactly the rows this scans.
--
-- Exhausted jobs land on the existing terminal `failed` status rather than a new
-- one: `failed` is already what the worker and the starts and drawings pipelines
-- use, and a second name for "a human has to look at this" would be two
-- vocabularies for one state. What distinguishes a lease expiry from a handler
-- that threw is `last_error`, which says so.

create or replace function public.reap_stale_outbox_jobs(
  p_lease_seconds integer,
  p_max_attempts integer,
  p_job_types text[] default null
)
returns table("requeued" bigint, "exhausted" bigint)
language plpgsql
set search_path = public
as $$
declare
  v_requeued bigint := 0;
  v_exhausted bigint := 0;
  v_cutoff timestamptz;
begin
  if p_lease_seconds is null or p_lease_seconds < 60 then
    raise exception 'Outbox lease must be at least 60 seconds';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 then
    raise exception 'Outbox max attempts must be at least 1';
  end if;
  v_cutoff := now() - make_interval(secs => p_lease_seconds);

  -- One statement, so a row cannot be requeued and exhausted by two
  -- concurrent reapers. SKIP LOCKED keeps a reaper from blocking on a worker
  -- that is legitimately still finishing its own row.
  with expired as (
    select id, retry_count
    from public.outbox
    where status = 'processing'
      and updated_at < v_cutoff
      and (p_job_types is null or job_type = any(p_job_types))
    order by updated_at
    limit 500
    for update skip locked
  ), reaped as (
    update public.outbox as target
    set
      status = case when expired.retry_count + 1 >= p_max_attempts then 'failed' else 'pending' end,
      retry_count = expired.retry_count + 1,
      run_at = case when expired.retry_count + 1 >= p_max_attempts then target.run_at else now() end,
      last_error = 'Lease expired; worker did not report an outcome',
      updated_at = now()
    from expired
    where target.id = expired.id
    returning target.status
  )
  select
    count(*) filter (where status = 'pending'),
    count(*) filter (where status = 'failed')
  into v_requeued, v_exhausted
  from reaped;

  requeued := coalesce(v_requeued, 0);
  exhausted := coalesce(v_exhausted, 0);
  return next;
end;
$$;

revoke all on function public.reap_stale_outbox_jobs(integer, integer, text[]) from public, anon, authenticated;
grant execute on function public.reap_stale_outbox_jobs(integer, integer, text[]) to service_role;

-- `claim_jobs` predates the payment work and was only ever granted implicitly.
-- Payment release claims through it now, so the grant is made explicit and the
-- browser roles are locked out of a function that hands out work items.
revoke all on function public.claim_jobs(text[], integer) from public, anon, authenticated;
grant execute on function public.claim_jobs(text[], integer) to service_role;

comment on function public.reap_stale_outbox_jobs(integer, integer, text[]) is
  'Returns outbox rows whose processing lease expired to pending, or to failed once retry_count reaches max attempts. Called by the outbox worker and by the payment-release tick for its own job type.';
