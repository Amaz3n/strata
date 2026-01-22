-- Rename claim_jobs output to avoid ambiguous column reference
-- Provides explicit job_id column, which avoids ambiguity with other tables or context where "id" already exists.

CREATE OR REPLACE FUNCTION claim_jobs(
  job_types text[],
  limit_value integer DEFAULT 5
)
RETURNS TABLE (
  job_id bigint,
  org_id uuid,
  job_type text,
  payload jsonb,
  retry_count integer
)
LANGUAGE plpgsql
AS $$
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
    ORDER BY o.created_at ASC
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

GRANT EXECUTE ON FUNCTION claim_jobs(text[], integer) TO service_role;
