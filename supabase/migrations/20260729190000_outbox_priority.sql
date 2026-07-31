-- Demand-priority for outbox jobs.
--
-- When a user opens a sheet whose tiles aren't rendered yet, the app bumps
-- that page job's priority so it is claimed next. claim_jobs orders by
-- priority (desc) before age, so the default 0 preserves today's FIFO
-- behavior for every other job type.

alter table public.outbox
  add column if not exists priority integer not null default 0;

-- Replace the claim index so the claim ORDER BY stays index-aligned.
drop index if exists public.outbox_pending_claim_idx;
create index outbox_pending_claim_idx
  on public.outbox (job_type, priority desc, run_at)
  where status = 'pending';

create or replace function public.claim_jobs("job_types" text[], "limit_value" integer default 5)
returns table("job_id" bigint, "org_id" uuid, "job_type" text, "payload" jsonb, "retry_count" integer)
language plpgsql
set search_path to 'public', 'pg_catalog'
as $$
DECLARE
  job_record RECORD;
  claimed_jobs bigint[] := ARRAY[]::bigint[];
BEGIN
  FOR job_record IN
    SELECT o.id, o.org_id, o.job_type, o.payload, o.retry_count
    FROM outbox o
    WHERE o.status = 'pending'
      AND o.job_type = ANY(job_types)
      AND o.run_at <= NOW()
    ORDER BY o.priority DESC, o.created_at ASC
    LIMIT limit_value
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE outbox
    SET status = 'processing', updated_at = NOW()
    WHERE id = job_record.id;

    claimed_jobs := array_append(claimed_jobs, job_record.id);

    job_id := job_record.id;
    org_id := job_record.org_id;
    job_type := job_record.job_type;
    payload := job_record.payload;
    retry_count := job_record.retry_count;

    RETURN NEXT;
  END LOOP;

  IF array_length(claimed_jobs, 1) > 0 THEN
    RAISE LOG 'Claimed jobs: %', claimed_jobs;
  END IF;
END;
$$;
