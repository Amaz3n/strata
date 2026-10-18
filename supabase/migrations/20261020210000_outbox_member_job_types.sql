-- Members queue only the job types a signed-in request actually queues (EP13 review M1).
--
-- The outbox guard from 20261020200000 limited a member's insert to a fresh
-- pending row but not to its job type, so any member could queue any job: a
-- `release_payment_run` written from the browser was executed by the payment
-- worker as the run's preparer. A member's session queues exactly these:
--
--   reindex_search, remove_search_index   search upkeep after an edit (search-index.ts)
--   send_proposal_email                   sending a proposal (proposals.ts)
--   process_drawing_set                   the pre-cutover drawing path, which the
--                                         starts/drawing rollback script restores;
--                                         drawing_job_browser_write_guard refuses it
--                                         while the drawing fences are on
--
-- Every other job type is queued by the server (service role or a definer
-- function). A member's insert also cannot choose its own bookkeeping: the
-- correlation id is the request's, the row is created now, and a job cannot be
-- backdated ahead of the queue (run_at no earlier than now). Reordering a pending
-- row is limited the same way, and only for these types: a member cannot edit
-- the payload of a job the server queued.

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
    and old.job_type in ('reindex_search', 'remove_search_index', 'send_proposal_email', 'process_drawing_set')
    and (new.org_id, new.job_type, new.status, new.retry_count, new.last_error, new.event_id, new.dedupe_key, new.correlation_id,
      new.drawing_claim_token, new.drawing_lease_expires_at, new.start_claim_token, new.start_job_lease_expires_at, new.created_at)
      is not distinct from
      (old.org_id, old.job_type, old.status, old.retry_count, old.last_error, old.event_id, old.dedupe_key, old.correlation_id,
      old.drawing_claim_token, old.drawing_lease_expires_at, old.start_claim_token, old.start_job_lease_expires_at, old.created_at) then
    if new.run_at is distinct from old.run_at then
      new.run_at := greatest(coalesce(new.run_at, now()), now());
    end if;
    return new;
  end if;
  raise exception 'Background job state is written by the workers' using errcode = '42501';
end $$;
