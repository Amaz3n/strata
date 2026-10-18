-- Fair claiming for the shared job queue (EP13-03).
--
-- `claim_jobs` and `claim_starts_jobs` ordered every pending row globally by
-- priority and age, so one organization's backlog (an import, a bulk release, a
-- burst of notifications) was claimed before any other organization's first job.
-- Both now claim round-robin across organizations: each organization's own jobs
-- keep their priority-then-age order, and a claim takes every waiting
-- organization's next job before anyone's second. A claim with room for more
-- than one job interleaves them; a claim of one job rotates to the organization
-- after the one served last (`outbox_claim_rotation`), so a worker that claims
-- one job at a time is fair across claims too. An organization alone in the
-- queue still gets every slot: fairness never leaves capacity idle.
--
-- Finding the waiting organizations is a skip scan per job type over
-- `outbox_pending_org_types_idx`, one index probe per (type, organization), so a
-- backlog of a hundred thousand rows in one organization costs its own top rows,
-- not a sort of the whole queue.
--
-- Also here:
--   * `outbox.correlation_id` — the request that queued a job, read with the
--     audit rows and events that request wrote (the job's own writes carry
--     `outbox:<id>`).
--   * Browser roles may only queue a fresh pending job and reorder their own
--     pending work. Status, retries, errors and claims are the workers' (members
--     could previously mark their organization's jobs completed or failed, or
--     delete them, through the data API).
--   * `outbox_backlog_by_org` — per-organization backlog for the operations page.

create table if not exists public.outbox_claim_rotation (
  queue_key text primary key,
  last_org_id uuid not null,
  updated_at timestamptz not null default now()
);

alter table public.outbox_claim_rotation enable row level security;
revoke all on public.outbox_claim_rotation from public, anon, authenticated;
grant select, insert, update on public.outbox_claim_rotation to service_role;

comment on table public.outbox_claim_rotation is
  'The organization a job claim served last, per claimed set of job types; the next claim starts after it. Written only by claim_jobs and claim_starts_jobs.';

create index if not exists outbox_pending_org_types_idx
  on public.outbox (job_type, org_id, run_at)
  where status = 'pending';

create index if not exists outbox_pending_org_order_idx
  on public.outbox (org_id, priority desc, created_at, id)
  where status = 'pending';

create or replace function public.claim_jobs("job_types" text[], "limit_value" integer default 5)
returns table("job_id" bigint, "org_id" uuid, "job_type" text, "payload" jsonb, "retry_count" integer)
language plpgsql
set search_path to 'public', 'pg_catalog'
as $$
declare
  v_types text[] := array(select distinct t from unnest(job_types) t where t is not null order by t);
  v_key text;
  v_cursor uuid;
  v_ids bigint[];
  v_last uuid;
begin
  if limit_value is null or limit_value < 1 or limit_value > 500 then
    raise exception 'Invalid job claim limit';
  end if;
  if coalesce(array_length(v_types, 1), 0) = 0 then return; end if;
  v_key := 'jobs:' || md5(array_to_string(v_types, ','));
  select r.last_org_id into v_cursor from public.outbox_claim_rotation r where r.queue_key = v_key;

  with recursive heads(job_type, org_id) as (
    select t.job_type, (
      select o.org_id from public.outbox o
      where o.status = 'pending' and o.job_type = t.job_type and o.run_at <= now()
      order by o.org_id limit 1
    )
    from unnest(v_types) as t(job_type)
    union all
    select h.job_type, (
      select o.org_id from public.outbox o
      where o.status = 'pending' and o.job_type = h.job_type and o.run_at <= now() and o.org_id > h.org_id
      order by o.org_id limit 1
    )
    from heads h where h.org_id is not null
  ), waiting as (
    select distinct h.org_id from heads h where h.org_id is not null
  ), candidates as (
    select c.id, c.org_id, c.priority, c.created_at,
      row_number() over (partition by c.org_id order by c.priority desc, c.created_at, c.id) as turn
    from waiting w
    cross join lateral (
      select o.id, o.org_id, o.priority, o.created_at from public.outbox o
      where o.org_id = w.org_id and o.status = 'pending' and o.job_type = any(v_types) and o.run_at <= now()
      order by o.priority desc, o.created_at, o.id
      limit limit_value
    ) c
  ), picked as (
    select o.id, cand.org_id, cand.turn, cand.priority, cand.created_at
    from candidates cand
    join public.outbox o on o.id = cand.id
    where o.status = 'pending'
    order by cand.turn, coalesce(cand.org_id <= v_cursor, false), cand.org_id, cand.priority desc, cand.created_at, cand.id
    limit limit_value
    for update of o skip locked
  ), claimed as (
    update public.outbox o set status = 'processing', updated_at = now()
    from picked where o.id = picked.id
    returning o.id, picked.org_id, picked.turn, picked.priority, picked.created_at
  )
  select
    array_agg(c.id order by c.turn, coalesce(c.org_id <= v_cursor, false), c.org_id, c.priority desc, c.created_at, c.id),
    (array_agg(c.org_id order by c.turn desc, coalesce(c.org_id <= v_cursor, false) desc, c.org_id desc, c.priority, c.created_at desc, c.id desc))[1]
  into v_ids, v_last
  from claimed c;

  if v_last is not null then
    insert into public.outbox_claim_rotation(queue_key, last_org_id, updated_at)
    values (v_key, v_last, now())
    on conflict (queue_key) do update set last_org_id = excluded.last_org_id, updated_at = excluded.updated_at;
    raise log 'Claimed jobs: %', v_ids;
  end if;

  return query
    select o.id, o.org_id, o.job_type, o.payload, o.retry_count
    from unnest(v_ids) with ordinality as u(id, ord)
    join public.outbox o on o.id = u.id
    order by u.ord;
