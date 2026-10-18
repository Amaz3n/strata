-- Members reorder any of their organization's pending jobs, but edit only their own kinds (EP13 review M1).
--
-- 20261020210000 closed a member's update to every job type a member does not
-- queue, which also took away reordering: moving a pending job's priority or run
-- time inside one's own organization (claims rotate across organizations, so it
-- moves no other tenant's work), which the starts cutover's acceptance relies on.
-- Reordering is back for every pending job, with run_at still no earlier than
-- now. What stays closed is the payload of a job the server queued: a member
-- must not be able to point a queued payment release at another run.

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
    if new.job_type not in ('reindex_search', 'remove_search_index', 'send_proposal_email', 'process_drawing_set') then
      raise exception 'Background job type % is queued by the server', new.job_type using errcode = '42501';
    end if;
    new.correlation_id := public.request_correlation_id();
    new.created_at := now();
    new.run_at := greatest(coalesce(new.run_at, now()), now());
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'pending'
    and (new.org_id, new.job_type, new.status, new.retry_count, new.last_error, new.event_id, new.dedupe_key, new.correlation_id,
      new.drawing_claim_token, new.drawing_lease_expires_at, new.start_claim_token, new.start_job_lease_expires_at, new.created_at)
      is not distinct from
      (old.org_id, old.job_type, old.status, old.retry_count, old.last_error, old.event_id, old.dedupe_key, old.correlation_id,
      old.drawing_claim_token, old.drawing_lease_expires_at, old.start_claim_token, old.start_job_lease_expires_at, old.created_at) then
    if old.job_type not in ('reindex_search', 'remove_search_index', 'send_proposal_email', 'process_drawing_set')
      and new.payload is distinct from old.payload then
      raise exception 'The payload of a job the server queued is written by the server' using errcode = '42501';
    end if;
    if new.run_at is distinct from old.run_at then
      new.run_at := greatest(coalesce(new.run_at, now()), now());
    end if;
    return new;
  end if;
  raise exception 'Background job state is written by the workers' using errcode = '42501';
end $$;
