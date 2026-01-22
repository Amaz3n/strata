-- Add claim_jobs RPC function for safe job claiming with concurrency control
-- This prevents multiple workers from processing the same job simultaneously

CREATE OR REPLACE FUNCTION claim_jobs(
  job_types text[],
  limit_value integer DEFAULT 5
)
RETURNS TABLE (
  id bigint,
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
  -- Lock and select pending jobs in order, skipping locked ones
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
    -- Update the job status to processing
    UPDATE outbox
    SET status = 'processing', updated_at = NOW()
    WHERE id = job_record.id;

    -- Add to our results
    claimed_jobs := array_append(claimed_jobs, job_record.id);

    -- Return the job data
    id := job_record.id;
    org_id := job_record.org_id;
    job_type := job_record.job_type;
    payload := job_record.payload;
    retry_count := job_record.retry_count;

    RETURN NEXT;
  END LOOP;

  -- Log what we claimed (optional)
  IF array_length(claimed_jobs, 1) > 0 THEN
    RAISE LOG 'Claimed jobs: %', claimed_jobs;
  END IF;
END;
$$;

-- Grant execute permission to service role
GRANT EXECUTE ON FUNCTION claim_jobs(text[], integer) TO service_role;