end;
$$;

revoke all on function public.claim_jobs(text[], integer) from public, anon, authenticated;
grant execute on function public.claim_jobs(text[], integer) to service_role;

comment on function public.claim_jobs(text[], integer) is
  'Claims up to limit_value due pending jobs of the given types, round-robin across organizations (each organization''s jobs in priority-then-age order), continuing the rotation from the organization served last.';

-- The starts worker claims one job at a time, so its fairness is the rotation.
-- Everything else about the claim (the lease, the token, the order of return)
-- is unchanged.
create or replace function public.claim_starts_jobs(p_limit integer default 2)
returns table(job_id bigint, org_id uuid, job_type text, payload jsonb, retry_count integer, claim_token uuid)
language plpgsql
set search_path to 'public', 'pg_catalog'
as $$
declare
  v_cursor uuid;
  v_last uuid;
  v_ids bigint[];
begin
  if p_limit is null or p_limit < 1 or p_limit > 6 then raise exception 'Invalid starts claim limit'; end if;
  select r.last_org_id into v_cursor from public.outbox_claim_rotation r where r.queue_key = 'starts';

  with candidates as (
    select o.id, o.org_id, o.priority, o.created_at,
      row_number() over (partition by o.org_id order by o.priority desc, o.created_at, o.id) as turn
    from public.outbox o
    where o.status = 'pending' and o.run_at <= clock_timestamp()
      and o.job_type in ('start_release', 'trade_schedule_change_notice', 'start_release_trade_notice', 'start_package_notice')
  ), picked as (
    select o.id, cand.org_id, cand.turn, cand.priority, cand.created_at
    from candidates cand
    join public.outbox o on o.id = cand.id
    where cand.turn <= p_limit and o.status = 'pending'
    order by cand.turn, coalesce(cand.org_id <= v_cursor, false), cand.org_id, cand.priority desc, cand.created_at, cand.id
    limit p_limit
    for update of o skip locked
  ), claimed as (
    update public.outbox o set status = 'processing', updated_at = clock_timestamp(),
      start_claim_token = gen_random_uuid(), start_job_lease_expires_at = clock_timestamp() + interval '3 minutes'
    from picked where o.id = picked.id
    returning o.id, picked.org_id, picked.turn, picked.priority, picked.created_at
  )
  select
    array_agg(c.id order by c.turn, coalesce(c.org_id <= v_cursor, false), c.org_id, c.priority desc, c.created_at, c.id),
    (array_agg(c.org_id order by c.turn desc, coalesce(c.org_id <= v_cursor, false) desc, c.org_id desc, c.priority, c.created_at desc, c.id desc))[1]
  into v_ids, v_last
  from claimed c;

  if v_last is not null then
    insert into public.outbox_claim_rotation(queue_key, last_org_id, updated_at)
    values ('starts', v_last, clock_timestamp())
    on conflict (queue_key) do update set last_org_id = excluded.last_org_id, updated_at = excluded.updated_at;
  end if;

  return query
    select o.id, o.org_id, o.job_type, o.payload, o.retry_count, o.start_claim_token
    from unnest(v_ids) with ordinality as u(id, ord)
    join public.outbox o on o.id = u.id
    order by u.ord;
end $$;

revoke all on function public.claim_starts_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_starts_jobs(integer) to service_role;

-- The request that queued the job. Same default and meaning as
-- audit_log.correlation_id and events.correlation_id.
alter table public.outbox
  add column if not exists correlation_id text default public.request_correlation_id();

comment on column public.outbox.correlation_id is
  'The request (or job) that queued this job; shared with audit_log.correlation_id and events.correlation_id. The job''s own writes are correlated to outbox:<id>.';

-- Members queue work; they never move it. Every per-family guard already on
-- this table (drawings, starts, audit retries, receipted deliveries) stays and
-- fires first with its own refusal (triggers fire in name order); this one is
-- the catch-all for every family, including the ones added after them. A
-- member may still reorder or reschedule its own organization's pending work
-- (priority, run_at, payload): claims rotate across organizations, so that can
-- never move another tenant's work, and a payload is nothing a fresh insert
-- could not carry.
create or replace function public.guard_outbox_browser_writes()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.retry_count <> 0 or new.last_error is not null
      or new.drawing_claim_token is not null or new.drawing_lease_expires_at is not null
      or new.start_claim_token is not null or new.start_job_lease_expires_at is not null then
      raise exception 'Background jobs are queued pending; their state is written by the workers' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'pending'
    and (new.org_id, new.job_type, new.status, new.retry_count, new.last_error, new.event_id, new.dedupe_key, new.correlation_id,
      new.drawing_claim_token, new.drawing_lease_expires_at, new.start_claim_token, new.start_job_lease_expires_at, new.created_at)
      is not distinct from
      (old.org_id, old.job_type, old.status, old.retry_count, old.last_error, old.event_id, old.dedupe_key, old.correlation_id,
      old.drawing_claim_token, old.drawing_lease_expires_at, old.start_claim_token, old.start_job_lease_expires_at, old.created_at) then
    return new;
  end if;
  raise exception 'Background job state is written by the workers' using errcode = '42501';
end $$;

drop trigger if exists worker_state_browser_write_guard on public.outbox;
create trigger worker_state_browser_write_guard
  before insert or update or delete on public.outbox
  for each row execute function public.guard_outbox_browser_writes();

-- Per-organization backlog: what is waiting, for how long, and what is claimed.
-- Aggregated here because the JS client caps reads at 1,000 rows.
create or replace function public.outbox_backlog_by_org(p_limit integer default 25)
returns table(org_id uuid, org_name text, due_count bigint, scheduled_count bigint, processing_count bigint,
  failed_last_day bigint, oldest_due_at timestamptz, total_orgs bigint)
language sql
stable
set search_path to ''
as $$
  with per_org as (
    select o.org_id,
      count(*) filter (where o.status = 'pending' and o.run_at <= now()) as due_count,
      count(*) filter (where o.status = 'pending' and o.run_at > now()) as scheduled_count,
      count(*) filter (where o.status = 'processing') as processing_count,
      count(*) filter (where o.status = 'failed' and o.updated_at >= now() - interval '1 day') as failed_last_day,
      min(o.created_at) filter (where o.status = 'pending' and o.run_at <= now()) as oldest_due_at
    from public.outbox o
    where o.status in ('pending', 'processing') or (o.status = 'failed' and o.updated_at >= now() - interval '1 day')
    group by o.org_id
  )
  select p.org_id, g.name, p.due_count, p.scheduled_count, p.processing_count, p.failed_last_day, p.oldest_due_at,
    count(*) over () as total_orgs
  from per_org p
  left join public.orgs g on g.id = p.org_id
  order by p.due_count desc, p.oldest_due_at nulls last, p.org_id
  limit greatest(1, least(coalesce(p_limit, 25), 200))
$$;

revoke all on function public.outbox_backlog_by_org(integer) from public, anon, authenticated;
grant execute on function public.outbox_backlog_by_org(integer) to service_role;
