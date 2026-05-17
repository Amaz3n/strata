


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public";






CREATE TYPE "public"."approval_status" AS ENUM (
    'pending',
    'approved',
    'rejected',
    'canceled'
);


ALTER TYPE "public"."approval_status" OWNER TO "postgres";


CREATE TYPE "public"."audit_action" AS ENUM (
    'insert',
    'update',
    'delete'
);


ALTER TYPE "public"."audit_action" OWNER TO "postgres";


CREATE TYPE "public"."conversation_channel" AS ENUM (
    'internal',
    'client',
    'sub'
);


ALTER TYPE "public"."conversation_channel" OWNER TO "postgres";


CREATE TYPE "public"."event_channel" AS ENUM (
    'activity',
    'integration',
    'notification'
);


ALTER TYPE "public"."event_channel" OWNER TO "postgres";


CREATE TYPE "public"."license_status" AS ENUM (
    'issued',
    'active',
    'suspended',
    'expired'
);


ALTER TYPE "public"."license_status" OWNER TO "postgres";


CREATE TYPE "public"."membership_status" AS ENUM (
    'active',
    'invited',
    'suspended'
);


ALTER TYPE "public"."membership_status" OWNER TO "postgres";


CREATE TYPE "public"."notification_channel" AS ENUM (
    'in_app',
    'email',
    'sms',
    'webhook'
);


ALTER TYPE "public"."notification_channel" OWNER TO "postgres";


CREATE TYPE "public"."opportunity_status" AS ENUM (
    'new',
    'contacted',
    'qualified',
    'estimating',
    'proposed',
    'won',
    'lost'
);


ALTER TYPE "public"."opportunity_status" OWNER TO "postgres";


CREATE TYPE "public"."pricing_model" AS ENUM (
    'subscription',
    'license'
);


ALTER TYPE "public"."pricing_model" OWNER TO "postgres";


CREATE TYPE "public"."progress_basis" AS ENUM (
    'manual',
    'cost_to_cost',
    'schedule_linked'
);


ALTER TYPE "public"."progress_basis" OWNER TO "postgres";


CREATE TYPE "public"."project_property_type" AS ENUM (
    'residential',
    'commercial'
);


ALTER TYPE "public"."project_property_type" OWNER TO "postgres";


CREATE TYPE "public"."project_status" AS ENUM (
    'planning',
    'bidding',
    'active',
    'on_hold',
    'completed',
    'cancelled'
);


ALTER TYPE "public"."project_status" OWNER TO "postgres";


CREATE TYPE "public"."project_work_type" AS ENUM (
    'new_construction',
    'remodel',
    'addition',
    'renovation',
    'repair'
);


ALTER TYPE "public"."project_work_type" OWNER TO "postgres";


CREATE TYPE "public"."role_scope" AS ENUM (
    'org',
    'project',
    'platform',
    'external'
);


ALTER TYPE "public"."role_scope" OWNER TO "postgres";


CREATE TYPE "public"."subscription_status" AS ENUM (
    'trialing',
    'active',
    'past_due',
    'canceled'
);


ALTER TYPE "public"."subscription_status" OWNER TO "postgres";


CREATE TYPE "public"."task_priority" AS ENUM (
    'low',
    'normal',
    'high',
    'urgent'
);


ALTER TYPE "public"."task_priority" OWNER TO "postgres";


CREATE TYPE "public"."task_status" AS ENUM (
    'todo',
    'in_progress',
    'blocked',
    'done'
);


ALTER TYPE "public"."task_status" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."arc_benchmark_days_bucket"("p_days" integer) RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case
    when p_days is null or p_days < 0 then 'unknown'
    when p_days <= 7 then '0_7'
    when p_days <= 14 then '8_14'
    when p_days <= 30 then '15_30'
    when p_days <= 60 then '31_60'
    else '61_plus'
  end;
$$;


ALTER FUNCTION "public"."arc_benchmark_days_bucket"("p_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."arc_benchmark_normalize_trade"("p_trade" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select coalesce(
    nullif(
      regexp_replace(
        lower(trim(coalesce(p_trade, ''))),
        '\\s+',
        ' ',
        'g'
      ),
      ''
    ),
    'unknown'
  );
$$;


ALTER FUNCTION "public"."arc_benchmark_normalize_trade"("p_trade" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."arc_benchmark_value_bucket"("p_value" integer) RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case
    when p_value is null or p_value <= 0 then 'unknown'
    when p_value < 250000 then 'micro'
    when p_value < 1000000 then 'small'
    when p_value < 5000000 then 'medium'
    when p_value < 15000000 then 'large'
    else 'xlarge'
  end;
$$;


ALTER FUNCTION "public"."arc_benchmark_value_bucket"("p_value" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."budget_line_lock_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_budget_status text;
begin
  select b.status
  into v_budget_status
  from public.budgets b
  where b.id = coalesce(new.budget_id, old.budget_id)
  limit 1;

  if v_budget_status = 'locked' then
    raise exception 'Budget is locked and lines cannot be modified';
  end if;

  return coalesce(new, old);
end;
$$;


ALTER FUNCTION "public"."budget_line_lock_guard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."budget_lock_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
begin
  if old.status = 'locked' then
    if new.status <> 'locked'
      or new.total_cents is distinct from old.total_cents
      or new.project_id is distinct from old.project_id
      or new.metadata is distinct from old.metadata then
      raise exception 'Budget is locked and cannot be edited';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."budget_lock_guard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_jobs"("job_types" "text"[], "limit_value" integer DEFAULT 5) RETURNS TABLE("job_id" bigint, "org_id" "uuid", "job_type" "text", "payload" "jsonb", "retry_count" integer)
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_catalog'
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


ALTER FUNCTION "public"."claim_jobs"("job_types" "text"[], "limit_value" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_invoice_from_billable_costs_atomic"("p_org_id" "uuid", "p_project_id" "uuid", "p_actor_id" "uuid", "p_invoice_number" "text", "p_token" "text", "p_title" "text", "p_issue_date" "date", "p_due_date" "date", "p_from_date" "date", "p_to_date" "date", "p_group_by" "text", "p_cost_ids" "uuid"[], "p_preview" "jsonb", "p_idempotency_key" "text" DEFAULT NULL::"text", "p_reservation_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_existing_response jsonb;
  v_invoice_id uuid;
  v_locked_ids uuid[];
  v_line jsonb;
  v_line_id uuid;
  v_line_cost_ids uuid[];
  v_totals jsonb;
  v_cost_count integer;
begin
  if p_org_id is null or p_project_id is null then
    raise exception 'Organization and project are required';
  end if;

  if p_cost_ids is null or cardinality(p_cost_ids) = 0 then
    raise exception 'At least one billable cost is required';
  end if;

  if p_preview is null or jsonb_typeof(p_preview->'lines') <> 'array' then
    raise exception 'Invoice preview lines are required';
  end if;

  if p_idempotency_key is not null then
    select response
      into v_existing_response
      from public.idempotency_keys
      where org_id = p_org_id
        and scope = 'generate_invoice_from_costs'
        and key = p_idempotency_key
      limit 1;

    if (v_existing_response->>'invoiceId') is not null then
      return v_existing_response;
    end if;
  end if;

  select coalesce(array_agg(id), '{}'::uuid[])
    into v_locked_ids
    from (
      select id
      from public.billable_costs
      where org_id = p_org_id
        and project_id = p_project_id
        and status = 'open'
        and is_billable = true
        and id = any(p_cost_ids)
      for update
    ) locked;

  if cardinality(v_locked_ids) <> cardinality(p_cost_ids) then
    raise exception 'Some costs were already claimed by another invoice. Refresh and try again.';
  end if;

  v_totals := coalesce(p_preview->'totals', '{}'::jsonb);
  v_cost_count := cardinality(p_cost_ids);

  insert into public.invoices (
    org_id,
    project_id,
    token,
    invoice_number,
    title,
    status,
    issue_date,
    due_date,
    notes,
    client_visible,
    subtotal_cents,
    tax_cents,
    total_cents,
    balance_due_cents,
    metadata,
    sent_to_emails
  )
  values (
    p_org_id,
    p_project_id,
    p_token,
    p_invoice_number,
    p_title,
    'saved',
    p_issue_date,
    p_due_date,
    null,
    false,
    coalesce((v_totals->>'billable_cents')::integer, 0),
    0,
    coalesce((v_totals->>'billable_cents')::integer, 0),
    coalesce((v_totals->>'billable_cents')::integer, 0),
    jsonb_build_object(
      'source_type', 'from_costs',
      'date_range', jsonb_build_object('from', p_from_date, 'to', p_to_date),
      'group_by', p_group_by,
      'cost_count', v_cost_count,
      'total_cost_cents', coalesce((v_totals->>'cost_cents')::integer, 0),
      'total_markup_cents', coalesce((v_totals->>'markup_cents')::integer, 0),
      'idempotency_key', p_idempotency_key,
      'totals', jsonb_build_object(
        'subtotal_cents', coalesce((v_totals->>'billable_cents')::integer, 0),
        'tax_cents', 0,
        'total_cents', coalesce((v_totals->>'billable_cents')::integer, 0)
      ),
      'created_by', p_actor_id
    ),
    null
  )
  returning id into v_invoice_id;

  update public.billable_costs
     set status = 'locked'
   where org_id = p_org_id
     and id = any(p_cost_ids);

  for v_line in
    select value
    from jsonb_array_elements(p_preview->'lines') as value
  loop
    v_line_cost_ids := coalesce(
      array(select jsonb_array_elements_text(coalesce(v_line->'billable_cost_ids', '[]'::jsonb))::uuid),
      '{}'::uuid[]
    );

    insert into public.invoice_lines (
      org_id,
      invoice_id,
      cost_code_id,
      description,
      quantity,
      unit,
      unit_price_cents,
      sort_order,
      metadata
    )
    values (
      p_org_id,
      v_invoice_id,
      nullif(v_line->>'cost_code_id', '')::uuid,
      coalesce(v_line->>'description', 'Approved costs'),
      1,
      'LS',
      coalesce((v_line->>'billable_cents')::integer, 0),
      coalesce((v_line->>'sort_order')::integer, 0),
      jsonb_build_object(
        'source_type', 'from_costs',
        'billable_cost_ids', coalesce(v_line->'billable_cost_ids', '[]'::jsonb),
        'cost_cents', coalesce((v_line->>'cost_cents')::integer, 0),
        'markup_cents', coalesce((v_line->>'markup_cents')::integer, 0),
        'markup_percent', coalesce((v_line->>'markup_percent')::numeric, 0)
      )
    )
    returning id into v_line_id;

    if cardinality(v_line_cost_ids) > 0 then
      update public.billable_costs
         set invoice_id = v_invoice_id,
             invoice_line_id = v_line_id,
             status = 'billed',
             billed_at = now()
       where org_id = p_org_id
         and project_id = p_project_id
         and id = any(v_line_cost_ids)
         and id = any(p_cost_ids);
    end if;
  end loop;

  if exists (
    select 1
    from public.billable_costs
    where org_id = p_org_id
      and id = any(p_cost_ids)
      and status <> 'billed'
  ) then
    raise exception 'Not all billable costs were linked to invoice lines';
  end if;

  if p_reservation_id is not null then
    update public.qbo_invoice_reservations
       set status = 'used',
           used_by_invoice_id = v_invoice_id
     where org_id = p_org_id
       and id = p_reservation_id
       and status = 'reserved';
  end if;

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (org_id, key, scope, response)
    values (
      p_org_id,
      p_idempotency_key,
      'generate_invoice_from_costs',
      jsonb_build_object('invoiceId', v_invoice_id, 'invoicePreview', p_preview)
    )
    on conflict (org_id, scope, key)
    do update set response = excluded.response;
  end if;

  return jsonb_build_object('invoiceId', v_invoice_id, 'invoicePreview', p_preview);
end;
$$;


ALTER FUNCTION "public"."create_invoice_from_billable_costs_atomic"("p_org_id" "uuid", "p_project_id" "uuid", "p_actor_id" "uuid", "p_invoice_number" "text", "p_token" "text", "p_title" "text", "p_issue_date" "date", "p_due_date" "date", "p_from_date" "date", "p_to_date" "date", "p_group_by" "text", "p_cost_ids" "uuid"[], "p_preview" "jsonb", "p_idempotency_key" "text", "p_reservation_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_platform_membership_role_scope"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if not exists (
    select 1
    from public.roles r
    where r.id = new.role_id
      and r.scope = 'platform'
  ) then
    raise exception 'platform_memberships.role_id must reference a platform-scoped role';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_platform_membership_role_scope"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_next_version_number"("p_file_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_max_version integer;
BEGIN
  SELECT COALESCE(MAX(version_number), 0) + 1
  INTO v_max_version
  FROM doc_versions
  WHERE file_id = p_file_id;

  RETURN v_max_version;
END;
$$;


ALTER FUNCTION "public"."get_next_version_number"("p_file_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_user_sessions"() RETURNS TABLE("id" "uuid", "created_at" timestamp with time zone, "updated_at" timestamp with time zone, "last_active_at" timestamp with time zone, "user_agent" "text", "ip_address" "text", "is_current" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'auth', 'public', 'pg_temp'
    AS $$
DECLARE
    v_current_session_id uuid;
BEGIN
    -- Get current session ID from JWT claims safely
    v_current_session_id := (current_setting('request.jwt.claims', true)::jsonb ->> 'sid')::uuid;

    RETURN QUERY
    SELECT
        s.id,
        s.created_at,
        s.updated_at,
        s.refreshed_at as last_active_at,
        s.user_agent,
        s.ip::text as ip_address,
        (s.id = v_current_session_id) as is_current
    FROM auth.sessions s
    WHERE s.user_id = auth.uid()
    ORDER BY s.updated_at DESC;
END;
$$;


ALTER FUNCTION "public"."get_user_sessions"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_user_sessions"() IS 'Returns active sessions for the current user. (v1.0.1)';



CREATE OR REPLACE FUNCTION "public"."increment_portal_access"("token_id_input" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
BEGIN
  UPDATE portal_access_tokens
  SET access_count = COALESCE(access_count, 0) + 1,
      last_accessed_at = now()
  WHERE id = token_id_input;
END;
$$;


ALTER FUNCTION "public"."increment_portal_access"("token_id_input" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_org_admin_member"("check_org_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select exists (
    select 1
    from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.org_id = check_org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and r.scope = 'org'
      and r.key = 'org_admin'
  );
$$;


ALTER FUNCTION "public"."is_org_admin_member"("check_org_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_org_admin_member"("check_org_id" "uuid") IS 'Returns true when the current auth user has an active org_owner or org_office_admin membership.';



CREATE OR REPLACE FUNCTION "public"."is_org_member"("check_org_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$ select exists (select 1 from memberships m where m.org_id=check_org_id and m.user_id=auth.uid() and m.status='active'); $$;


ALTER FUNCTION "public"."is_org_member"("check_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_project_member"("check_project_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$ select exists (select 1 from project_members pm join projects p on p.id=pm.project_id where pm.project_id=check_project_id and pm.user_id=auth.uid() and pm.status='active' and pm.org_id=p.org_id); $$;


ALTER FUNCTION "public"."is_project_member"("check_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_search_embeddings"("p_org_id" "uuid", "p_query_embedding" "text", "p_limit" integer DEFAULT 20, "p_entity_types" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("document_id" "uuid", "entity_type" "text", "entity_id" "uuid", "project_id" "uuid", "title" "text", "metadata" "jsonb", "updated_at" timestamp with time zone, "similarity" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select
    d.id as document_id,
    d.entity_type,
    d.entity_id,
    d.project_id,
    d.title,
    d.metadata,
    d.updated_at,
    1 - (e.embedding <=> (p_query_embedding::vector)) as similarity
  from public.search_embeddings e
  join public.search_documents d on d.id = e.document_id
  where d.org_id = p_org_id
    and (
      coalesce(array_length(p_entity_types, 1), 0) = 0
      or d.entity_type = any(p_entity_types)
    )
  order by e.embedding <=> (p_query_embedding::vector)
  limit greatest(1, least(coalesce(p_limit, 20), 120));
$$;


ALTER FUNCTION "public"."match_search_embeddings"("p_org_id" "uuid", "p_query_embedding" "text", "p_limit" integer, "p_entity_types" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."next_rfi_number"("p_project_id" "uuid") RETURNS integer
    LANGUAGE "sql"
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
  SELECT COALESCE(MAX(rfi_number), 0) + 1 FROM rfis WHERE project_id = p_project_id;
$$;


ALTER FUNCTION "public"."next_rfi_number"("p_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."next_submittal_number"("p_project_id" "uuid") RETURNS integer
    LANGUAGE "sql"
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
  SELECT COALESCE(MAX(submittal_number), 0) + 1 FROM submittals WHERE project_id = p_project_id;
$$;


ALTER FUNCTION "public"."next_submittal_number"("p_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."photo_timeline_for_portal"("p_project_id" "uuid", "p_org_id" "uuid") RETURNS TABLE("week_start" timestamp with time zone, "week_end" timestamp with time zone, "photos" "jsonb", "summaries" "text"[])
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
  SELECT
    date_trunc('week', p.taken_at) AS week_start,
    date_trunc('week', p.taken_at) + INTERVAL '6 days' AS week_end,
    jsonb_agg(jsonb_build_object(
      'id', p.id,
      'url', f.storage_path,
      'taken_at', p.taken_at,
      'tags', p.tags
    ) ORDER BY p.taken_at) AS photos,
    ARRAY_AGG(dl.summary) FILTER (WHERE dl.summary IS NOT NULL) AS summaries
  FROM photos p
  JOIN files f ON f.id = p.file_id
  LEFT JOIN daily_logs dl ON dl.id = p.daily_log_id
  WHERE p.project_id = p_project_id AND p.org_id = p_org_id
  GROUP BY date_trunc('week', p.taken_at)
  ORDER BY week_start DESC;
$$;


ALTER FUNCTION "public"."photo_timeline_for_portal"("p_project_id" "uuid", "p_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_bid_submission_benchmark"("p_bid_submission_id" "uuid", "p_min_sample_size" integer DEFAULT 8, "p_min_orgs" integer DEFAULT 4) RETURNS TABLE("has_benchmark" boolean, "signal" "text", "message" "text", "match_level" "text", "sample_size" integer, "org_count" integer, "median_cents" integer, "p25_cents" integer, "p75_cents" integer, "submitted_total_cents" integer, "deviation_pct" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_submission record;
  v_sample_size integer;
  v_org_count integer;
  v_p25 integer;
  v_p50 integer;
  v_p75 integer;
  v_match_level text;
  v_signal text;
  v_message text;
  v_deviation numeric;
begin
  p_min_sample_size := greatest(coalesce(p_min_sample_size, 8), 1);
  p_min_orgs := greatest(coalesce(p_min_orgs, 4), 1);

  select
    bs.id as bid_submission_id,
    bs.org_id,
    bi.id as bid_invite_id,
    bp.id as bid_package_id,
    p.id as project_id,
    coalesce(nullif(lower(bs.currency), ''), 'usd') as currency,
    bs.total_cents,
    bs.status,
    arc_benchmark_normalize_trade(bp.trade) as normalized_trade,
    coalesce(p.project_type::text, 'unknown') as project_type,
    coalesce(p.property_type::text, 'unknown') as property_type,
    arc_benchmark_value_bucket(p.total_value) as project_value_bucket,
    arc_benchmark_days_bucket(bs.lead_time_days) as lead_time_bucket,
    arc_benchmark_days_bucket(bs.duration_days) as duration_bucket,
    bs.submitted_at
  into v_submission
  from bid_submissions bs
  join bid_invites bi
    on bi.id = bs.bid_invite_id
   and bi.org_id = bs.org_id
  join bid_packages bp
    on bp.id = bi.bid_package_id
   and bp.org_id = bi.org_id
  join projects p
    on p.id = bp.project_id
   and p.org_id = bp.org_id
  where bs.id = p_bid_submission_id
  limit 1;

  if not found then
    raise exception 'Bid submission % not found', p_bid_submission_id;
  end if;

  if v_submission.total_cents is null or v_submission.total_cents < 0 then
    return query
    select
      false,
      'insufficient_data'::text,
      'Benchmark unavailable for this submission.'::text,
      'none'::text,
      0,
      0,
      null::integer,
      null::integer,
      null::integer,
      v_submission.total_cents,
      null::numeric;
    return;
  end if;

  insert into arc_bid_benchmark_facts (
    org_id,
    bid_submission_id,
    bid_invite_id,
    bid_package_id,
    project_id,
    currency,
    total_cents,
    normalized_trade,
    project_type,
    property_type,
    project_value_bucket,
    lead_time_bucket,
    duration_bucket,
    submitted_at,
    updated_at
  )
  values (
    v_submission.org_id,
    v_submission.bid_submission_id,
    v_submission.bid_invite_id,
    v_submission.bid_package_id,
    v_submission.project_id,
    v_submission.currency,
    v_submission.total_cents,
    v_submission.normalized_trade,
    v_submission.project_type,
    v_submission.property_type,
    v_submission.project_value_bucket,
    v_submission.lead_time_bucket,
    v_submission.duration_bucket,
    v_submission.submitted_at,
    now()
  )
  on conflict (bid_submission_id)
  do update
  set
    org_id = excluded.org_id,
    bid_invite_id = excluded.bid_invite_id,
    bid_package_id = excluded.bid_package_id,
    project_id = excluded.project_id,
    currency = excluded.currency,
    total_cents = excluded.total_cents,
    normalized_trade = excluded.normalized_trade,
    project_type = excluded.project_type,
    property_type = excluded.property_type,
    project_value_bucket = excluded.project_value_bucket,
    lead_time_bucket = excluded.lead_time_bucket,
    duration_bucket = excluded.duration_bucket,
    submitted_at = excluded.submitted_at,
    updated_at = now();

  with level_candidates as (
    select 1 as level_rank, 'strict'::text as level_name, f.org_id, f.total_cents
    from arc_bid_benchmark_facts f
    join bid_submissions bs on bs.id = f.bid_submission_id and bs.org_id = f.org_id
    where bs.status in ('submitted', 'revised')
      and f.org_id <> v_submission.org_id
      and f.currency = v_submission.currency
      and f.normalized_trade = v_submission.normalized_trade
      and f.project_type = v_submission.project_type
      and f.property_type = v_submission.property_type
      and f.project_value_bucket = v_submission.project_value_bucket
      and f.lead_time_bucket = v_submission.lead_time_bucket
      and f.duration_bucket = v_submission.duration_bucket

    union all

    select 2 as level_rank, 'trade_type_size'::text as level_name, f.org_id, f.total_cents
    from arc_bid_benchmark_facts f
    join bid_submissions bs on bs.id = f.bid_submission_id and bs.org_id = f.org_id
    where bs.status in ('submitted', 'revised')
      and f.org_id <> v_submission.org_id
      and f.currency = v_submission.currency
      and f.normalized_trade = v_submission.normalized_trade
      and f.project_type = v_submission.project_type
      and f.property_type = v_submission.property_type
      and f.project_value_bucket = v_submission.project_value_bucket

    union all

    select 3 as level_rank, 'trade_and_type'::text as level_name, f.org_id, f.total_cents
    from arc_bid_benchmark_facts f
    join bid_submissions bs on bs.id = f.bid_submission_id and bs.org_id = f.org_id
    where bs.status in ('submitted', 'revised')
      and f.org_id <> v_submission.org_id
      and f.currency = v_submission.currency
      and f.normalized_trade = v_submission.normalized_trade
      and f.project_type = v_submission.project_type
      and f.property_type = v_submission.property_type

    union all

    select 4 as level_rank, 'trade_type_family'::text as level_name, f.org_id, f.total_cents
    from arc_bid_benchmark_facts f
    join bid_submissions bs on bs.id = f.bid_submission_id and bs.org_id = f.org_id
    where bs.status in ('submitted', 'revised')
      and f.org_id <> v_submission.org_id
      and f.currency = v_submission.currency
      and f.normalized_trade = v_submission.normalized_trade
      and f.project_type = v_submission.project_type

    union all

    select 5 as level_rank, 'trade_only'::text as level_name, f.org_id, f.total_cents
    from arc_bid_benchmark_facts f
    join bid_submissions bs on bs.id = f.bid_submission_id and bs.org_id = f.org_id
    where bs.status in ('submitted', 'revised')
      and f.org_id <> v_submission.org_id
      and f.currency = v_submission.currency
      and f.normalized_trade = v_submission.normalized_trade
  ),
  level_stats as (
    select
      level_rank,
      level_name,
      count(*)::integer as sample_size,
      count(distinct org_id)::integer as org_count,
      percentile_disc(0.25) within group (order by total_cents)::integer as p25_cents,
      percentile_disc(0.5) within group (order by total_cents)::integer as p50_cents,
      percentile_disc(0.75) within group (order by total_cents)::integer as p75_cents
    from level_candidates
    group by level_rank, level_name
  )
  select
    ls.sample_size,
    ls.org_count,
    ls.p25_cents,
    ls.p50_cents,
    ls.p75_cents,
    ls.level_name
  into
    v_sample_size,
    v_org_count,
    v_p25,
    v_p50,
    v_p75,
    v_match_level
  from level_stats ls
  where ls.sample_size >= p_min_sample_size
    and ls.org_count >= p_min_orgs
  order by ls.level_rank
  limit 1;

  if v_sample_size is null then
    return query
    select
      false,
      'insufficient_data'::text,
      'Not enough similar bids yet to produce a private benchmark.'::text,
      'none'::text,
      0,
      0,
      null::integer,
      null::integer,
      null::integer,
      v_submission.total_cents,
      null::numeric;
    return;
  end if;

  if v_p50 is not null and v_p50 > 0 then
    v_deviation := round((((v_submission.total_cents - v_p50)::numeric / v_p50::numeric) * 100)::numeric, 1);
  else
    v_deviation := null;
  end if;

  if v_submission.total_cents < v_p25 then
    v_signal := 'below_range';
    v_message := 'Based on similar bids, this price is below the typical range.';
  elsif v_submission.total_cents > v_p75 then
    v_signal := 'above_range';
    v_message := 'Based on similar bids, this price is above the typical range.';
  else
    v_signal := 'in_range';
    v_message := 'Based on similar bids, this price is within the typical range.';
  end if;

  return query
  select
    true,
    v_signal,
    v_message,
    v_match_level,
    v_sample_size,
    v_org_count,
    v_p50,
    v_p25,
    v_p75,
    v_submission.total_cents,
    v_deviation;
end;
$$;


ALTER FUNCTION "public"."record_bid_submission_benchmark"("p_bid_submission_id" "uuid", "p_min_sample_size" integer, "p_min_orgs" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_bid_submission_benchmarks"("p_bid_submission_ids" "uuid"[], "p_min_sample_size" integer DEFAULT 8, "p_min_orgs" integer DEFAULT 4) RETURNS TABLE("bid_submission_id" "uuid", "has_benchmark" boolean, "signal" "text", "message" "text", "match_level" "text", "sample_size" integer, "org_count" integer, "median_cents" integer, "p25_cents" integer, "p75_cents" integer, "submitted_total_cents" integer, "deviation_pct" numeric)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with requested as (
    select distinct bid_submission_id
    from unnest(coalesce(p_bid_submission_ids, '{}'::uuid[])) as t(bid_submission_id)
    where bid_submission_id is not null
  )
  select
    requested.bid_submission_id,
    benchmark.has_benchmark,
    benchmark.signal,
    benchmark.message,
    benchmark.match_level,
    benchmark.sample_size,
    benchmark.org_count,
    benchmark.median_cents,
    benchmark.p25_cents,
    benchmark.p75_cents,
    benchmark.submitted_total_cents,
    benchmark.deviation_pct
  from requested
  left join lateral public.record_bid_submission_benchmark(
    requested.bid_submission_id,
    p_min_sample_size,
    p_min_orgs
  ) as benchmark on true;
$$;


ALTER FUNCTION "public"."record_bid_submission_benchmarks"("p_bid_submission_ids" "uuid"[], "p_min_sample_size" integer, "p_min_orgs" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_drawing_sheets_list"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  REFRESH MATERIALIZED VIEW public.drawing_sheets_list_mv;
END;
$$;


ALTER FUNCTION "public"."refresh_drawing_sheets_list"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."revoke_user_session"("p_session_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'auth', 'public', 'pg_temp'
    AS $$
DECLARE
    v_current_session_id uuid;
BEGIN
    v_current_session_id := (current_setting('request.jwt.claims', true)::jsonb ->> 'sid')::uuid;

    DELETE FROM auth.sessions
    WHERE id = p_session_id
      AND user_id = auth.uid()
      AND id <> v_current_session_id;
END;
$$;


ALTER FUNCTION "public"."revoke_user_session"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."run_bid_award_conversion"("p_org_id" "uuid", "p_bid_submission_id" "uuid", "p_awarded_by" "uuid" DEFAULT NULL::"uuid", "p_notes" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_submission public.bid_submissions%rowtype;
  v_invite public.bid_invites%rowtype;
  v_package public.bid_packages%rowtype;
  v_existing_award public.bid_awards%rowtype;
  v_commitment public.commitments%rowtype;
  v_award public.bid_awards%rowtype;
  v_project_vendor_id uuid;
begin
  select *
  into v_submission
  from public.bid_submissions
  where org_id = p_org_id
    and id = p_bid_submission_id
  for update;

  if not found then
    raise exception 'Bid submission not found';
  end if;

  if coalesce(v_submission.is_current, false) = false then
    raise exception 'Only the current submission can be awarded';
  end if;

  if v_submission.total_cents is null then
    raise exception 'Submission total is required to award';
  end if;

  select *
  into v_invite
  from public.bid_invites
  where org_id = p_org_id
    and id = v_submission.bid_invite_id
  for update;

  if not found then
    raise exception 'Bid invite not found';
  end if;

  select *
  into v_package
  from public.bid_packages
  where org_id = p_org_id
    and id = v_invite.bid_package_id
  for update;

  if not found then
    raise exception 'Bid package not found';
  end if;

  if v_package.status = 'cancelled' then
    raise exception 'Cannot award a cancelled bid package';
  end if;

  select *
  into v_existing_award
  from public.bid_awards
  where org_id = p_org_id
    and bid_package_id = v_package.id
  order by awarded_at desc
  limit 1
  for update;

  if found then
    if v_existing_award.awarded_submission_id = p_bid_submission_id and v_existing_award.awarded_commitment_id is not null then
      return jsonb_build_object(
        'award_id', v_existing_award.id,
        'commitment_id', v_existing_award.awarded_commitment_id,
        'bid_package_id', v_package.id
      );
    end if;
    raise exception 'This bid package has already been awarded';
  end if;

  insert into public.commitments (
    org_id,
    project_id,
    company_id,
    title,
    status,
    total_cents,
    currency,
    issued_at,
    metadata
  )
  values (
    p_org_id,
    v_package.project_id,
    v_invite.company_id,
    concat(v_package.title, ' - Award'),
    'draft',
    v_submission.total_cents,
    coalesce(v_submission.currency, 'usd'),
    now(),
    jsonb_build_object(
      'source', 'bid_award',
      'bid_package_id', v_package.id,
      'bid_submission_id', v_submission.id,
      'cost_code_id', v_package.cost_code_id,
      'awarded_notes', p_notes
    )
  )
  returning *
  into v_commitment;

  if v_package.cost_code_id is not null then
    insert into public.commitment_lines (
      org_id,
      commitment_id,
      cost_code_id,
      description,
      quantity,
      unit,
      unit_cost_cents,
      sort_order,
      metadata
    )
    values (
      p_org_id,
      v_commitment.id,
      v_package.cost_code_id,
      coalesce(nullif(v_package.scope, ''), v_package.title),
      1,
      'LS',
      v_submission.total_cents,
      0,
      jsonb_build_object(
        'source', 'bid_award',
        'bid_package_id', v_package.id,
        'bid_submission_id', v_submission.id
      )
    );
  end if;

  insert into public.project_vendors (
    org_id,
    project_id,
    company_id,
    role,
    scope,
    status,
    notes
  )
  values (
    p_org_id,
    v_package.project_id,
    v_invite.company_id,
    'subcontractor',
    coalesce(v_package.trade, v_package.title),
    'active',
    coalesce(p_notes, concat('Awarded from bid package ', v_package.title))
  )
  on conflict (project_id, company_id)
  do update set
    role = excluded.role,
    scope = coalesce(public.project_vendors.scope, excluded.scope),
    status = 'active',
    notes = case
      when public.project_vendors.notes is null or public.project_vendors.notes = '' then excluded.notes
      else public.project_vendors.notes
    end,
    updated_at = now()
  returning id
  into v_project_vendor_id;

  insert into public.bid_awards (
    org_id,
    bid_package_id,
    awarded_submission_id,
    awarded_commitment_id,
    awarded_by,
    notes
  )
  values (
    p_org_id,
    v_package.id,
    v_submission.id,
    v_commitment.id,
    p_awarded_by,
    p_notes
  )
  returning *
  into v_award;

  update public.bid_packages
  set status = 'awarded', updated_at = now()
  where org_id = p_org_id
    and id = v_package.id;

  return jsonb_build_object(
    'award_id', v_award.id,
    'commitment_id', v_commitment.id,
    'bid_package_id', v_package.id,
    'project_vendor_id', v_project_vendor_id
  );
end;
$$;


ALTER FUNCTION "public"."run_bid_award_conversion"("p_org_id" "uuid", "p_bid_submission_id" "uuid", "p_awarded_by" "uuid", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."run_proposal_acceptance_conversion"("p_org_id" "uuid", "p_proposal_id" "uuid", "p_project_id" "uuid", "p_signature_data" "jsonb", "p_executed_file_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_proposal public.proposals%rowtype;
  v_contract public.contracts%rowtype;
  v_budget_id uuid;
  v_budget_status text;
  v_signed_at timestamptz;
  v_effective_date date;
  v_contract_created boolean := false;
  v_budget_created boolean := false;
  v_allowance_count integer := 0;
  v_project_opportunity_id uuid;
begin
  if p_project_id is null then
    raise exception 'Project is required for proposal acceptance';
  end if;

  select *
  into v_proposal
  from public.proposals
  where org_id = p_org_id
    and id = p_proposal_id
  for update;

  if not found then
    raise exception 'Proposal not found';
  end if;

  if v_proposal.valid_until is not null
    and v_proposal.valid_until < current_date
    and coalesce(v_proposal.status, 'draft') <> 'accepted' then
    raise exception 'Proposal has expired';
  end if;

  v_signed_at := coalesce((p_signature_data ->> 'signed_at')::timestamptz, now());
  v_effective_date := v_signed_at::date;

  update public.proposals
  set
    project_id = p_project_id,
    signature_data = coalesce(p_signature_data, signature_data),
    status = case when status = 'accepted' then status else 'accepted' end,
    accepted_at = case when status = 'accepted' then accepted_at else v_signed_at end,
    updated_at = now()
  where org_id = p_org_id
    and id = p_proposal_id
  returning *
  into v_proposal;

  select *
  into v_contract
  from public.contracts
  where org_id = p_org_id
    and proposal_id = p_proposal_id
  order by created_at desc
  limit 1
  for update;

  if not found then
    insert into public.contracts (
      org_id,
      project_id,
      proposal_id,
      number,
      title,
      status,
      total_cents,
      currency,
      signed_at,
      effective_date,
      terms,
      signature_data,
      snapshot
    )
    values (
      p_org_id,
      p_project_id,
      p_proposal_id,
      concat('C-', coalesce(nullif(regexp_replace(coalesce(v_proposal.number, ''), '^P-?', ''), ''), left(v_proposal.id::text, 6))),
      coalesce(v_proposal.title, 'Contract'),
      'active',
      v_proposal.total_cents,
      coalesce(v_proposal.currency, 'usd'),
      v_signed_at,
      v_effective_date,
      v_proposal.terms,
      p_signature_data,
      coalesce(v_proposal.snapshot, '{}'::jsonb)
        || case
          when p_executed_file_id is null then '{}'::jsonb
          else jsonb_build_object(
            'esign',
            jsonb_build_object(
              'executed_file_id', p_executed_file_id,
              'source', p_signature_data ->> 'source',
              'envelope_id', p_signature_data ->> 'envelope_id',
              'document_id', p_signature_data ->> 'document_id'
            )
          )
        end
    )
    returning *
    into v_contract;

    v_contract_created := true;
  else
    update public.contracts
    set
      project_id = p_project_id,
      status = case when status = 'draft' then 'active' else status end,
      total_cents = coalesce(v_proposal.total_cents, total_cents),
      signed_at = coalesce(signed_at, v_signed_at),
      effective_date = coalesce(effective_date, v_effective_date),
      terms = coalesce(v_proposal.terms, terms),
      signature_data = coalesce(p_signature_data, signature_data),
      snapshot = coalesce(snapshot, '{}'::jsonb)
        || coalesce(v_proposal.snapshot, '{}'::jsonb)
        || case
          when p_executed_file_id is null then '{}'::jsonb
          else jsonb_build_object(
            'esign',
            jsonb_build_object(
              'executed_file_id', p_executed_file_id,
              'source', p_signature_data ->> 'source',
              'envelope_id', p_signature_data ->> 'envelope_id',
              'document_id', p_signature_data ->> 'document_id'
            )
          )
        end,
      updated_at = now()
    where id = v_contract.id
    returning *
    into v_contract;
  end if;

  update public.draw_schedules
  set contract_id = v_contract.id, updated_at = now()
  where org_id = p_org_id
    and project_id = p_project_id
    and contract_id is null;

  if p_executed_file_id is not null
    and not exists (
      select 1
      from public.file_links
      where org_id = p_org_id
        and file_id = p_executed_file_id
        and entity_type = 'contract'
        and entity_id = v_contract.id
        and coalesce(link_role, '') = 'executed_contract'
    ) then
    insert into public.file_links (
      org_id,
      file_id,
      project_id,
      entity_type,
      entity_id,
      created_by,
      link_role
    )
    values (
      p_org_id,
      p_executed_file_id,
      p_project_id,
      'contract',
      v_contract.id,
      null,
      'executed_contract'
    );
  end if;

  select id, status
  into v_budget_id, v_budget_status
  from public.budgets
  where org_id = p_org_id
    and project_id = p_project_id
    and metadata ->> 'source_proposal_id' = p_proposal_id::text
  order by created_at desc
  limit 1
  for update;

  if v_budget_id is null then
    insert into public.budgets (
      org_id,
      project_id,
      status,
      total_cents,
      currency,
      metadata
    )
    values (
      p_org_id,
      p_project_id,
      'approved',
      coalesce((
        select sum((coalesce(unit_cost_cents, 0) * coalesce(quantity, 1))::integer)
        from public.proposal_lines
        where proposal_id = p_proposal_id
          and line_type <> 'section'
          and (coalesce(is_optional, false) = false or coalesce(is_selected, true) = true)
      ), 0),
      'usd',
      jsonb_build_object(
        'source', 'proposal_acceptance',
        'source_proposal_id', p_proposal_id,
        'source_contract_id', v_contract.id
      )
    )
    returning id, status
    into v_budget_id, v_budget_status;

    v_budget_created := true;
  elsif v_budget_status = 'locked' then
    raise exception 'Budget is locked and cannot be updated from proposal acceptance';
  else
    update public.budgets
    set
      status = case when status = 'locked' then status else 'approved' end,
      total_cents = coalesce((
        select sum((coalesce(unit_cost_cents, 0) * coalesce(quantity, 1))::integer)
        from public.proposal_lines
        where proposal_id = p_proposal_id
          and line_type <> 'section'
          and (coalesce(is_optional, false) = false or coalesce(is_selected, true) = true)
      ), 0),
      metadata = coalesce(metadata, '{}'::jsonb)
        || jsonb_build_object(
          'source', 'proposal_acceptance',
          'source_proposal_id', p_proposal_id,
          'source_contract_id', v_contract.id
        ),
      updated_at = now()
    where id = v_budget_id;
  end if;

  delete from public.budget_lines
  where budget_id = v_budget_id
    and metadata ->> 'source_proposal_id' = p_proposal_id::text;

  insert into public.budget_lines (
    org_id,
    budget_id,
    cost_code_id,
    description,
    amount_cents,
    metadata,
    sort_order
  )
  select
    p_org_id,
    v_budget_id,
    line.cost_code_id,
    line.description,
    (coalesce(line.unit_cost_cents, 0) * coalesce(line.quantity, 1))::integer,
    jsonb_build_object(
      'source', 'proposal_acceptance',
      'source_proposal_id', p_proposal_id,
      'source_proposal_line_id', line.id,
      'line_type', line.line_type
    ),
    coalesce(line.sort_order, 0)
  from public.proposal_lines line
  where line.proposal_id = p_proposal_id
    and line.line_type <> 'section'
    and (coalesce(line.is_optional, false) = false or coalesce(line.is_selected, true) = true);

  insert into public.allowances (
    org_id,
    project_id,
    contract_id,
    name,
    budget_cents,
    metadata
  )
  select
    p_org_id,
    p_project_id,
    v_contract.id,
    line.description,
    coalesce(line.allowance_cents, (coalesce(line.unit_cost_cents, 0) * coalesce(line.quantity, 1))::integer),
    jsonb_build_object(
      'source', 'proposal_acceptance',
      'source_proposal_id', p_proposal_id,
      'source_proposal_line_id', line.id
    )
  from public.proposal_lines line
  where line.proposal_id = p_proposal_id
    and line.line_type = 'allowance'
    and not exists (
      select 1
      from public.allowances allowance
      where allowance.org_id = p_org_id
        and allowance.project_id = p_project_id
        and allowance.contract_id = v_contract.id
        and allowance.metadata ->> 'source_proposal_line_id' = line.id::text
    );

  get diagnostics v_allowance_count = row_count;

  update public.projects
  set
    status = case when status in ('planning', 'bidding', 'on_hold') then 'active' else status end,
    total_value = coalesce(v_proposal.total_cents, total_value),
    updated_at = now()
  where org_id = p_org_id
    and id = p_project_id;

  select opportunity_id
  into v_project_opportunity_id
  from public.projects
  where org_id = p_org_id
    and id = p_project_id;

  if v_project_opportunity_id is not null then
    update public.opportunities
    set status = 'won', updated_at = now()
    where org_id = p_org_id
      and id = v_project_opportunity_id
      and status <> 'won';

    update public.proposals
    set opportunity_id = v_project_opportunity_id
    where org_id = p_org_id
      and id = p_proposal_id
      and opportunity_id is distinct from v_project_opportunity_id;
  end if;

  return jsonb_build_object(
    'proposal_id', v_proposal.id,
    'project_id', p_project_id,
    'contract_id', v_contract.id,
    'budget_id', v_budget_id,
    'contract_created_now', v_contract_created,
    'budget_created_now', v_budget_created,
    'allowance_count', v_allowance_count
  );
end;
$$;


ALTER FUNCTION "public"."run_proposal_acceptance_conversion"("p_org_id" "uuid", "p_proposal_id" "uuid", "p_project_id" "uuid", "p_signature_data" "jsonb", "p_executed_file_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."seed_compliance_document_types"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.compliance_document_types (org_id, name, code, description, has_expiry, is_system)
  values
    (new.id, 'W-9 Form', 'w9', 'IRS tax identification form', false, true),
    (new.id, 'Certificate of Insurance (COI)', 'coi', 'General liability insurance certificate', true, true),
    (new.id, 'Workers Compensation Certificate', 'workers_comp', 'Workers compensation insurance proof', true, true),
    (new.id, 'Contractor License', 'license', 'State or local contractor license', true, true),
    (new.id, 'Auto Insurance Certificate', 'auto_insurance', 'Commercial auto insurance certificate', true, true),
    (new.id, 'Umbrella / Excess Liability', 'umbrella', 'Excess liability policy documentation', true, true),
    (new.id, 'Performance / Payment Bond', 'bond', 'Surety bond certificate when required by contract', true, true),
    (new.id, 'Business License Registration', 'business_license', 'State/local business registration certificate', true, true),
    (new.id, 'Safety Program / OSHA', 'safety_program', 'Safety manual, OSHA logs, and training proof', false, true),
    (new.id, 'Signed Subcontract Agreement', 'signed_subcontract', 'Executed subcontract agreement and terms', false, true)
  on conflict (org_id, code) do nothing;

  return new;
end;
$$;


ALTER FUNCTION "public"."seed_compliance_document_types"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_project_file_folder_permissions_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_project_file_folder_permissions_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tg_documents_sync_source_entity_from_metadata"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $_$
begin
  if new.source_entity_id is not null and new.source_entity_type is not null then
    return new;
  end if;

  if (new.metadata ? 'proposal_id')
     and (new.metadata ->> 'proposal_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    new.source_entity_type := coalesce(new.source_entity_type, 'proposal');
    new.source_entity_id := coalesce(new.source_entity_id, (new.metadata ->> 'proposal_id')::uuid);
    return new;
  end if;

  if (new.metadata ? 'change_order_id')
     and (new.metadata ->> 'change_order_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    new.source_entity_type := coalesce(new.source_entity_type, 'change_order');
    new.source_entity_id := coalesce(new.source_entity_id, (new.metadata ->> 'change_order_id')::uuid);
    return new;
  end if;

  if (new.metadata ? 'lien_waiver_id')
     and (new.metadata ->> 'lien_waiver_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    new.source_entity_type := coalesce(new.source_entity_type, 'lien_waiver');
    new.source_entity_id := coalesce(new.source_entity_id, (new.metadata ->> 'lien_waiver_id')::uuid);
    return new;
  end if;

  return new;
end
$_$;


ALTER FUNCTION "public"."tg_documents_sync_source_entity_from_metadata"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tg_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$ begin new.updated_at = now(); return new; end; $$;


ALTER FUNCTION "public"."tg_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_conversation_last_message_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
BEGIN
  UPDATE conversations
  SET last_message_at = NEW.sent_at
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_conversation_last_message_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_drawing_markups_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_drawing_markups_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_drawing_pins_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_drawing_pins_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_drawing_sets_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_drawing_sets_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_drawing_sheets_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_drawing_sheets_updated_at"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."ai_search_action_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "session_id" "uuid",
    "tool_key" "text" NOT NULL,
    "title" "text" NOT NULL,
    "summary" "text" NOT NULL,
    "args" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "requires_approval" boolean DEFAULT true NOT NULL,
    "status" "text" DEFAULT 'proposed'::"text" NOT NULL,
    "result" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "executed_at" timestamp with time zone,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL,
    CONSTRAINT "ai_search_action_requests_status_check" CHECK (("status" = ANY (ARRAY['proposed'::"text", 'executed'::"text", 'rejected'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."ai_search_action_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_search_artifacts" (
    "id" "uuid" NOT NULL,
    "org_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "columns" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "rows" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '1 day'::interval) NOT NULL
);


ALTER TABLE "public"."ai_search_artifacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_search_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "session_id" "uuid",
    "query" "text" NOT NULL,
    "assistant_mode" "text" DEFAULT 'org'::"text" NOT NULL,
    "plan" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "metrics" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "citations_count" integer DEFAULT 0 NOT NULL,
    "results_count" integer DEFAULT 0 NOT NULL,
    "latency_ms" integer DEFAULT 0 NOT NULL,
    "success" boolean DEFAULT true NOT NULL,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_search_events_assistant_mode_check" CHECK (("assistant_mode" = ANY (ARRAY['org'::"text", 'general'::"text"])))
);


ALTER TABLE "public"."ai_search_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_search_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "org_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_search_messages_role_check" CHECK (("role" = ANY (ARRAY['system'::"text", 'user'::"text", 'assistant'::"text"])))
);


ALTER TABLE "public"."ai_search_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_search_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "mode" "text" DEFAULT 'org'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_search_sessions_mode_check" CHECK (("mode" = ANY (ARRAY['org'::"text", 'general'::"text"])))
);


ALTER TABLE "public"."ai_search_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."allowances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "contract_id" "uuid",
    "selection_category_id" "uuid",
    "name" "text" NOT NULL,
    "budget_cents" integer NOT NULL,
    "used_cents" integer DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "overage_handling" "text" DEFAULT 'co'::"text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "allowances_budget_cents_check" CHECK (("budget_cents" >= 0)),
    CONSTRAINT "allowances_overage_handling_check" CHECK (("overage_handling" = ANY (ARRAY['co'::"text", 'client_direct'::"text", 'absorb'::"text"]))),
    CONSTRAINT "allowances_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'at_budget'::"text", 'over'::"text", 'closed'::"text"]))),
    CONSTRAINT "allowances_used_cents_check" CHECK (("used_cents" >= 0))
);


ALTER TABLE "public"."allowances" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app_users" (
    "id" "uuid" NOT NULL,
    "email" "public"."citext" NOT NULL,
    "full_name" "text",
    "avatar_url" "text",
    "onboarded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."app_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."approvals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "requested_by" "uuid",
    "approver_id" "uuid",
    "status" "public"."approval_status" DEFAULT 'pending'::"public"."approval_status" NOT NULL,
    "due_at" timestamp with time zone,
    "decision_at" timestamp with time zone,
    "decision_notes" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "signature_data" "text",
    "signature_ip" "inet",
    "signed_at" timestamp with time zone
);


ALTER TABLE "public"."approvals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."arc_bid_benchmark_facts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "bid_submission_id" "uuid" NOT NULL,
    "bid_invite_id" "uuid" NOT NULL,
    "bid_package_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "currency" "text" DEFAULT 'usd'::"text" NOT NULL,
    "total_cents" integer NOT NULL,
    "normalized_trade" "text" NOT NULL,
    "project_type" "text" NOT NULL,
    "property_type" "text" NOT NULL,
    "project_value_bucket" "text" NOT NULL,
    "lead_time_bucket" "text" NOT NULL,
    "duration_bucket" "text" NOT NULL,
    "submitted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "arc_bid_benchmark_facts_total_cents_check" CHECK (("total_cents" >= 0))
);


ALTER TABLE "public"."arc_bid_benchmark_facts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_log" (
    "id" bigint NOT NULL,
    "org_id" "uuid" NOT NULL,
    "actor_user_id" "uuid",
    "action" "public"."audit_action" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid",
    "before_data" "jsonb",
    "after_data" "jsonb",
    "source" "text",
    "ip_address" "inet",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."audit_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."audit_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."audit_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."audit_log_id_seq" OWNED BY "public"."audit_log"."id";



CREATE TABLE IF NOT EXISTS "public"."authorization_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actor_user_id" "uuid",
    "org_id" "uuid",
    "project_id" "uuid",
    "action_key" "text" NOT NULL,
    "resource_type" "text",
    "resource_id" "text",
    "decision" "text" NOT NULL,
    "reason_code" "text",
    "policy_version" "text",
    "context" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "impersonation_session_id" "uuid",
    "request_id" "text",
    "ip" "inet",
    "user_agent" "text",
    CONSTRAINT "authorization_audit_log_decision_check" CHECK (("decision" = ANY (ARRAY['allow'::"text", 'deny'::"text"])))
);


ALTER TABLE "public"."authorization_audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bid_access_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "bid_invite_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "expires_at" timestamp with time zone,
    "max_access_count" integer,
    "access_count" integer DEFAULT 0 NOT NULL,
    "last_accessed_at" timestamp with time zone,
    "pin_required" boolean DEFAULT false NOT NULL,
    "pin_hash" "text",
    "pin_attempts" integer DEFAULT 0 NOT NULL,
    "pin_locked_until" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "paused_at" timestamp with time zone,
    "require_account" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."bid_access_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bid_addenda" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "bid_package_id" "uuid" NOT NULL,
    "number" integer NOT NULL,
    "title" "text",
    "message" "text",
    "issued_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid"
);


ALTER TABLE "public"."bid_addenda" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bid_addendum_acknowledgements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "bid_addendum_id" "uuid" NOT NULL,
    "bid_invite_id" "uuid" NOT NULL,
    "acknowledged_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."bid_addendum_acknowledgements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bid_awards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "bid_package_id" "uuid" NOT NULL,
    "awarded_submission_id" "uuid" NOT NULL,
    "awarded_commitment_id" "uuid",
    "awarded_by" "uuid",
    "awarded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "notes" "text"
);


ALTER TABLE "public"."bid_awards" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bid_invites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "bid_package_id" "uuid" NOT NULL,
    "company_id" "uuid" NOT NULL,
    "contact_id" "uuid",
    "invite_email" "public"."citext",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "sent_at" timestamp with time zone,
    "last_viewed_at" timestamp with time zone,
    "submitted_at" timestamp with time zone,
    "declined_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bid_invites_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sent'::"text", 'viewed'::"text", 'declined'::"text", 'submitted'::"text", 'withdrawn'::"text"])))
);


ALTER TABLE "public"."bid_invites" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bid_packages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "trade" "text",
    "scope" "text",
    "instructions" "text",
    "due_at" timestamp with time zone,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cost_code_id" "uuid",
    CONSTRAINT "bid_packages_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sent'::"text", 'open'::"text", 'closed'::"text", 'awarded'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."bid_packages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bid_submissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "bid_invite_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'submitted'::"text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "is_current" boolean DEFAULT true NOT NULL,
    "total_cents" integer,
    "currency" "text" DEFAULT 'usd'::"text" NOT NULL,
    "valid_until" "date",
    "lead_time_days" integer,
    "duration_days" integer,
    "start_available_on" "date",
    "exclusions" "text",
    "clarifications" "text",
    "notes" "text",
    "submitted_by_name" "text",
    "submitted_by_email" "public"."citext",
    "submitted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bid_submissions_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'submitted'::"text", 'revised'::"text", 'withdrawn'::"text"])))
);


ALTER TABLE "public"."bid_submissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bill_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "bill_id" "uuid" NOT NULL,
    "cost_code_id" "uuid",
    "description" "text" NOT NULL,
    "quantity" numeric DEFAULT 1 NOT NULL,
    "unit" "text",
    "unit_cost_cents" integer,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "sort_order" integer DEFAULT 0
);


ALTER TABLE "public"."bill_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billable_costs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "cost_code_id" "uuid",
    "source_type" "text" NOT NULL,
    "source_id" "uuid" NOT NULL,
    "source_company_id" "uuid",
    "occurred_on" "date" NOT NULL,
    "description" "text",
    "cost_cents" integer NOT NULL,
    "markup_percent_resolved" numeric DEFAULT 0 NOT NULL,
    "markup_cents" integer DEFAULT 0 NOT NULL,
    "billable_cents" integer GENERATED ALWAYS AS (("cost_cents" + "markup_cents")) STORED,
    "is_billable" boolean DEFAULT true NOT NULL,
    "invoice_id" "uuid",
    "invoice_line_id" "uuid",
    "billed_at" timestamp with time zone,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "billable_costs_source_type_check" CHECK (("source_type" = ANY (ARRAY['vendor_bill_line'::"text", 'project_expense'::"text", 'time_entry'::"text", 'manual_adjustment'::"text", 'allowance_overage'::"text"]))),
    CONSTRAINT "billable_costs_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'locked'::"text", 'billed'::"text", 'excluded'::"text", 'voided'::"text"])))
);


ALTER TABLE "public"."billable_costs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."budget_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "budget_id" "uuid" NOT NULL,
    "cost_code_id" "uuid",
    "description" "text" NOT NULL,
    "amount_cents" integer,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "sort_order" integer DEFAULT 0,
    "forecast_remaining_cents" bigint
);


ALTER TABLE "public"."budget_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."budget_revision_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "budget_revision_id" "uuid" NOT NULL,
    "cost_code_id" "uuid",
    "change_order_line_id" "uuid",
    "description" "text",
    "amount_cents" integer DEFAULT 0 NOT NULL,
    "allowance_draw_cents" integer DEFAULT 0 NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."budget_revision_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."budget_revisions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "change_order_id" "uuid",
    "revision_type" "text" DEFAULT 'change_order'::"text" NOT NULL,
    "status" "text" DEFAULT 'posted'::"text" NOT NULL,
    "title" "text",
    "total_cents" integer DEFAULT 0 NOT NULL,
    "posted_by" "uuid",
    "posted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."budget_revisions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."budget_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "budget_id" "uuid" NOT NULL,
    "snapshot_date" "date" NOT NULL,
    "total_budget_cents" integer NOT NULL,
    "total_committed_cents" integer NOT NULL,
    "total_actual_cents" integer NOT NULL,
    "total_invoiced_cents" integer NOT NULL,
    "variance_cents" integer NOT NULL,
    "margin_percent" numeric,
    "by_cost_code" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."budget_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."budgets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "total_cents" integer,
    "currency" "text" DEFAULT 'usd'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."budgets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."change_order_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "change_order_id" "uuid" NOT NULL,
    "cost_code_id" "uuid",
    "description" "text" NOT NULL,
    "quantity" numeric DEFAULT 1 NOT NULL,
    "unit" "text",
    "unit_cost_cents" integer,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "sort_order" integer DEFAULT 0
);


ALTER TABLE "public"."change_order_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."change_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "contract_id" "uuid",
    "title" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "reason" "text",
    "total_cents" integer,
    "currency" "text" DEFAULT 'usd'::"text" NOT NULL,
    "requested_by" "uuid",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "rejected_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "client_visible" boolean DEFAULT false NOT NULL,
    "requires_signature" boolean DEFAULT true NOT NULL,
    "days_impact" integer,
    "summary" "text"
);


ALTER TABLE "public"."change_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."change_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "requested_by" "uuid",
    "title" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "estimate_cents" integer,
    "approved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."change_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."closeout_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "closeout_package_id" "uuid",
    "title" "text" NOT NULL,
    "status" "text" DEFAULT 'missing'::"text",
    "file_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."closeout_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."closeout_packages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'in_progress'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."closeout_packages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."commitment_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "commitment_id" "uuid" NOT NULL,
    "cost_code_id" "uuid",
    "description" "text" NOT NULL,
    "quantity" numeric DEFAULT 1 NOT NULL,
    "unit" "text",
    "unit_cost_cents" integer,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "sort_order" integer DEFAULT 0
);


ALTER TABLE "public"."commitment_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."commitments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "company_id" "uuid",
    "title" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "total_cents" integer,
    "currency" "text" DEFAULT 'usd'::"text" NOT NULL,
    "issued_at" timestamp with time zone,
    "start_date" "date",
    "end_date" "date",
    "external_reference" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."commitments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."companies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "company_type" "text",
    "phone" "text",
    "email" "text",
    "website" "text",
    "address" "jsonb",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "license_number" "text",
    "prequalified" boolean DEFAULT false,
    "prequalified_at" timestamp with time zone,
    "rating" integer,
    "default_payment_terms" "text",
    "internal_notes" "text",
    "notes" "text"
);


ALTER TABLE "public"."companies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."company_compliance_requirements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "company_id" "uuid" NOT NULL,
    "document_type_id" "uuid" NOT NULL,
    "is_required" boolean DEFAULT true NOT NULL,
    "min_coverage_cents" bigint,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "requires_additional_insured" boolean DEFAULT false NOT NULL,
    "requires_primary_noncontributory" boolean DEFAULT false NOT NULL,
    "requires_waiver_of_subrogation" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."company_compliance_requirements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."compliance_document_types" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "code" "text" NOT NULL,
    "description" "text",
    "has_expiry" boolean DEFAULT true NOT NULL,
    "expiry_warning_days" integer DEFAULT 30 NOT NULL,
    "is_system" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."compliance_document_types" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."compliance_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "company_id" "uuid" NOT NULL,
    "document_type_id" "uuid" NOT NULL,
    "requirement_id" "uuid",
    "file_id" "uuid",
    "status" "text" DEFAULT 'pending_review'::"text" NOT NULL,
    "effective_date" "date",
    "expiry_date" "date",
    "policy_number" "text",
    "coverage_amount_cents" bigint,
    "carrier_name" "text",
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "review_notes" "text",
    "rejection_reason" "text",
    "submitted_via_portal" boolean DEFAULT false NOT NULL,
    "portal_token_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "additional_insured" boolean DEFAULT false NOT NULL,
    "primary_noncontributory" boolean DEFAULT false NOT NULL,
    "waiver_of_subrogation" boolean DEFAULT false NOT NULL,
    CONSTRAINT "compliance_documents_status_check" CHECK (("status" = ANY (ARRAY['pending_review'::"text", 'approved'::"text", 'rejected'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."compliance_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_company_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "company_id" "uuid" NOT NULL,
    "relationship" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."contact_company_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "primary_company_id" "uuid",
    "full_name" "text" NOT NULL,
    "email" "public"."citext",
    "phone" "text",
    "role" "text",
    "contact_type" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "external_crm_id" "text",
    "crm_source" "text",
    "address" "jsonb"
);


ALTER TABLE "public"."contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contracts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "proposal_id" "uuid",
    "title" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "total_cents" integer,
    "currency" "text" DEFAULT 'usd'::"text" NOT NULL,
    "signed_at" timestamp with time zone,
    "effective_date" "date",
    "terms" "text",
    "snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "number" "text",
    "contract_type" "text" DEFAULT 'fixed'::"text",
    "markup_percent" numeric,
    "retainage_percent" numeric DEFAULT 0,
    "retainage_release_trigger" "text",
    "signature_data" "jsonb",
    "gmp_cents" integer,
    "savings_split_owner_pct" numeric DEFAULT 0,
    "savings_split_builder_pct" numeric DEFAULT 0,
    "labor_burden_multiplier" numeric DEFAULT 1.0,
    "requires_client_cost_approval" boolean DEFAULT false NOT NULL,
    "open_book" boolean DEFAULT true NOT NULL,
    CONSTRAINT "contracts_contract_type_check" CHECK (("contract_type" = ANY (ARRAY['fixed'::"text", 'cost_plus'::"text", 'time_materials'::"text"]))),
    CONSTRAINT "contracts_gmp_cents_check" CHECK ((("gmp_cents" IS NULL) OR ("gmp_cents" >= 0))),
    CONSTRAINT "contracts_labor_burden_multiplier_check" CHECK (("labor_burden_multiplier" >= 1.0)),
    CONSTRAINT "contracts_savings_split_builder_pct_check" CHECK ((("savings_split_builder_pct" >= (0)::numeric) AND ("savings_split_builder_pct" <= (100)::numeric))),
    CONSTRAINT "contracts_savings_split_owner_pct_check" CHECK ((("savings_split_owner_pct" >= (0)::numeric) AND ("savings_split_owner_pct" <= (100)::numeric))),
    CONSTRAINT "contracts_savings_split_total_chk" CHECK (((COALESCE("savings_split_owner_pct", (0)::numeric) + COALESCE("savings_split_builder_pct", (0)::numeric)) <= (100)::numeric))
);


ALTER TABLE "public"."contracts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversation_read_states" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "contact_id" "uuid",
    "last_read_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_read_message_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "conversation_read_states_actor_check" CHECK (((("user_id" IS NOT NULL) AND ("contact_id" IS NULL)) OR (("user_id" IS NULL) AND ("contact_id" IS NOT NULL))))
);


ALTER TABLE "public"."conversation_read_states" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "subject" "text",
    "channel" "public"."conversation_channel" DEFAULT 'internal'::"public"."conversation_channel" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "audience_company_id" "uuid",
    "audience_contact_id" "uuid",
    "last_message_at" timestamp with time zone
);


ALTER TABLE "public"."conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversion_run_steps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "conversion_run_id" "uuid" NOT NULL,
    "step_key" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error_message" "text",
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "conversion_run_steps_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'running'::"text", 'completed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."conversion_run_steps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversion_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "conversion_type" "text" NOT NULL,
    "source_entity_type" "text" NOT NULL,
    "source_entity_id" "uuid" NOT NULL,
    "target_entity_type" "text",
    "target_entity_id" "uuid",
    "project_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "triggered_by" "uuid",
    "error_message" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "result" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "conversion_runs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'running'::"text", 'completed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."conversion_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cost_approval_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "billable_cost_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "time_entry_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "approved_at" timestamp with time zone,
    "rejected_at" timestamp with time zone,
    "rejection_reason" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cost_approval_batches_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."cost_approval_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cost_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "parent_id" "uuid",
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "category" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "division" "text",
    "standard" "text" DEFAULT 'custom'::"text",
    "unit" "text",
    "default_unit_cost_cents" integer,
    "is_active" boolean DEFAULT true,
    "is_reimbursable_default" boolean DEFAULT true NOT NULL,
    "default_markup_percent" numeric,
    CONSTRAINT "cost_codes_default_markup_percent_check" CHECK ((("default_markup_percent" IS NULL) OR (("default_markup_percent" >= (0)::numeric) AND ("default_markup_percent" <= (200)::numeric))))
);


ALTER TABLE "public"."cost_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_field_values" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "field_id" "uuid" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "value" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."custom_field_values" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_fields" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "entity_type" "text" NOT NULL,
    "key" "text" NOT NULL,
    "label" "text" NOT NULL,
    "field_type" "text" NOT NULL,
    "required" boolean DEFAULT false NOT NULL,
    "options" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."custom_fields" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."daily_log_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "daily_log_id" "uuid" NOT NULL,
    "entry_type" "text" DEFAULT 'note'::"text" NOT NULL,
    "description" "text",
    "quantity" numeric,
    "hours" numeric,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "schedule_item_id" "uuid",
    "task_id" "uuid",
    "punch_item_id" "uuid",
    "cost_code_id" "uuid",
    "location" "text",
    "trade" "text",
    "labor_type" "text",
    "inspection_result" "text",
    "progress" integer
);


ALTER TABLE "public"."daily_log_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."daily_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "log_date" "date" NOT NULL,
    "weather" "jsonb",
    "summary" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."daily_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."decisions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'requested'::"text",
    "due_date" "date",
    "approved_at" timestamp with time zone,
    "approved_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."decisions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."doc_versions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "file_id" "uuid" NOT NULL,
    "version_number" integer DEFAULT 1 NOT NULL,
    "label" "text",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "storage_path" "text",
    "mime_type" "text",
    "size_bytes" bigint,
    "checksum" "text",
    "file_name" "text"
);


ALTER TABLE "public"."doc_versions" OWNER TO "postgres";


COMMENT ON COLUMN "public"."doc_versions"."storage_path" IS 'Storage path for this version''s blob';



COMMENT ON COLUMN "public"."doc_versions"."mime_type" IS 'MIME type of this version';



COMMENT ON COLUMN "public"."doc_versions"."size_bytes" IS 'File size in bytes for this version';



COMMENT ON COLUMN "public"."doc_versions"."checksum" IS 'Checksum/hash of this version''s file';



COMMENT ON COLUMN "public"."doc_versions"."file_name" IS 'Original filename for this version';



CREATE TABLE IF NOT EXISTS "public"."document_fields" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "document_id" "uuid" NOT NULL,
    "revision" integer DEFAULT 1 NOT NULL,
    "page_index" integer NOT NULL,
    "field_type" "text" NOT NULL,
    "label" "text",
    "required" boolean DEFAULT true NOT NULL,
    "signer_role" "text" DEFAULT 'client'::"text" NOT NULL,
    "x" numeric NOT NULL,
    "y" numeric NOT NULL,
    "w" numeric NOT NULL,
    "h" numeric NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "document_fields_field_type_check" CHECK (("field_type" = ANY (ARRAY['signature'::"text", 'initials'::"text", 'text'::"text", 'date'::"text", 'checkbox'::"text", 'name'::"text"]))),
    CONSTRAINT "document_fields_h_check" CHECK ((("h" > (0)::numeric) AND ("h" <= (1)::numeric))),
    CONSTRAINT "document_fields_page_index_check" CHECK (("page_index" >= 0)),
    CONSTRAINT "document_fields_w_check" CHECK ((("w" > (0)::numeric) AND ("w" <= (1)::numeric))),
    CONSTRAINT "document_fields_x_check" CHECK ((("x" >= (0)::numeric) AND ("x" <= (1)::numeric))),
    CONSTRAINT "document_fields_y_check" CHECK ((("y" >= (0)::numeric) AND ("y" <= (1)::numeric)))
);


ALTER TABLE "public"."document_fields" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."document_packet_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "packet_id" "uuid" NOT NULL,
    "file_id" "uuid" NOT NULL,
    "sort_order" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."document_packet_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."document_packets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "packet_type" "text" NOT NULL,
    "is_shared_with_clients" boolean DEFAULT false,
    "is_shared_with_subs" boolean DEFAULT false,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."document_packets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."document_signatures" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "signing_request_id" "uuid" NOT NULL,
    "document_id" "uuid" NOT NULL,
    "revision" integer NOT NULL,
    "signer_name" "text",
    "signer_email" "public"."citext",
    "signer_ip" "inet",
    "user_agent" "text",
    "consent_text" "text" NOT NULL,
    "values" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."document_signatures" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."document_signing_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "document_id" "uuid" NOT NULL,
    "revision" integer NOT NULL,
    "token_hash" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "recipient_contact_id" "uuid",
    "sent_to_email" "public"."citext",
    "sent_at" timestamp with time zone,
    "viewed_at" timestamp with time zone,
    "signed_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "max_uses" integer DEFAULT 1 NOT NULL,
    "used_count" integer DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "group_id" "uuid",
    "signer_role" "text" DEFAULT 'client'::"text" NOT NULL,
    "sequence" integer DEFAULT 1 NOT NULL,
    "required" boolean DEFAULT true NOT NULL,
    "envelope_id" "uuid",
    "envelope_recipient_id" "uuid",
    CONSTRAINT "document_signing_requests_sequence_positive_chk" CHECK (("sequence" >= 1)),
    CONSTRAINT "document_signing_requests_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sent'::"text", 'viewed'::"text", 'signed'::"text", 'voided'::"text", 'expired'::"text"]))),
    CONSTRAINT "document_signing_requests_uses_bounds_chk" CHECK ((("max_uses" >= 1) AND ("used_count" >= 0) AND ("used_count" <= "max_uses")))
);


ALTER TABLE "public"."document_signing_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "document_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "source_file_id" "uuid" NOT NULL,
    "executed_file_id" "uuid",
    "current_revision" integer DEFAULT 1 NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source_entity_type" "text",
    "source_entity_id" "uuid",
    CONSTRAINT "documents_document_type_check" CHECK (("document_type" = ANY (ARRAY['proposal'::"text", 'contract'::"text", 'change_order'::"text", 'other'::"text"]))),
    CONSTRAINT "documents_source_entity_type_chk" CHECK ((("source_entity_type" IS NULL) OR ("source_entity_type" = ANY (ARRAY['proposal'::"text", 'change_order'::"text", 'lien_waiver'::"text", 'selection'::"text", 'subcontract'::"text", 'closeout'::"text", 'other'::"text"])))),
    CONSTRAINT "documents_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sent'::"text", 'signed'::"text", 'voided'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."draw_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "invoice_id" "uuid",
    "contract_id" "uuid",
    "draw_number" integer NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "amount_cents" integer NOT NULL,
    "percent_of_contract" numeric,
    "due_date" "date",
    "due_trigger" "text",
    "milestone_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "invoiced_at" timestamp with time zone,
    "paid_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "draw_schedules_amount_cents_check" CHECK (("amount_cents" >= 0)),
    CONSTRAINT "draw_schedules_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'invoiced'::"text", 'partial'::"text", 'paid'::"text"])))
);


ALTER TABLE "public"."draw_schedules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."drawing_markups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "drawing_sheet_id" "uuid" NOT NULL,
    "sheet_version_id" "uuid",
    "data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "label" "text",
    "is_private" boolean DEFAULT false NOT NULL,
    "share_with_clients" boolean DEFAULT false NOT NULL,
    "share_with_subs" boolean DEFAULT false NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."drawing_markups" OWNER TO "postgres";


COMMENT ON TABLE "public"."drawing_markups" IS 'Vector annotations on drawing sheets (arrows, circles, text, etc.)';



COMMENT ON COLUMN "public"."drawing_markups"."data" IS 'JSON object containing annotation type and vector data: type, points, color, strokeWidth, text, fontSize, style';



COMMENT ON COLUMN "public"."drawing_markups"."is_private" IS 'If true, only visible to the creator';



CREATE TABLE IF NOT EXISTS "public"."drawing_pins" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "drawing_sheet_id" "uuid" NOT NULL,
    "sheet_version_id" "uuid",
    "x_position" numeric(10,8) NOT NULL,
    "y_position" numeric(10,8) NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "label" "text",
    "style" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text",
    "share_with_clients" boolean DEFAULT false NOT NULL,
    "share_with_subs" boolean DEFAULT false NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "drawing_pins_entity_type_check" CHECK (("entity_type" = ANY (ARRAY['task'::"text", 'rfi'::"text", 'punch_list'::"text", 'submittal'::"text", 'daily_log'::"text", 'observation'::"text", 'issue'::"text"]))),
    CONSTRAINT "drawing_pins_x_position_check" CHECK ((("x_position" >= (0)::numeric) AND ("x_position" <= (1)::numeric))),
    CONSTRAINT "drawing_pins_y_position_check" CHECK ((("y_position" >= (0)::numeric) AND ("y_position" <= (1)::numeric)))
);


ALTER TABLE "public"."drawing_pins" OWNER TO "postgres";


COMMENT ON TABLE "public"."drawing_pins" IS 'Links entities (tasks, RFIs, punch items) to specific locations on drawing sheets';



COMMENT ON COLUMN "public"."drawing_pins"."x_position" IS 'Normalized X coordinate (0-1) on the drawing sheet';



COMMENT ON COLUMN "public"."drawing_pins"."y_position" IS 'Normalized Y coordinate (0-1) on the drawing sheet';



COMMENT ON COLUMN "public"."drawing_pins"."entity_type" IS 'Type of linked entity: task, rfi, punch_list, submittal, daily_log, observation, issue';



COMMENT ON COLUMN "public"."drawing_pins"."style" IS 'JSON object for pin styling: color, icon, size';



COMMENT ON COLUMN "public"."drawing_pins"."status" IS 'Cached status from linked entity for quick filtering';



CREATE TABLE IF NOT EXISTS "public"."drawing_revisions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "drawing_set_id" "uuid",
    "revision_label" "text" NOT NULL,
    "issued_date" "date",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."drawing_revisions" OWNER TO "postgres";


COMMENT ON TABLE "public"."drawing_revisions" IS 'Revision/issuance labels for tracking drawing versions';



CREATE TABLE IF NOT EXISTS "public"."drawing_sets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'processing'::"text" NOT NULL,
    "source_file_id" "uuid",
    "total_pages" integer,
    "processed_pages" integer DEFAULT 0,
    "error_message" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "set_type" "text",
    "processing_stage" "text",
    CONSTRAINT "drawing_sets_status_check" CHECK (("status" = ANY (ARRAY['processing'::"text", 'ready'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."drawing_sets" OWNER TO "postgres";


COMMENT ON TABLE "public"."drawing_sets" IS 'Uploaded plan set PDFs that get processed into individual sheets';



CREATE TABLE IF NOT EXISTS "public"."drawing_sheet_versions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "drawing_sheet_id" "uuid" NOT NULL,
    "drawing_revision_id" "uuid" NOT NULL,
    "file_id" "uuid",
    "thumbnail_file_id" "uuid",
    "page_index" integer,
    "extracted_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "thumbnail_url" "text",
    "medium_url" "text",
    "full_url" "text",
    "image_width" integer,
    "image_height" integer,
    "images_generated_at" timestamp with time zone,
    "thumb_path" "text",
    "medium_path" "text",
    "full_path" "text",
    "tile_manifest_path" "text",
    "tiles_base_path" "text",
    "tile_manifest" "jsonb",
    "tile_base_url" "text",
    "source_hash" "text",
    "tile_levels" integer,
    "tiles_generated_at" timestamp with time zone
);


ALTER TABLE "public"."drawing_sheet_versions" OWNER TO "postgres";


COMMENT ON TABLE "public"."drawing_sheet_versions" IS 'Links sheets to revisions with their actual file';



COMMENT ON COLUMN "public"."drawing_sheet_versions"."extracted_metadata" IS 'Metadata extracted during processing (OCR text, detected elements, etc.)';



COMMENT ON COLUMN "public"."drawing_sheet_versions"."thumbnail_url" IS 'WebP 400px wide - for grid/list view, ~30-50KB';



COMMENT ON COLUMN "public"."drawing_sheet_versions"."medium_url" IS 'WebP 1200px wide - for mobile/tablet viewing, ~150-250KB';



COMMENT ON COLUMN "public"."drawing_sheet_versions"."full_url" IS 'WebP 2400px wide - for desktop zoom, ~400-600KB';



COMMENT ON COLUMN "public"."drawing_sheet_versions"."image_width" IS 'Original image width in pixels (before resizing)';



COMMENT ON COLUMN "public"."drawing_sheet_versions"."image_height" IS 'Original image height in pixels (before resizing)';



COMMENT ON COLUMN "public"."drawing_sheet_versions"."images_generated_at" IS 'Timestamp when images were generated (null = not yet processed)';



COMMENT ON COLUMN "public"."drawing_sheet_versions"."tile_manifest" IS 'Deep Zoom Image (DZI) descriptor JSON for tile pyramid';



COMMENT ON COLUMN "public"."drawing_sheet_versions"."tile_base_url" IS 'Public base URL for tiles, e.g. .../drawings-tiles/{orgId}/{hash}';



COMMENT ON COLUMN "public"."drawing_sheet_versions"."source_hash" IS 'SHA256 (shortened) of source page content for content-addressed storage';



COMMENT ON COLUMN "public"."drawing_sheet_versions"."tile_levels" IS 'Number of zoom levels generated for this sheet';



COMMENT ON COLUMN "public"."drawing_sheet_versions"."tiles_generated_at" IS 'Timestamp when tiles were generated';



CREATE TABLE IF NOT EXISTS "public"."drawing_sheets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "drawing_set_id" "uuid" NOT NULL,
    "sheet_number" "text" NOT NULL,
    "sheet_title" "text",
    "discipline" "text",
    "current_revision_id" "uuid",
    "sort_order" integer DEFAULT 0,
    "share_with_clients" boolean DEFAULT false NOT NULL,
    "share_with_subs" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "drawing_sheets_discipline_check" CHECK (("discipline" = ANY (ARRAY['A'::"text", 'S'::"text", 'M'::"text", 'E'::"text", 'P'::"text", 'C'::"text", 'L'::"text", 'I'::"text", 'FP'::"text", 'G'::"text", 'T'::"text", 'SP'::"text", 'D'::"text", 'X'::"text"])))
);


ALTER TABLE "public"."drawing_sheets" OWNER TO "postgres";


COMMENT ON TABLE "public"."drawing_sheets" IS 'Individual sheets extracted from a drawing set';



COMMENT ON COLUMN "public"."drawing_sheets"."discipline" IS 'Drawing discipline code: A=Arch, S=Struct, M=Mech, E=Elec, P=Plumb, C=Civil, L=Landscape, I=Interior, FP=Fire, G=General, T=Title, SP=Specs, D=Details, X=Other';



CREATE MATERIALIZED VIEW "public"."drawing_sheets_list_mv" AS
 SELECT "s"."id",
    "s"."org_id",
    "s"."project_id",
    "s"."drawing_set_id",
    "s"."sheet_number",
    "s"."sheet_title",
    "s"."discipline",
    "s"."share_with_clients",
    "s"."share_with_subs",
    "s"."sort_order",
    "s"."created_at",
    "s"."updated_at",
    "sv"."id" AS "current_version_id",
    "sv"."thumbnail_url",
    "sv"."tile_base_url",
    "sv"."tile_manifest",
    "sv"."image_width",
    "sv"."image_height",
    COALESCE("pin_counts"."open_pins", (0)::bigint) AS "open_pins_count",
    COALESCE("pin_counts"."in_progress_pins", (0)::bigint) AS "in_progress_pins_count",
    COALESCE("pin_counts"."completed_pins", (0)::bigint) AS "completed_pins_count",
    COALESCE("pin_counts"."total_pins", (0)::bigint) AS "total_pins_count",
    COALESCE("pin_counts"."pins_by_type", '{}'::"jsonb") AS "pins_by_type",
    COALESCE("pin_counts"."pins_by_status", '{}'::"jsonb") AS "pins_by_status",
    COALESCE("markup_counts"."total_markups", (0)::bigint) AS "markups_count",
    "ds"."title" AS "set_title",
    "ds"."status" AS "set_status"
   FROM (((("public"."drawing_sheets" "s"
     LEFT JOIN "public"."drawing_sets" "ds" ON (("ds"."id" = "s"."drawing_set_id")))
     LEFT JOIN LATERAL ( SELECT "v"."id",
            "v"."thumbnail_url",
            "v"."tile_base_url",
            "v"."tile_manifest",
            "v"."image_width",
            "v"."image_height"
           FROM "public"."drawing_sheet_versions" "v"
          WHERE (("v"."drawing_sheet_id" = "s"."id") AND ("v"."drawing_revision_id" = "s"."current_revision_id"))
          ORDER BY "v"."created_at" DESC
         LIMIT 1) "sv" ON (true))
     LEFT JOIN LATERAL ( SELECT "count"(*) FILTER (WHERE ("p"."status" = ANY (ARRAY['open'::"text", 'pending'::"text"]))) AS "open_pins",
            "count"(*) FILTER (WHERE ("p"."status" = 'in_progress'::"text")) AS "in_progress_pins",
            "count"(*) FILTER (WHERE ("p"."status" = ANY (ARRAY['closed'::"text", 'approved'::"text"]))) AS "completed_pins",
            "count"(*) AS "total_pins",
            ( SELECT COALESCE("jsonb_object_agg"("t"."entity_type", "t"."cnt"), '{}'::"jsonb") AS "coalesce"
                   FROM ( SELECT "drawing_pins"."entity_type",
                            "count"(*) AS "cnt"
                           FROM "public"."drawing_pins"
                          WHERE ("drawing_pins"."drawing_sheet_id" = "s"."id")
                          GROUP BY "drawing_pins"."entity_type") "t"
                  WHERE ("t"."entity_type" IS NOT NULL)) AS "pins_by_type",
            ( SELECT COALESCE("jsonb_object_agg"("t"."status", "t"."cnt"), '{}'::"jsonb") AS "coalesce"
                   FROM ( SELECT "drawing_pins"."status",
                            "count"(*) AS "cnt"
                           FROM "public"."drawing_pins"
                          WHERE ("drawing_pins"."drawing_sheet_id" = "s"."id")
                          GROUP BY "drawing_pins"."status") "t"
                  WHERE ("t"."status" IS NOT NULL)) AS "pins_by_status"
           FROM "public"."drawing_pins" "p"
          WHERE ("p"."drawing_sheet_id" = "s"."id")) "pin_counts" ON (true))
     LEFT JOIN LATERAL ( SELECT "count"(*) AS "total_markups"
           FROM "public"."drawing_markups" "m"
          WHERE ("m"."drawing_sheet_id" = "s"."id")) "markup_counts" ON (true))
  WITH NO DATA;


ALTER MATERIALIZED VIEW "public"."drawing_sheets_list_mv" OWNER TO "postgres";


COMMENT ON MATERIALIZED VIEW "public"."drawing_sheets_list_mv" IS 'Denormalized list backing MV for drawings sheets (current version + counts)';



CREATE OR REPLACE VIEW "public"."drawing_sheets_list" WITH ("security_invoker"='true') AS
 SELECT "id",
    "org_id",
    "project_id",
    "drawing_set_id",
    "sheet_number",
    "sheet_title",
    "discipline",
    "share_with_clients",
    "share_with_subs",
    "sort_order",
    "created_at",
    "updated_at",
    "current_version_id",
    "thumbnail_url",
    "tile_base_url",
    "tile_manifest",
    "image_width",
    "image_height",
    "open_pins_count",
    "in_progress_pins_count",
    "completed_pins_count",
    "total_pins_count",
    "pins_by_type",
    "pins_by_status",
    "markups_count",
    "set_title",
    "set_status"
   FROM "public"."drawing_sheets_list_mv"
  WHERE "public"."is_org_member"("org_id");


ALTER VIEW "public"."drawing_sheets_list" OWNER TO "postgres";


COMMENT ON VIEW "public"."drawing_sheets_list" IS 'RLS-safe view for drawings sheets list (filters by is_org_member)';



CREATE TABLE IF NOT EXISTS "public"."entitlements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "feature_key" "text" NOT NULL,
    "limit_type" "text",
    "limit_value" numeric,
    "source" "text" DEFAULT 'plan'::"text" NOT NULL,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."entitlements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."envelope_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "envelope_id" "uuid" NOT NULL,
    "envelope_recipient_id" "uuid",
    "event_type" "text" NOT NULL,
    "status_from" "text",
    "status_to" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."envelope_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."envelope_recipients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "envelope_id" "uuid" NOT NULL,
    "recipient_type" "text" DEFAULT 'external_email'::"text" NOT NULL,
    "contact_id" "uuid",
    "user_id" "uuid",
    "name" "text",
    "email" "public"."citext",
    "role" "text" DEFAULT 'signer'::"text" NOT NULL,
    "signer_role" "text",
    "sequence" integer DEFAULT 1 NOT NULL,
    "required" boolean DEFAULT true NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "envelope_recipients_check" CHECK ((("recipient_type" <> 'contact'::"text") OR ("contact_id" IS NOT NULL))),
    CONSTRAINT "envelope_recipients_check1" CHECK ((("recipient_type" <> 'internal_user'::"text") OR ("user_id" IS NOT NULL))),
    CONSTRAINT "envelope_recipients_recipient_type_check" CHECK (("recipient_type" = ANY (ARRAY['external_email'::"text", 'contact'::"text", 'internal_user'::"text"]))),
    CONSTRAINT "envelope_recipients_role_check" CHECK (("role" = ANY (ARRAY['signer'::"text", 'cc'::"text"]))),
    CONSTRAINT "envelope_recipients_sequence_check" CHECK (("sequence" >= 1))
);


ALTER TABLE "public"."envelope_recipients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."envelopes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "document_id" "uuid" NOT NULL,
    "document_revision" integer DEFAULT 1 NOT NULL,
    "source_entity_type" "text",
    "source_entity_id" "uuid",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "subject" "text",
    "message" "text",
    "expires_at" timestamp with time zone,
    "sent_at" timestamp with time zone,
    "executed_at" timestamp with time zone,
    "voided_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "envelopes_document_revision_check" CHECK (("document_revision" >= 1)),
    CONSTRAINT "envelopes_source_entity_type_check" CHECK ((("source_entity_type" IS NULL) OR ("source_entity_type" = ANY (ARRAY['proposal'::"text", 'change_order'::"text", 'lien_waiver'::"text", 'selection'::"text", 'subcontract'::"text", 'closeout'::"text", 'other'::"text"])))),
    CONSTRAINT "envelopes_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sent'::"text", 'partially_signed'::"text", 'executed'::"text", 'voided'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."envelopes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."estimate_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "estimate_id" "uuid" NOT NULL,
    "cost_code_id" "uuid",
    "item_type" "text" DEFAULT 'line'::"text" NOT NULL,
    "description" "text" NOT NULL,
    "quantity" numeric DEFAULT 1 NOT NULL,
    "unit" "text",
    "unit_cost_cents" integer,
    "markup_pct" numeric,
    "sort_order" integer DEFAULT 0,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."estimate_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."estimate_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "lines" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "is_default" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."estimate_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."estimates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "title" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "subtotal_cents" integer,
    "tax_cents" integer,
    "total_cents" integer,
    "currency" "text" DEFAULT 'usd'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "valid_until" "date",
    "approved_at" timestamp with time zone,
    "approved_by" "uuid",
    "recipient_contact_id" "uuid",
    "opportunity_id" "uuid"
);


ALTER TABLE "public"."estimates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "entity_type" "text",
    "entity_id" "uuid",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "channel" "public"."event_channel" DEFAULT 'activity'::"public"."event_channel" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone
);


ALTER TABLE "public"."events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."external_portal_account_grants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "portal_access_token_id" "uuid",
    "bid_access_token_id" "uuid",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "paused_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "external_portal_account_grants_check" CHECK ((((("portal_access_token_id" IS NOT NULL))::integer + (("bid_access_token_id" IS NOT NULL))::integer) = 1)),
    CONSTRAINT "external_portal_account_grants_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'paused'::"text", 'revoked'::"text"])))
);


ALTER TABLE "public"."external_portal_account_grants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."external_portal_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "email" "public"."citext" NOT NULL,
    "full_name" "text",
    "password_hash" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "last_login_at" timestamp with time zone,
    "paused_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "external_portal_accounts_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'paused'::"text", 'revoked'::"text"])))
);


ALTER TABLE "public"."external_portal_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."external_portal_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "session_token_hash" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone
);


ALTER TABLE "public"."external_portal_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."feature_flags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "flag_key" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."feature_flags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."file_access_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "file_id" "uuid" NOT NULL,
    "actor_user_id" "uuid",
    "portal_token_id" "uuid",
    "action" "text" NOT NULL,
    "ip_address" "inet",
    "user_agent" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "file_access_events_action_check" CHECK (("action" = ANY (ARRAY['view'::"text", 'download'::"text", 'share'::"text", 'unshare'::"text", 'print'::"text"])))
);


ALTER TABLE "public"."file_access_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."file_access_events" IS 'Audit log for file downloads and views';



CREATE TABLE IF NOT EXISTS "public"."file_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "file_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "link_role" "text"
);


ALTER TABLE "public"."file_links" OWNER TO "postgres";


COMMENT ON COLUMN "public"."file_links"."link_role" IS 'Role of the attachment: rfi_question, rfi_response, submittal_package, co_supporting, task_evidence, invoice_backup';



CREATE TABLE IF NOT EXISTS "public"."file_share_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "file_id" "uuid" NOT NULL,
    "token" "text" NOT NULL,
    "label" "text",
    "expires_at" timestamp with time zone,
    "max_uses" integer,
    "use_count" integer DEFAULT 0 NOT NULL,
    "allow_download" boolean DEFAULT true NOT NULL,
    "revoked_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "file_share_links_max_uses_positive" CHECK ((("max_uses" IS NULL) OR ("max_uses" > 0)))
);


ALTER TABLE "public"."file_share_links" OWNER TO "postgres";


COMMENT ON TABLE "public"."file_share_links" IS 'Tokenized public share links for project files. Access is validated by service-role lookups at the /f/[token] route.';



CREATE TABLE IF NOT EXISTS "public"."files" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "file_name" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "mime_type" "text",
    "size_bytes" bigint,
    "checksum" "text",
    "visibility" "text" DEFAULT 'private'::"text" NOT NULL,
    "uploaded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "share_with_subs" boolean DEFAULT false NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "category" "text",
    "folder_path" "text",
    "description" "text",
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "archived_at" timestamp with time zone,
    "source" "text",
    "current_version_id" "uuid",
    "share_with_clients" boolean DEFAULT false NOT NULL,
    "daily_log_id" "uuid",
    "schedule_item_id" "uuid",
    "status" "text" DEFAULT 'draft'::"text",
    "due_at" timestamp with time zone,
    CONSTRAINT "files_category_check" CHECK ((("category" IS NULL) OR ("category" = ANY (ARRAY['plans'::"text", 'contracts'::"text", 'permits'::"text", 'submittals'::"text", 'photos'::"text", 'rfis'::"text", 'safety'::"text", 'financials'::"text", 'other'::"text"])))),
    CONSTRAINT "files_source_check" CHECK ((("source" IS NULL) OR ("source" = ANY (ARRAY['upload'::"text", 'portal'::"text", 'email'::"text", 'generated'::"text", 'import'::"text"]))))
);


ALTER TABLE "public"."files" OWNER TO "postgres";


COMMENT ON COLUMN "public"."files"."category" IS 'File category: plans, contracts, permits, submittals, photos, rfis, safety, financials, other';



COMMENT ON COLUMN "public"."files"."folder_path" IS 'Virtual folder path for organization (e.g., /drawings/structural)';



COMMENT ON COLUMN "public"."files"."description" IS 'User-provided description of the file';



COMMENT ON COLUMN "public"."files"."tags" IS 'Array of tags for flexible labeling and search';



COMMENT ON COLUMN "public"."files"."archived_at" IS 'Timestamp when file was soft-archived, null if active';



COMMENT ON COLUMN "public"."files"."source" IS 'How the file was added: upload, portal, email, generated, import';



COMMENT ON COLUMN "public"."files"."current_version_id" IS 'Reference to the current active version in doc_versions';



COMMENT ON COLUMN "public"."files"."status" IS 'Approval workflow status: draft, submitted, in_review, approved, rejected, resubmit_required';



CREATE TABLE IF NOT EXISTS "public"."form_instances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "template_id" "uuid",
    "entity_type" "text",
    "entity_id" "uuid",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."form_instances" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."form_responses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "form_instance_id" "uuid",
    "responder_id" "uuid",
    "responses" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."form_responses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."form_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "entity_type" "text",
    "version" integer DEFAULT 1 NOT NULL,
    "schema" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."form_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."idempotency_keys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "key" "text" NOT NULL,
    "scope" "text" NOT NULL,
    "response" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."idempotency_keys" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."impersonation_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_user_id" "uuid" NOT NULL,
    "target_user_id" "uuid" NOT NULL,
    "org_id" "uuid",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "reason" "text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ended_at" timestamp with time zone,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '01:00:00'::interval) NOT NULL,
    "approved_by" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "impersonation_sessions_check" CHECK (("actor_user_id" <> "target_user_id")),
    CONSTRAINT "impersonation_sessions_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'ended'::"text", 'revoked'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."impersonation_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoice_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "cost_code_id" "uuid",
    "description" "text" NOT NULL,
    "quantity" numeric DEFAULT 1 NOT NULL,
    "unit" "text",
    "unit_price_cents" integer,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "sort_order" integer DEFAULT 0
);


ALTER TABLE "public"."invoice_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoice_views" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "token" "text",
    "user_agent" "text",
    "ip_address" "text",
    "viewed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."invoice_views" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "invoice_number" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "issue_date" "date",
    "due_date" "date",
    "total_cents" integer,
    "currency" "text" DEFAULT 'usd'::"text" NOT NULL,
    "recipient_contact_id" "uuid",
    "file_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "title" "text",
    "notes" "text",
    "client_visible" boolean DEFAULT false NOT NULL,
    "subtotal_cents" integer,
    "tax_cents" integer,
    "balance_due_cents" integer,
    "token" "text",
    "viewed_at" timestamp with time zone,
    "tax_rate" numeric,
    "sent_at" timestamp with time zone,
    "sent_to_emails" "text"[],
    "qbo_id" "text",
    "qbo_synced_at" timestamp with time zone,
    "qbo_sync_status" "text",
    CONSTRAINT "invoices_qbo_sync_status_check" CHECK ((("qbo_sync_status" IS NULL) OR ("qbo_sync_status" = ANY (ARRAY['pending'::"text", 'synced'::"text", 'error'::"text", 'skipped'::"text"]))))
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."late_fee_applications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "late_fee_rule_id" "uuid" NOT NULL,
    "invoice_line_id" "uuid",
    "amount_cents" integer NOT NULL,
    "applied_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "application_number" integer NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "late_fee_applications_amount_cents_check" CHECK (("amount_cents" > 0))
);


ALTER TABLE "public"."late_fee_applications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."late_fees" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "strategy" "text" DEFAULT 'fixed'::"text" NOT NULL,
    "amount_cents" integer,
    "percent_rate" numeric,
    "grace_days" integer DEFAULT 0,
    "repeat_days" integer,
    "max_applications" integer,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."late_fees" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."licenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "plan_code" "text",
    "status" "public"."license_status" DEFAULT 'issued'::"public"."license_status" NOT NULL,
    "license_key" "text" NOT NULL,
    "purchased_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "maintenance_expires_at" timestamp with time zone,
    "support_tier" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."licenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lien_waivers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "payment_id" "uuid",
    "company_id" "uuid",
    "contact_id" "uuid",
    "waiver_type" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "amount_cents" integer NOT NULL,
    "through_date" "date" NOT NULL,
    "claimant_name" "text" NOT NULL,
    "property_description" "text",
    "document_file_id" "uuid",
    "signed_file_id" "uuid",
    "signature_data" "jsonb",
    "sent_at" timestamp with time zone,
    "signed_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "token_hash" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lien_waivers_amount_cents_check" CHECK (("amount_cents" >= 0)),
    CONSTRAINT "lien_waivers_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'signed'::"text", 'rejected'::"text", 'expired'::"text"]))),
    CONSTRAINT "lien_waivers_waiver_type_check" CHECK (("waiver_type" = ANY (ARRAY['conditional'::"text", 'unconditional'::"text", 'final'::"text"])))
);


ALTER TABLE "public"."lien_waivers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."markup_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "scope" "text" NOT NULL,
    "contract_id" "uuid",
    "cost_code_id" "uuid",
    "markup_percent" numeric NOT NULL,
    "applies_to_category" "text",
    "effective_from" "date",
    "effective_to" "date",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "markup_rules_markup_percent_check" CHECK ((("markup_percent" >= (0)::numeric) AND ("markup_percent" <= (200)::numeric))),
    CONSTRAINT "markup_rules_scope_check" CHECK (("scope" = ANY (ARRAY['org'::"text", 'contract'::"text", 'cost_code'::"text"]))),
    CONSTRAINT "markup_rules_scope_target" CHECK (((("scope" = 'org'::"text") AND ("contract_id" IS NULL) AND ("cost_code_id" IS NULL)) OR (("scope" = 'contract'::"text") AND ("contract_id" IS NOT NULL) AND ("cost_code_id" IS NULL)) OR (("scope" = 'cost_code'::"text") AND ("cost_code_id" IS NOT NULL))))
);


ALTER TABLE "public"."markup_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."membership_permission_overrides" (
    "membership_id" "uuid" NOT NULL,
    "permission_key" "text" NOT NULL,
    "effect" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "membership_permission_overrides_effect_check" CHECK (("effect" = ANY (ARRAY['grant'::"text", 'deny'::"text"])))
);


ALTER TABLE "public"."membership_permission_overrides" OWNER TO "postgres";


COMMENT ON TABLE "public"."membership_permission_overrides" IS 'Per-member grant/deny permission overrides layered on top of the member org role.';



CREATE TABLE IF NOT EXISTS "public"."memberships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role_id" "uuid" NOT NULL,
    "status" "public"."membership_status" DEFAULT 'active'::"public"."membership_status" NOT NULL,
    "invited_by" "uuid",
    "last_active_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "invite_token" "text",
    "invite_token_expires_at" timestamp with time zone,
    "labor_cost_rate_cents" integer DEFAULT 0 NOT NULL,
    "labor_bill_rate_cents" integer DEFAULT 0 NOT NULL,
    "labor_burden_multiplier" numeric DEFAULT 1.0 NOT NULL,
    "labor_is_billable_default" boolean DEFAULT true NOT NULL,
    CONSTRAINT "memberships_labor_bill_rate_cents_check" CHECK (("labor_bill_rate_cents" >= 0)),
    CONSTRAINT "memberships_labor_burden_multiplier_check" CHECK (("labor_burden_multiplier" >= 1.0)),
    CONSTRAINT "memberships_labor_cost_rate_cents_check" CHECK (("labor_cost_rate_cents" >= 0))
);


ALTER TABLE "public"."memberships" OWNER TO "postgres";


COMMENT ON COLUMN "public"."memberships"."invite_token" IS 'Unique token for invite acceptance flow';



COMMENT ON COLUMN "public"."memberships"."invite_token_expires_at" IS 'Expiration time for the invite token';



COMMENT ON COLUMN "public"."memberships"."labor_cost_rate_cents" IS 'Default hourly internal cost rate for time entries, in cents.';



COMMENT ON COLUMN "public"."memberships"."labor_bill_rate_cents" IS 'Default hourly billing rate for T&M/client-facing time, in cents. Reserved for billing workflows.';



COMMENT ON COLUMN "public"."memberships"."labor_burden_multiplier" IS 'Default labor burden multiplier applied to cost rate for this employee.';



COMMENT ON COLUMN "public"."memberships"."labor_is_billable_default" IS 'Whether this employee time defaults to billable on cost-plus/T&M projects.';



CREATE TABLE IF NOT EXISTS "public"."mentions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "message_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "contact_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."mentions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "sender_id" "uuid",
    "message_type" "text" DEFAULT 'text'::"text" NOT NULL,
    "body" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_deliveries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "notification_id" "uuid" NOT NULL,
    "channel" "public"."notification_channel" DEFAULT 'in_app'::"public"."notification_channel" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "sent_at" timestamp with time zone,
    "response" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."notification_deliveries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "notification_type" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."opportunities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "client_contact_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "status" "public"."opportunity_status" DEFAULT 'new'::"public"."opportunity_status" NOT NULL,
    "owner_user_id" "uuid",
    "jobsite_location" "jsonb",
    "project_type" "text",
    "budget_range" "text",
    "timeline_preference" "text",
    "source" "text",
    "tags" "text"[],
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."opportunities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."org_settings" (
    "org_id" "uuid" NOT NULL,
    "settings" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "storage_bucket" "text",
    "region" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."org_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."orgs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "public"."citext",
    "billing_model" "public"."pricing_model" DEFAULT 'subscription'::"public"."pricing_model" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "billing_email" "text",
    "locale" "text" DEFAULT 'en-US'::"text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "address" "jsonb",
    "compliance_rules" "jsonb" DEFAULT '{}'::"jsonb",
    "default_compliance_requirements" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "logo_url" "text"
);


ALTER TABLE "public"."orgs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."outbox" (
    "id" bigint NOT NULL,
    "org_id" "uuid" NOT NULL,
    "event_id" "uuid",
    "job_type" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "run_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "retry_count" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."outbox" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."outbox_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."outbox_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."outbox_id_seq" OWNED BY "public"."outbox"."id";



CREATE TABLE IF NOT EXISTS "public"."payment_intents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "invoice_id" "uuid",
    "provider" "text" DEFAULT 'stripe'::"text" NOT NULL,
    "provider_intent_id" "text",
    "status" "text" DEFAULT 'requires_payment_method'::"text" NOT NULL,
    "amount_cents" integer NOT NULL,
    "currency" "text" DEFAULT 'usd'::"text" NOT NULL,
    "client_secret" "text",
    "idempotency_key" "text",
    "expires_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "connected_account_id" "text",
    "charge_type" "text",
    "provider_charge_id" "text",
    "provider_transfer_id" "text",
    "application_fee_amount" integer,
    "processor_fee_cents" integer,
    "platform_fee_cents" integer,
    "on_behalf_of_account_id" "text"
);


ALTER TABLE "public"."payment_intents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "nonce" "text" NOT NULL,
    "expires_at" timestamp with time zone,
    "max_uses" integer,
    "used_count" integer DEFAULT 0 NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."payment_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_methods" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "contact_id" "uuid",
    "provider" "text" DEFAULT 'stripe'::"text" NOT NULL,
    "provider_method_id" "text",
    "type" "text" DEFAULT 'ach'::"text" NOT NULL,
    "fingerprint" "text",
    "last4" "text",
    "bank_brand" "text",
    "exp_last4" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."payment_methods" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "contact_id" "uuid",
    "payment_method_id" "uuid",
    "total_amount_cents" integer NOT NULL,
    "installment_amount_cents" integer NOT NULL,
    "installments_total" integer NOT NULL,
    "installments_paid" integer DEFAULT 0 NOT NULL,
    "frequency" "text" DEFAULT 'monthly'::"text" NOT NULL,
    "next_charge_date" "date",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "auto_charge" boolean DEFAULT false NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payment_schedules_frequency_check" CHECK (("frequency" = ANY (ARRAY['weekly'::"text", 'biweekly'::"text", 'monthly'::"text"]))),
    CONSTRAINT "payment_schedules_installment_amount_cents_check" CHECK (("installment_amount_cents" > 0)),
    CONSTRAINT "payment_schedules_installments_total_check" CHECK (("installments_total" > 0)),
    CONSTRAINT "payment_schedules_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'paused'::"text", 'completed'::"text", 'canceled'::"text", 'failed'::"text"]))),
    CONSTRAINT "payment_schedules_total_amount_cents_check" CHECK (("total_amount_cents" > 0))
);


ALTER TABLE "public"."payment_schedules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "invoice_id" "uuid",
    "bill_id" "uuid",
    "amount_cents" integer NOT NULL,
    "currency" "text" DEFAULT 'usd'::"text" NOT NULL,
    "method" "text",
    "reference" "text",
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "provider" "text",
    "provider_payment_id" "text",
    "fee_cents" integer DEFAULT 0,
    "net_cents" integer,
    "idempotency_key" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "connected_account_id" "text",
    "provider_charge_id" "text",
    "provider_balance_transaction_id" "text",
    "provider_transfer_id" "text",
    "application_fee_cents" integer DEFAULT 0 NOT NULL,
    "processor_fee_cents" integer DEFAULT 0 NOT NULL,
    "platform_fee_cents" integer DEFAULT 0 NOT NULL,
    "gross_cents" integer
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."permissions" (
    "key" "text" NOT NULL,
    "description" "text",
    CONSTRAINT "permissions_key_format_chk" CHECK (("key" ~ '^[a-z_]+(\.[a-z_]+)+$'::"text"))
);


ALTER TABLE "public"."permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."photos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "daily_log_id" "uuid",
    "task_id" "uuid",
    "file_id" "uuid" NOT NULL,
    "captured_by" "uuid",
    "taken_at" timestamp with time zone,
    "tags" "text"[],
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."photos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plan_feature_limits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "plan_code" "text",
    "feature_key" "text",
    "limit_type" "text" NOT NULL,
    "limit_value" numeric,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."plan_feature_limits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plan_features" (
    "feature_key" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "category" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."plan_features" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plans" (
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "pricing_model" "public"."pricing_model" DEFAULT 'subscription'::"public"."pricing_model" NOT NULL,
    "interval" "text" DEFAULT 'monthly'::"text",
    "amount_cents" integer,
    "currency" "text" DEFAULT 'usd'::"text",
    "is_active" boolean DEFAULT true NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "stripe_price_id" "text"
);


ALTER TABLE "public"."plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_memberships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role_id" "uuid" NOT NULL,
    "status" "public"."membership_status" DEFAULT 'active'::"public"."membership_status" NOT NULL,
    "granted_by" "uuid",
    "reason" "text",
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."platform_memberships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_settings" (
    "key" "text" NOT NULL,
    "value" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."platform_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."portal_access_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "contact_id" "uuid",
    "company_id" "uuid",
    "token" "text" DEFAULT "encode"("extensions"."gen_random_bytes"(32), 'hex'::"text") NOT NULL,
    "portal_type" "text" NOT NULL,
    "can_view_schedule" boolean DEFAULT true NOT NULL,
    "can_view_photos" boolean DEFAULT true NOT NULL,
    "can_view_documents" boolean DEFAULT true NOT NULL,
    "can_view_daily_logs" boolean DEFAULT false NOT NULL,
    "can_view_budget" boolean DEFAULT false NOT NULL,
    "can_approve_change_orders" boolean DEFAULT true NOT NULL,
    "can_submit_selections" boolean DEFAULT true NOT NULL,
    "can_create_punch_items" boolean DEFAULT false NOT NULL,
    "can_message" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone,
    "last_accessed_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "access_count" integer DEFAULT 0 NOT NULL,
    "can_view_invoices" boolean DEFAULT true NOT NULL,
    "can_pay_invoices" boolean DEFAULT false NOT NULL,
    "can_view_rfis" boolean DEFAULT true NOT NULL,
    "can_view_submittals" boolean DEFAULT true NOT NULL,
    "can_respond_rfis" boolean DEFAULT true NOT NULL,
    "can_submit_submittals" boolean DEFAULT true NOT NULL,
    "can_download_files" boolean DEFAULT true NOT NULL,
    "max_access_count" integer,
    "pin_hash" "text",
    "pin_required" boolean DEFAULT false NOT NULL,
    "pin_attempts" integer DEFAULT 0 NOT NULL,
    "pin_locked_until" timestamp with time zone,
    "can_submit_invoices" boolean DEFAULT true NOT NULL,
    "can_view_commitments" boolean DEFAULT true NOT NULL,
    "can_view_bills" boolean DEFAULT true NOT NULL,
    "can_upload_compliance_docs" boolean DEFAULT true NOT NULL,
    "paused_at" timestamp with time zone,
    "require_account" boolean DEFAULT false NOT NULL,
    CONSTRAINT "portal_access_tokens_portal_type_check" CHECK (("portal_type" = ANY (ARRAY['client'::"text", 'sub'::"text"])))
);


ALTER TABLE "public"."portal_access_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_cost_code_progress" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "cost_code_id" "uuid" NOT NULL,
    "percent_complete" numeric,
    "basis" "public"."progress_basis" DEFAULT 'manual'::"public"."progress_basis" NOT NULL,
    "estimate_remaining_cents" integer,
    "notes" "text",
    "recorded_by_user_id" "uuid" NOT NULL,
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."project_cost_code_progress" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_expenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "cost_code_id" "uuid",
    "vendor_company_id" "uuid",
    "vendor_name_text" "text",
    "expense_date" "date" NOT NULL,
    "description" "text",
    "amount_cents" integer NOT NULL,
    "tax_cents" integer DEFAULT 0 NOT NULL,
    "payment_method" "text",
    "receipt_file_id" "uuid",
    "is_billable" boolean DEFAULT true NOT NULL,
    "markup_percent_override" numeric,
    "submitted_by_user_id" "uuid",
    "approved_by_pm_at" timestamp with time zone,
    "approved_by_pm_user_id" "uuid",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "rejection_reason" "text",
    "billable_cost_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "qbo_id" "text",
    "qbo_synced_at" timestamp with time zone,
    "qbo_sync_status" "text",
    "qbo_transaction_type" "text",
    "qbo_expense_account_id" "text",
    "qbo_expense_account_name" "text",
    "qbo_payment_account_id" "text",
    "qbo_payment_account_name" "text",
    "qbo_ap_account_id" "text",
    "qbo_ap_account_name" "text",
    "qbo_vendor_id" "text",
    "qbo_vendor_name" "text",
    "qbo_sync_error" "text",
    CONSTRAINT "project_expenses_amount_cents_check" CHECK (("amount_cents" >= 0)),
    CONSTRAINT "project_expenses_markup_percent_override_check" CHECK ((("markup_percent_override" IS NULL) OR (("markup_percent_override" >= (0)::numeric) AND ("markup_percent_override" <= (200)::numeric)))),
    CONSTRAINT "project_expenses_payment_method_check" CHECK (("payment_method" = ANY (ARRAY['cash'::"text", 'credit_card'::"text", 'check'::"text", 'ach'::"text", 'company_card'::"text", 'reimbursable_personal'::"text", 'other'::"text"]))),
    CONSTRAINT "project_expenses_qbo_sync_status_check" CHECK ((("qbo_sync_status" IS NULL) OR ("qbo_sync_status" = ANY (ARRAY['pending'::"text", 'synced'::"text", 'error'::"text", 'skipped'::"text", 'needs_review'::"text"])))),
    CONSTRAINT "project_expenses_qbo_transaction_type_check" CHECK ((("qbo_transaction_type" IS NULL) OR ("qbo_transaction_type" = ANY (ARRAY['purchase'::"text", 'bill'::"text"])))),
    CONSTRAINT "project_expenses_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'submitted'::"text", 'approved'::"text", 'rejected'::"text", 'locked'::"text"]))),
    CONSTRAINT "project_expenses_tax_cents_check" CHECK (("tax_cents" >= 0))
);


ALTER TABLE "public"."project_expenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_file_folder_permissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "path" "text" NOT NULL,
    "share_with_clients" boolean DEFAULT false NOT NULL,
    "share_with_subs" boolean DEFAULT false NOT NULL,
    "created_by" "uuid",
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "project_file_folder_permissions_path_format" CHECK (("path" ~ '^/.+'::"text"))
);


ALTER TABLE "public"."project_file_folder_permissions" OWNER TO "postgres";


COMMENT ON TABLE "public"."project_file_folder_permissions" IS 'Folder-level sharing defaults for project files (client/sub visibility).';



CREATE TABLE IF NOT EXISTS "public"."project_file_folders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "path" "text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "project_file_folders_path_format" CHECK (("path" ~ '^/.+'::"text"))
);


ALTER TABLE "public"."project_file_folders" OWNER TO "postgres";


COMMENT ON TABLE "public"."project_file_folders" IS 'Persisted virtual folders for project documents.';



COMMENT ON COLUMN "public"."project_file_folders"."path" IS 'Normalized virtual folder path (e.g., /contracts/change-orders).';



CREATE TABLE IF NOT EXISTS "public"."project_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role_id" "uuid" NOT NULL,
    "status" "public"."membership_status" DEFAULT 'active'::"public"."membership_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."project_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_selections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "category_id" "uuid" NOT NULL,
    "selected_option_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "due_date" "date",
    "selected_at" timestamp with time zone,
    "confirmed_at" timestamp with time zone,
    "selected_by_user_id" "uuid",
    "selected_by_contact_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "project_selections_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'selected'::"text", 'confirmed'::"text", 'ordered'::"text", 'received'::"text"])))
);


ALTER TABLE "public"."project_selections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_settings" (
    "project_id" "uuid" NOT NULL,
    "org_id" "uuid" NOT NULL,
    "settings" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."project_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_vendors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "company_id" "uuid",
    "contact_id" "uuid",
    "role" "text" DEFAULT 'subcontractor'::"text" NOT NULL,
    "scope" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "check_has_entity" CHECK ((("company_id" IS NOT NULL) OR ("contact_id" IS NOT NULL)))
);


ALTER TABLE "public"."project_vendors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "status" "public"."project_status" DEFAULT 'active'::"public"."project_status" NOT NULL,
    "start_date" "date",
    "end_date" "date",
    "location" "jsonb",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "total_value" integer,
    "property_type" "public"."project_property_type",
    "project_type" "public"."project_work_type",
    "description" "text",
    "client_id" "uuid",
    "opportunity_id" "uuid",
    "retainage_percent" numeric DEFAULT 0,
    "total_contract_value_cents" integer
);


ALTER TABLE "public"."projects" OWNER TO "postgres";


COMMENT ON COLUMN "public"."projects"."client_id" IS 'Primary client contact for this project';



COMMENT ON COLUMN "public"."projects"."retainage_percent" IS 'Default retainage percentage for invoices if no contract is specified or as a global override.';



COMMENT ON COLUMN "public"."projects"."total_contract_value_cents" IS 'The total contract value if managed manually/externally.';



CREATE TABLE IF NOT EXISTS "public"."proposal_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "proposal_id" "uuid" NOT NULL,
    "cost_code_id" "uuid",
    "line_type" "text" DEFAULT 'item'::"text" NOT NULL,
    "description" "text" NOT NULL,
    "quantity" numeric DEFAULT 1 NOT NULL,
    "unit" "text",
    "unit_cost_cents" integer,
    "markup_percent" numeric,
    "is_optional" boolean DEFAULT false,
    "is_selected" boolean DEFAULT true,
    "allowance_cents" integer,
    "notes" "text",
    "sort_order" integer DEFAULT 0,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "proposal_lines_line_type_check" CHECK (("line_type" = ANY (ARRAY['item'::"text", 'section'::"text", 'allowance'::"text", 'option'::"text"])))
);


ALTER TABLE "public"."proposal_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."proposals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "estimate_id" "uuid",
    "recipient_contact_id" "uuid",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "sent_at" timestamp with time zone,
    "accepted_at" timestamp with time zone,
    "rejected_at" timestamp with time zone,
    "snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "number" "text",
    "title" "text",
    "summary" "text",
    "terms" "text",
    "valid_until" "date",
    "total_cents" integer,
    "signature_required" boolean DEFAULT true,
    "signature_data" "jsonb",
    "token_hash" "text",
    "viewed_at" timestamp with time zone,
    "opportunity_id" "uuid"
);


ALTER TABLE "public"."proposals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."punch_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "due_date" "date",
    "severity" "text",
    "location" "text",
    "assigned_to" "uuid",
    "created_by" "uuid",
    "resolved_by" "uuid",
    "resolved_at" timestamp with time zone,
    "file_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_via_portal" boolean DEFAULT false,
    "portal_token_id" "uuid",
    "schedule_item_id" "uuid",
    "created_from_inspection" boolean DEFAULT false,
    "verification_required" boolean DEFAULT false,
    "verified_at" timestamp with time zone,
    "verified_by" "uuid",
    "verification_notes" "text"
);


ALTER TABLE "public"."punch_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "realm_id" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text" NOT NULL,
    "token_expires_at" timestamp with time zone NOT NULL,
    "company_name" "text",
    "connected_by" "uuid",
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "disconnected_at" timestamp with time zone,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "last_sync_at" timestamp with time zone,
    "last_error" "text",
    "settings" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "refresh_token_expires_at" timestamp with time zone,
    "refresh_failure_count" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "qbo_connections_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'expired'::"text", 'disconnected'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."qbo_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_invoice_reservations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "reserved_number" "text" NOT NULL,
    "reserved_by" "uuid",
    "reserved_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:30:00'::interval) NOT NULL,
    "used_by_invoice_id" "uuid",
    "status" "text" DEFAULT 'reserved'::"text" NOT NULL,
    CONSTRAINT "qbo_invoice_reservations_status_check" CHECK (("status" = ANY (ARRAY['reserved'::"text", 'used'::"text", 'expired'::"text", 'released'::"text"])))
);


ALTER TABLE "public"."qbo_invoice_reservations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_sync_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "connection_id" "uuid" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "qbo_id" "text" NOT NULL,
    "qbo_sync_token" "text",
    "last_synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sync_direction" "text" DEFAULT 'outbound'::"text" NOT NULL,
    "status" "text" DEFAULT 'synced'::"text" NOT NULL,
    "error_message" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "qbo_sync_records_entity_type_check" CHECK (("entity_type" = ANY (ARRAY['invoice'::"text", 'payment'::"text", 'customer'::"text", 'item'::"text", 'vendor'::"text", 'project_expense'::"text", 'purchase'::"text", 'bill'::"text", 'bill_payment'::"text", 'purchase_order'::"text", 'vendor_credit'::"text", 'account'::"text"]))),
    CONSTRAINT "qbo_sync_records_status_check" CHECK (("status" = ANY (ARRAY['synced'::"text", 'pending'::"text", 'error'::"text", 'conflict'::"text"]))),
    CONSTRAINT "qbo_sync_records_sync_direction_check" CHECK (("sync_direction" = ANY (ARRAY['outbound'::"text", 'inbound'::"text", 'bidirectional'::"text"])))
);


ALTER TABLE "public"."qbo_sync_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_webhook_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "text" NOT NULL,
    "payload_hash" "text" NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "realm_id" "text",
    "entity_name" "text",
    "entity_qbo_id" "text",
    "operation" "text",
    "last_updated" timestamp with time zone,
    "process_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "process_error" "text",
    "processed_at" timestamp with time zone
);


ALTER TABLE "public"."qbo_webhook_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."receipts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "payment_id" "uuid",
    "file_id" "uuid",
    "issued_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."receipts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reminder_deliveries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "reminder_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "channel" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "sent_at" timestamp with time zone,
    "delivered_at" timestamp with time zone,
    "clicked_at" timestamp with time zone,
    "error_message" "text",
    "provider_message_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_on" "date" GENERATED ALWAYS AS ((("created_at" AT TIME ZONE 'utc'::"text"))::"date") STORED,
    CONSTRAINT "reminder_deliveries_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'delivered'::"text", 'failed'::"text", 'clicked'::"text"])))
);


ALTER TABLE "public"."reminder_deliveries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reminders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "invoice_id" "uuid",
    "channel" "text" DEFAULT 'email'::"text" NOT NULL,
    "schedule" "text" DEFAULT 'before_due'::"text" NOT NULL,
    "offset_days" integer DEFAULT 0 NOT NULL,
    "template_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."reminders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."retainage" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "contract_id" "uuid" NOT NULL,
    "invoice_id" "uuid",
    "amount_cents" integer NOT NULL,
    "status" "text" DEFAULT 'held'::"text" NOT NULL,
    "held_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "released_at" timestamp with time zone,
    "release_invoice_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "retainage_amount_cents_check" CHECK (("amount_cents" >= 0)),
    CONSTRAINT "retainage_status_check" CHECK (("status" = ANY (ARRAY['held'::"text", 'released'::"text", 'invoiced'::"text", 'paid'::"text"])))
);


ALTER TABLE "public"."retainage" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rfi_responses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "rfi_id" "uuid" NOT NULL,
    "response_type" "text" NOT NULL,
    "body" "text" NOT NULL,
    "responder_user_id" "uuid",
    "responder_contact_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "file_id" "uuid",
    "portal_token_id" "uuid",
    "created_via_portal" boolean DEFAULT false NOT NULL,
    "actor_ip" "inet",
    CONSTRAINT "rfi_responses_response_type_check" CHECK (("response_type" = ANY (ARRAY['answer'::"text", 'clarification'::"text", 'comment'::"text"])))
);


ALTER TABLE "public"."rfi_responses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rfis" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "rfi_number" integer NOT NULL,
    "subject" "text" NOT NULL,
    "question" "text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "priority" "text",
    "submitted_by" "uuid",
    "submitted_by_company_id" "uuid",
    "assigned_to" "uuid",
    "submitted_at" timestamp with time zone,
    "due_date" "date",
    "answered_at" timestamp with time zone,
    "closed_at" timestamp with time zone,
    "cost_impact_cents" integer,
    "schedule_impact_days" integer,
    "drawing_reference" "text",
    "spec_reference" "text",
    "location" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "decision_status" "text",
    "decision_note" "text",
    "decided_by_user_id" "uuid",
    "decided_by_contact_id" "uuid",
    "decided_at" timestamp with time zone,
    "decided_via_portal" boolean DEFAULT false,
    "decision_portal_token_id" "uuid",
    "last_response_at" timestamp with time zone,
    "attachment_file_id" "uuid",
    "assigned_company_id" "uuid",
    "notify_contact_id" "uuid",
    "sent_to_emails" "text"[],
    CONSTRAINT "rfis_decision_status_check" CHECK (("decision_status" = ANY (ARRAY['approved'::"text", 'revisions_requested'::"text", 'rejected'::"text"]))),
    CONSTRAINT "rfis_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'normal'::"text", 'high'::"text", 'urgent'::"text"]))),
    CONSTRAINT "rfis_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'open'::"text", 'answered'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."rfis" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_permissions" (
    "role_id" "uuid" NOT NULL,
    "permission_key" "text" NOT NULL
);


ALTER TABLE "public"."role_permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key" "text" NOT NULL,
    "label" "text" NOT NULL,
    "scope" "public"."role_scope" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."schedule_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "schedule_item_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "contact_id" "uuid",
    "company_id" "uuid",
    "role" "text" DEFAULT 'assigned'::"text",
    "planned_hours" numeric,
    "actual_hours" numeric DEFAULT 0,
    "hourly_rate_cents" integer,
    "notes" "text",
    "confirmed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "schedule_assignments_has_assignee" CHECK ((("user_id" IS NOT NULL) OR ("contact_id" IS NOT NULL) OR ("company_id" IS NOT NULL)))
);


ALTER TABLE "public"."schedule_assignments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."schedule_baselines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "snapshot_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "is_active" boolean DEFAULT false,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."schedule_baselines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."schedule_dependencies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "item_id" "uuid" NOT NULL,
    "depends_on_item_id" "uuid" NOT NULL,
    "dependency_type" "text" DEFAULT 'FS'::"text",
    "lag_days" integer DEFAULT 0
);


ALTER TABLE "public"."schedule_dependencies" OWNER TO "postgres";


COMMENT ON COLUMN "public"."schedule_dependencies"."dependency_type" IS 'FS=Finish-to-Start, SS=Start-to-Start, FF=Finish-to-Finish, SF=Start-to-Finish';



CREATE TABLE IF NOT EXISTS "public"."schedule_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "item_type" "text" DEFAULT 'task'::"text" NOT NULL,
    "status" "text" DEFAULT 'planned'::"text" NOT NULL,
    "start_date" "date",
    "end_date" "date",
    "progress" integer DEFAULT 0,
    "assigned_to" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "phase" "text",
    "trade" "text",
    "location" "text",
    "planned_hours" numeric,
    "actual_hours" numeric,
    "constraint_type" "text" DEFAULT 'asap'::"text",
    "constraint_date" "date",
    "is_critical_path" boolean DEFAULT false,
    "float_days" integer DEFAULT 0,
    "color" "text",
    "sort_order" integer DEFAULT 0,
    "inspection_checklist" "jsonb",
    "inspection_result" "text",
    "inspected_by" "uuid",
    "inspected_at" timestamp with time zone,
    "cost_code_id" "uuid",
    "budget_cents" integer DEFAULT 0,
    "actual_cost_cents" integer DEFAULT 0
);


ALTER TABLE "public"."schedule_items" OWNER TO "postgres";


COMMENT ON COLUMN "public"."schedule_items"."cost_code_id" IS 'Reference to cost code for budget tracking';



COMMENT ON COLUMN "public"."schedule_items"."budget_cents" IS 'Budgeted cost in cents';



COMMENT ON COLUMN "public"."schedule_items"."actual_cost_cents" IS 'Actual cost incurred in cents';



CREATE TABLE IF NOT EXISTS "public"."schedule_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "project_type" "text",
    "property_type" "text",
    "items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "is_public" boolean DEFAULT false,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."schedule_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."search_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "title" "text" DEFAULT ''::"text" NOT NULL,
    "body" "text" DEFAULT ''::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "search_vector" "tsvector" GENERATED ALWAYS AS ("to_tsvector"('"english"'::"regconfig", ((COALESCE("title", ''::"text") || ' '::"text") || COALESCE("body", ''::"text")))) STORED,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."search_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."search_embeddings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_id" "uuid" NOT NULL,
    "org_id" "uuid" NOT NULL,
    "model" "text" NOT NULL,
    "embedding" "public"."vector"(1536) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."search_embeddings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."selection_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "sort_order" integer DEFAULT 0,
    "is_template" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."selection_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."selection_options" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "category_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "price_cents" integer,
    "price_type" "text",
    "price_delta_cents" integer,
    "image_url" "text",
    "file_id" "uuid",
    "sku" "text",
    "vendor" "text",
    "lead_time_days" integer,
    "sort_order" integer DEFAULT 0,
    "is_default" boolean DEFAULT false NOT NULL,
    "is_available" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "selection_options_price_type_check" CHECK (("price_type" = ANY (ARRAY['included'::"text", 'upgrade'::"text", 'downgrade'::"text"])))
);


ALTER TABLE "public"."selection_options" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stripe_connected_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "stripe_account_id" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "charges_enabled" boolean DEFAULT false NOT NULL,
    "payouts_enabled" boolean DEFAULT false NOT NULL,
    "details_submitted" boolean DEFAULT false NOT NULL,
    "country" "text",
    "default_currency" "text",
    "dashboard_type" "text",
    "requirement_collection" "text",
    "onboarding_started_at" timestamp with time zone,
    "onboarding_completed_at" timestamp with time zone,
    "disabled_reason" "text",
    "requirements_currently_due" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "requirements_eventually_due" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "stripe_connected_accounts_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'onboarding'::"text", 'restricted'::"text", 'active'::"text", 'disconnected'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."stripe_connected_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."submittal_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "submittal_id" "uuid" NOT NULL,
    "item_number" integer NOT NULL,
    "description" "text" NOT NULL,
    "manufacturer" "text",
    "model_number" "text",
    "file_id" "uuid",
    "status" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "notes" "text",
    "portal_token_id" "uuid",
    "created_via_portal" boolean DEFAULT false NOT NULL,
    "responder_user_id" "uuid",
    "responder_contact_id" "uuid",
    CONSTRAINT "submittal_items_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."submittal_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."submittals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "submittal_number" integer NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "spec_section" "text",
    "submittal_type" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "submitted_by_company_id" "uuid",
    "submitted_by_contact_id" "uuid",
    "reviewed_by" "uuid",
    "submitted_at" timestamp with time zone,
    "due_date" "date",
    "reviewed_at" timestamp with time zone,
    "review_notes" "text",
    "lead_time_days" integer,
    "required_on_site" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "decision_status" "text",
    "decision_note" "text",
    "decision_by_user_id" "uuid",
    "decision_by_contact_id" "uuid",
    "decision_at" timestamp with time zone,
    "decision_via_portal" boolean DEFAULT false,
    "decision_portal_token_id" "uuid",
    "attachment_file_id" "uuid",
    "last_item_submitted_at" timestamp with time zone,
    "assigned_company_id" "uuid",
    CONSTRAINT "submittals_decision_status_check" CHECK (("decision_status" = ANY (ARRAY['approved'::"text", 'approved_as_noted'::"text", 'revise_resubmit'::"text", 'rejected'::"text"]))),
    CONSTRAINT "submittals_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'pending'::"text", 'approved'::"text", 'approved_as_noted'::"text", 'revise_resubmit'::"text", 'rejected'::"text"]))),
    CONSTRAINT "submittals_submittal_type_check" CHECK (("submittal_type" = ANY (ARRAY['product_data'::"text", 'shop_drawing'::"text", 'sample'::"text", 'mock_up'::"text", 'certificate'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."submittals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "plan_code" "text",
    "status" "public"."subscription_status" DEFAULT 'trialing'::"public"."subscription_status" NOT NULL,
    "current_period_start" timestamp with time zone DEFAULT "now"() NOT NULL,
    "current_period_end" timestamp with time zone,
    "trial_ends_at" timestamp with time zone,
    "cancel_at" timestamp with time zone,
    "external_customer_id" "text",
    "external_subscription_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."support_contracts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "starts_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ends_at" timestamp with time zone,
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."support_contracts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "contact_id" "uuid",
    "assigned_by" "uuid",
    "role" "text",
    "due_date" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "task_assignments_check" CHECK ((("user_id" IS NOT NULL) OR ("contact_id" IS NOT NULL)))
);


ALTER TABLE "public"."task_assignments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "title" "text" NOT NULL,
    "description" "text",
    "status" "public"."task_status" DEFAULT 'todo'::"public"."task_status" NOT NULL,
    "priority" "public"."task_priority" DEFAULT 'normal'::"public"."task_priority" NOT NULL,
    "start_date" "date",
    "due_date" "date",
    "completed_at" timestamp with time zone,
    "created_by" "uuid",
    "assigned_by" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."time_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "cost_code_id" "uuid",
    "worker_user_id" "uuid",
    "worker_company_id" "uuid",
    "worker_name" "text" NOT NULL,
    "work_date" "date" NOT NULL,
    "hours" numeric(6,2) NOT NULL,
    "base_rate_cents" integer NOT NULL,
    "burden_multiplier" numeric DEFAULT 1.0 NOT NULL,
    "cost_cents" integer GENERATED ALWAYS AS (("round"((("hours" * ("base_rate_cents")::numeric) * "burden_multiplier")))::integer) STORED,
    "is_billable" boolean DEFAULT true NOT NULL,
    "is_overtime" boolean DEFAULT false NOT NULL,
    "notes" "text",
    "attached_file_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "approved_by_pm_at" timestamp with time zone,
    "approved_by_pm_user_id" "uuid",
    "approved_by_client_at" timestamp with time zone,
    "approval_token_hash" "text",
    "approval_token_expires_at" timestamp with time zone,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "rejection_reason" "text",
    "billable_cost_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "time_entries_base_rate_cents_check" CHECK (("base_rate_cents" >= 0)),
    CONSTRAINT "time_entries_burden_multiplier_check" CHECK (("burden_multiplier" >= 1.0)),
    CONSTRAINT "time_entries_hours_check" CHECK ((("hours" > (0)::numeric) AND ("hours" <= (24)::numeric))),
    CONSTRAINT "time_entries_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'submitted'::"text", 'pm_approved'::"text", 'client_approved'::"text", 'rejected'::"text", 'locked'::"text"])))
);


ALTER TABLE "public"."time_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_notification_prefs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "email_enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_notification_prefs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."variance_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "budget_id" "uuid",
    "cost_code_id" "uuid",
    "alert_type" "text" NOT NULL,
    "threshold_percent" integer,
    "current_percent" integer,
    "budget_cents" integer,
    "actual_cents" integer,
    "variance_cents" integer,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "acknowledged_by" "uuid",
    "acknowledged_at" timestamp with time zone,
    "notified_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "variance_alerts_alert_type_check" CHECK (("alert_type" = ANY (ARRAY['threshold_exceeded'::"text", 'over_budget'::"text", 'margin_warning'::"text"]))),
    CONSTRAINT "variance_alerts_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'acknowledged'::"text", 'resolved'::"text"])))
);


ALTER TABLE "public"."variance_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vendor_bills" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "commitment_id" "uuid",
    "bill_number" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "bill_date" "date",
    "due_date" "date",
    "total_cents" integer,
    "currency" "text" DEFAULT 'usd'::"text" NOT NULL,
    "submitted_by_contact_id" "uuid",
    "file_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "approved_at" timestamp with time zone,
    "approved_by" "uuid",
    "paid_at" timestamp with time zone,
    "payment_reference" "text",
    "paid_cents" bigint DEFAULT 0,
    "payment_method" "text",
    "retainage_percent" numeric,
    "retainage_cents" bigint,
    "lien_waiver_status" "text",
    "lien_waiver_received_at" timestamp with time zone,
    "qbo_id" "text",
    "qbo_synced_at" timestamp with time zone,
    "qbo_sync_status" "text",
    "qbo_sync_error" "text",
    CONSTRAINT "vendor_bills_qbo_sync_status_check" CHECK ((("qbo_sync_status" IS NULL) OR ("qbo_sync_status" = ANY (ARRAY['pending'::"text", 'synced'::"text", 'error'::"text", 'skipped'::"text", 'needs_review'::"text"]))))
);


ALTER TABLE "public"."vendor_bills" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."warranty_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'open'::"text",
    "priority" "text" DEFAULT 'normal'::"text",
    "requested_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "closed_at" timestamp with time zone
);


ALTER TABLE "public"."warranty_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."webhook_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid",
    "provider" "text" NOT NULL,
    "provider_event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "status" "text" DEFAULT 'received'::"text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "processed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "webhook_events_status_check" CHECK (("status" = ANY (ARRAY['received'::"text", 'processed'::"text", 'failed'::"text", 'ignored'::"text"])))
);


ALTER TABLE "public"."webhook_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workflow_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "workflow_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "result" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone
);


ALTER TABLE "public"."workflow_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workflows" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "trigger" "text" NOT NULL,
    "conditions" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "actions" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."workflows" OWNER TO "postgres";


ALTER TABLE ONLY "public"."audit_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."audit_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."outbox" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."outbox_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."ai_search_action_requests"
    ADD CONSTRAINT "ai_search_action_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_search_artifacts"
    ADD CONSTRAINT "ai_search_artifacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_search_events"
    ADD CONSTRAINT "ai_search_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_search_messages"
    ADD CONSTRAINT "ai_search_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_search_sessions"
    ADD CONSTRAINT "ai_search_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."allowances"
    ADD CONSTRAINT "allowances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app_users"
    ADD CONSTRAINT "app_users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."approvals"
    ADD CONSTRAINT "approvals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."arc_bid_benchmark_facts"
    ADD CONSTRAINT "arc_bid_benchmark_facts_bid_submission_id_key" UNIQUE ("bid_submission_id");



ALTER TABLE ONLY "public"."arc_bid_benchmark_facts"
    ADD CONSTRAINT "arc_bid_benchmark_facts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."authorization_audit_log"
    ADD CONSTRAINT "authorization_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bid_access_tokens"
    ADD CONSTRAINT "bid_access_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bid_access_tokens"
    ADD CONSTRAINT "bid_access_tokens_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."bid_addenda"
    ADD CONSTRAINT "bid_addenda_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bid_addendum_acknowledgements"
    ADD CONSTRAINT "bid_addendum_acknowledgements_bid_addendum_id_bid_invite_id_key" UNIQUE ("bid_addendum_id", "bid_invite_id");



ALTER TABLE ONLY "public"."bid_addendum_acknowledgements"
    ADD CONSTRAINT "bid_addendum_acknowledgements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bid_awards"
    ADD CONSTRAINT "bid_awards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bid_invites"
    ADD CONSTRAINT "bid_invites_bid_package_id_company_id_key" UNIQUE ("bid_package_id", "company_id");



ALTER TABLE ONLY "public"."bid_invites"
    ADD CONSTRAINT "bid_invites_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bid_packages"
    ADD CONSTRAINT "bid_packages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bid_submissions"
    ADD CONSTRAINT "bid_submissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bill_lines"
    ADD CONSTRAINT "bill_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billable_costs"
    ADD CONSTRAINT "billable_costs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."budget_lines"
    ADD CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."budget_revision_lines"
    ADD CONSTRAINT "budget_revision_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."budget_revisions"
    ADD CONSTRAINT "budget_revisions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."budget_snapshots"
    ADD CONSTRAINT "budget_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."change_order_lines"
    ADD CONSTRAINT "change_order_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."change_orders"
    ADD CONSTRAINT "change_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."change_requests"
    ADD CONSTRAINT "change_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."closeout_items"
    ADD CONSTRAINT "closeout_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."closeout_packages"
    ADD CONSTRAINT "closeout_packages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."commitment_lines"
    ADD CONSTRAINT "commitment_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."commitments"
    ADD CONSTRAINT "commitments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."company_compliance_requirements"
    ADD CONSTRAINT "company_compliance_requirements_company_id_document_type_id_key" UNIQUE ("company_id", "document_type_id");



ALTER TABLE ONLY "public"."company_compliance_requirements"
    ADD CONSTRAINT "company_compliance_requirements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."compliance_document_types"
    ADD CONSTRAINT "compliance_document_types_org_id_code_key" UNIQUE ("org_id", "code");



ALTER TABLE ONLY "public"."compliance_document_types"
    ADD CONSTRAINT "compliance_document_types_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."compliance_documents"
    ADD CONSTRAINT "compliance_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_company_links"
    ADD CONSTRAINT "contact_company_links_contact_id_company_id_key" UNIQUE ("contact_id", "company_id");



ALTER TABLE ONLY "public"."contact_company_links"
    ADD CONSTRAINT "contact_company_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversation_read_states"
    ADD CONSTRAINT "conversation_read_states_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversion_run_steps"
    ADD CONSTRAINT "conversion_run_steps_conversion_run_id_step_key_key" UNIQUE ("conversion_run_id", "step_key");



ALTER TABLE ONLY "public"."conversion_run_steps"
    ADD CONSTRAINT "conversion_run_steps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversion_runs"
    ADD CONSTRAINT "conversion_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cost_approval_batches"
    ADD CONSTRAINT "cost_approval_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cost_approval_batches"
    ADD CONSTRAINT "cost_approval_batches_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."cost_codes"
    ADD CONSTRAINT "cost_codes_org_id_code_key" UNIQUE ("org_id", "code");



ALTER TABLE ONLY "public"."cost_codes"
    ADD CONSTRAINT "cost_codes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."custom_field_values"
    ADD CONSTRAINT "custom_field_values_field_id_entity_id_key" UNIQUE ("field_id", "entity_id");



ALTER TABLE ONLY "public"."custom_field_values"
    ADD CONSTRAINT "custom_field_values_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."custom_fields"
    ADD CONSTRAINT "custom_fields_org_id_entity_type_key_key" UNIQUE ("org_id", "entity_type", "key");



ALTER TABLE ONLY "public"."custom_fields"
    ADD CONSTRAINT "custom_fields_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."daily_log_entries"
    ADD CONSTRAINT "daily_log_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."daily_logs"
    ADD CONSTRAINT "daily_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."decisions"
    ADD CONSTRAINT "decisions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."doc_versions"
    ADD CONSTRAINT "doc_versions_file_id_version_number_key" UNIQUE ("file_id", "version_number");



ALTER TABLE ONLY "public"."doc_versions"
    ADD CONSTRAINT "doc_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document_fields"
    ADD CONSTRAINT "document_fields_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document_packet_items"
    ADD CONSTRAINT "document_packet_items_packet_id_file_id_key" UNIQUE ("packet_id", "file_id");



ALTER TABLE ONLY "public"."document_packet_items"
    ADD CONSTRAINT "document_packet_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document_packets"
    ADD CONSTRAINT "document_packets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document_signatures"
    ADD CONSTRAINT "document_signatures_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document_signing_requests"
    ADD CONSTRAINT "document_signing_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."draw_schedules"
    ADD CONSTRAINT "draw_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drawing_markups"
    ADD CONSTRAINT "drawing_markups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drawing_pins"
    ADD CONSTRAINT "drawing_pins_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drawing_revisions"
    ADD CONSTRAINT "drawing_revisions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drawing_sets"
    ADD CONSTRAINT "drawing_sets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drawing_sheet_versions"
    ADD CONSTRAINT "drawing_sheet_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drawing_sheets"
    ADD CONSTRAINT "drawing_sheets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."entitlements"
    ADD CONSTRAINT "entitlements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."envelope_events"
    ADD CONSTRAINT "envelope_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."envelope_recipients"
    ADD CONSTRAINT "envelope_recipients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."envelopes"
    ADD CONSTRAINT "envelopes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."estimate_items"
    ADD CONSTRAINT "estimate_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."estimate_templates"
    ADD CONSTRAINT "estimate_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."estimates"
    ADD CONSTRAINT "estimates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."external_portal_account_grants"
    ADD CONSTRAINT "external_portal_account_grants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."external_portal_accounts"
    ADD CONSTRAINT "external_portal_accounts_org_id_email_key" UNIQUE ("org_id", "email");



ALTER TABLE ONLY "public"."external_portal_accounts"
    ADD CONSTRAINT "external_portal_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."external_portal_sessions"
    ADD CONSTRAINT "external_portal_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."external_portal_sessions"
    ADD CONSTRAINT "external_portal_sessions_session_token_hash_key" UNIQUE ("session_token_hash");



ALTER TABLE ONLY "public"."feature_flags"
    ADD CONSTRAINT "feature_flags_org_id_flag_key_key" UNIQUE ("org_id", "flag_key");



ALTER TABLE ONLY "public"."feature_flags"
    ADD CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."file_access_events"
    ADD CONSTRAINT "file_access_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."file_links"
    ADD CONSTRAINT "file_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."file_share_links"
    ADD CONSTRAINT "file_share_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."files"
    ADD CONSTRAINT "files_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."form_instances"
    ADD CONSTRAINT "form_instances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."form_responses"
    ADD CONSTRAINT "form_responses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."form_templates"
    ADD CONSTRAINT "form_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_org_id_scope_key_key" UNIQUE ("org_id", "scope", "key");



ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."impersonation_sessions"
    ADD CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoice_lines"
    ADD CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoice_views"
    ADD CONSTRAINT "invoice_views_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."late_fee_applications"
    ADD CONSTRAINT "late_fee_applications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."late_fees"
    ADD CONSTRAINT "late_fees_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."licenses"
    ADD CONSTRAINT "licenses_license_key_key" UNIQUE ("license_key");



ALTER TABLE ONLY "public"."licenses"
    ADD CONSTRAINT "licenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lien_waivers"
    ADD CONSTRAINT "lien_waivers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."markup_rules"
    ADD CONSTRAINT "markup_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."membership_permission_overrides"
    ADD CONSTRAINT "membership_permission_overrides_pkey" PRIMARY KEY ("membership_id", "permission_key");



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_invite_token_key" UNIQUE ("invite_token");



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mentions"
    ADD CONSTRAINT "mentions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_deliveries"
    ADD CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."opportunities"
    ADD CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."org_settings"
    ADD CONSTRAINT "org_settings_pkey" PRIMARY KEY ("org_id");



ALTER TABLE ONLY "public"."orgs"
    ADD CONSTRAINT "orgs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."orgs"
    ADD CONSTRAINT "orgs_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."outbox"
    ADD CONSTRAINT "outbox_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_intents"
    ADD CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_links"
    ADD CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_methods"
    ADD CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_schedules"
    ADD CONSTRAINT "payment_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."plan_feature_limits"
    ADD CONSTRAINT "plan_feature_limits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."plan_feature_limits"
    ADD CONSTRAINT "plan_feature_limits_plan_code_feature_key_limit_type_key" UNIQUE ("plan_code", "feature_key", "limit_type");



ALTER TABLE ONLY "public"."plan_features"
    ADD CONSTRAINT "plan_features_pkey" PRIMARY KEY ("feature_key");



ALTER TABLE ONLY "public"."plans"
    ADD CONSTRAINT "plans_pkey" PRIMARY KEY ("code");



ALTER TABLE ONLY "public"."platform_memberships"
    ADD CONSTRAINT "platform_memberships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_memberships"
    ADD CONSTRAINT "platform_memberships_user_id_role_id_key" UNIQUE ("user_id", "role_id");



ALTER TABLE ONLY "public"."platform_settings"
    ADD CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."portal_access_tokens"
    ADD CONSTRAINT "portal_access_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."portal_access_tokens"
    ADD CONSTRAINT "portal_access_tokens_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."project_cost_code_progress"
    ADD CONSTRAINT "project_cost_code_progress_org_id_project_id_cost_code_id_key" UNIQUE ("org_id", "project_id", "cost_code_id");



ALTER TABLE ONLY "public"."project_cost_code_progress"
    ADD CONSTRAINT "project_cost_code_progress_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_expenses"
    ADD CONSTRAINT "project_expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_file_folder_permissions"
    ADD CONSTRAINT "project_file_folder_permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_file_folders"
    ADD CONSTRAINT "project_file_folders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_project_id_user_id_key" UNIQUE ("project_id", "user_id");



ALTER TABLE ONLY "public"."project_selections"
    ADD CONSTRAINT "project_selections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_selections"
    ADD CONSTRAINT "project_selections_project_id_category_id_key" UNIQUE ("project_id", "category_id");



ALTER TABLE ONLY "public"."project_settings"
    ADD CONSTRAINT "project_settings_pkey" PRIMARY KEY ("project_id");



ALTER TABLE ONLY "public"."project_vendors"
    ADD CONSTRAINT "project_vendors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_vendors"
    ADD CONSTRAINT "project_vendors_project_id_company_id_key" UNIQUE ("project_id", "company_id");



ALTER TABLE ONLY "public"."project_vendors"
    ADD CONSTRAINT "project_vendors_project_id_contact_id_key" UNIQUE ("project_id", "contact_id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."proposal_lines"
    ADD CONSTRAINT "proposal_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."proposals"
    ADD CONSTRAINT "proposals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."punch_items"
    ADD CONSTRAINT "punch_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_connections"
    ADD CONSTRAINT "qbo_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_invoice_reservations"
    ADD CONSTRAINT "qbo_invoice_reservations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_sync_records"
    ADD CONSTRAINT "qbo_sync_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_webhook_events"
    ADD CONSTRAINT "qbo_webhook_events_event_id_key" UNIQUE ("event_id");



ALTER TABLE ONLY "public"."qbo_webhook_events"
    ADD CONSTRAINT "qbo_webhook_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."receipts"
    ADD CONSTRAINT "receipts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reminder_deliveries"
    ADD CONSTRAINT "reminder_deliveries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reminders"
    ADD CONSTRAINT "reminders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."retainage"
    ADD CONSTRAINT "retainage_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rfi_responses"
    ADD CONSTRAINT "rfi_responses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rfis"
    ADD CONSTRAINT "rfis_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rfis"
    ADD CONSTRAINT "rfis_project_id_rfi_number_key" UNIQUE ("project_id", "rfi_number");



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission_key");



ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_key_key" UNIQUE ("key");



ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedule_assignments"
    ADD CONSTRAINT "schedule_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedule_baselines"
    ADD CONSTRAINT "schedule_baselines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedule_dependencies"
    ADD CONSTRAINT "schedule_dependencies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedule_dependencies"
    ADD CONSTRAINT "schedule_dependencies_unique" UNIQUE ("item_id", "depends_on_item_id");



ALTER TABLE ONLY "public"."schedule_items"
    ADD CONSTRAINT "schedule_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedule_templates"
    ADD CONSTRAINT "schedule_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."search_documents"
    ADD CONSTRAINT "search_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."search_embeddings"
    ADD CONSTRAINT "search_embeddings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."selection_categories"
    ADD CONSTRAINT "selection_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."selection_options"
    ADD CONSTRAINT "selection_options_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stripe_connected_accounts"
    ADD CONSTRAINT "stripe_connected_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."submittal_items"
    ADD CONSTRAINT "submittal_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."submittal_items"
    ADD CONSTRAINT "submittal_items_submittal_id_item_number_key" UNIQUE ("submittal_id", "item_number");



ALTER TABLE ONLY "public"."submittals"
    ADD CONSTRAINT "submittals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."submittals"
    ADD CONSTRAINT "submittals_project_id_submittal_number_key" UNIQUE ("project_id", "submittal_number");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_contracts"
    ADD CONSTRAINT "support_contracts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_assignments"
    ADD CONSTRAINT "task_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_notification_prefs"
    ADD CONSTRAINT "user_notification_prefs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."variance_alerts"
    ADD CONSTRAINT "variance_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."warranty_requests"
    ADD CONSTRAINT "warranty_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."webhook_events"
    ADD CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workflow_runs"
    ADD CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workflows"
    ADD CONSTRAINT "workflows_pkey" PRIMARY KEY ("id");



CREATE INDEX "allowances_org_idx" ON "public"."allowances" USING "btree" ("org_id");



CREATE INDEX "allowances_project_idx" ON "public"."allowances" USING "btree" ("project_id");



CREATE UNIQUE INDEX "app_users_email_idx" ON "public"."app_users" USING "btree" ("lower"(("email")::"text"));



CREATE INDEX "approvals_org_idx" ON "public"."approvals" USING "btree" ("org_id");



CREATE INDEX "arc_bid_benchmark_facts_cohort_relaxed_idx" ON "public"."arc_bid_benchmark_facts" USING "btree" ("currency", "normalized_trade", "project_type", "property_type", "total_cents");



CREATE INDEX "arc_bid_benchmark_facts_cohort_strict_idx" ON "public"."arc_bid_benchmark_facts" USING "btree" ("currency", "normalized_trade", "project_type", "property_type", "project_value_bucket", "lead_time_bucket", "duration_bucket", "total_cents");



CREATE INDEX "arc_bid_benchmark_facts_org_idx" ON "public"."arc_bid_benchmark_facts" USING "btree" ("org_id");



CREATE INDEX "arc_bid_benchmark_invite_org_idx" ON "public"."arc_bid_benchmark_facts" USING "btree" ("org_id", "bid_invite_id");



CREATE INDEX "arc_bid_benchmark_package_org_idx" ON "public"."arc_bid_benchmark_facts" USING "btree" ("org_id", "bid_package_id");



CREATE INDEX "arc_bid_benchmark_project_org_idx" ON "public"."arc_bid_benchmark_facts" USING "btree" ("org_id", "project_id");



CREATE INDEX "arc_bid_benchmark_submission_org_idx" ON "public"."arc_bid_benchmark_facts" USING "btree" ("org_id", "bid_submission_id");



CREATE INDEX "audit_log_org_idx" ON "public"."audit_log" USING "btree" ("org_id");



CREATE INDEX "bid_access_tokens_invite_idx" ON "public"."bid_access_tokens" USING "btree" ("bid_invite_id");



CREATE INDEX "bid_access_tokens_org_invite_idx" ON "public"."bid_access_tokens" USING "btree" ("org_id", "bid_invite_id");



CREATE INDEX "bid_access_tokens_paused_idx" ON "public"."bid_access_tokens" USING "btree" ("bid_invite_id", "paused_at") WHERE ("revoked_at" IS NULL);



CREATE UNIQUE INDEX "bid_addenda_org_id_id_uidx" ON "public"."bid_addenda" USING "btree" ("org_id", "id");



CREATE INDEX "bid_addenda_org_package_idx" ON "public"."bid_addenda" USING "btree" ("org_id", "bid_package_id");



CREATE UNIQUE INDEX "bid_addenda_package_number_uidx" ON "public"."bid_addenda" USING "btree" ("bid_package_id", "number");



CREATE INDEX "bid_addendum_ack_invite_idx" ON "public"."bid_addendum_acknowledgements" USING "btree" ("bid_invite_id");



CREATE INDEX "bid_addendum_ack_org_addendum_idx" ON "public"."bid_addendum_acknowledgements" USING "btree" ("org_id", "bid_addendum_id");



CREATE INDEX "bid_addendum_ack_org_invite_idx" ON "public"."bid_addendum_acknowledgements" USING "btree" ("org_id", "bid_invite_id");



CREATE INDEX "bid_awards_org_package_idx" ON "public"."bid_awards" USING "btree" ("org_id", "bid_package_id");



CREATE INDEX "bid_awards_org_submission_idx" ON "public"."bid_awards" USING "btree" ("org_id", "awarded_submission_id");



CREATE UNIQUE INDEX "bid_awards_package_uidx" ON "public"."bid_awards" USING "btree" ("bid_package_id");



CREATE INDEX "bid_invites_org_company_idx" ON "public"."bid_invites" USING "btree" ("org_id", "company_id");



CREATE INDEX "bid_invites_org_contact_idx" ON "public"."bid_invites" USING "btree" ("org_id", "contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE UNIQUE INDEX "bid_invites_org_id_id_uidx" ON "public"."bid_invites" USING "btree" ("org_id", "id");



CREATE INDEX "bid_invites_org_package_idx" ON "public"."bid_invites" USING "btree" ("org_id", "bid_package_id");



CREATE UNIQUE INDEX "bid_invites_package_contact_uidx" ON "public"."bid_invites" USING "btree" ("bid_package_id", "contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE UNIQUE INDEX "bid_invites_package_email_uidx" ON "public"."bid_invites" USING "btree" ("bid_package_id", "invite_email") WHERE ("invite_email" IS NOT NULL);



CREATE INDEX "bid_packages_org_cost_code_idx" ON "public"."bid_packages" USING "btree" ("org_id", "cost_code_id");



CREATE UNIQUE INDEX "bid_packages_org_id_id_uidx" ON "public"."bid_packages" USING "btree" ("org_id", "id");



CREATE INDEX "bid_packages_org_project_idx" ON "public"."bid_packages" USING "btree" ("org_id", "project_id");



CREATE INDEX "bid_packages_org_project_status_idx" ON "public"."bid_packages" USING "btree" ("org_id", "project_id", "status");



CREATE INDEX "bid_packages_project_due_idx" ON "public"."bid_packages" USING "btree" ("project_id", "due_at");



CREATE UNIQUE INDEX "bid_submissions_current_uidx" ON "public"."bid_submissions" USING "btree" ("bid_invite_id") WHERE ("is_current" = true);



CREATE UNIQUE INDEX "bid_submissions_org_id_id_uidx" ON "public"."bid_submissions" USING "btree" ("org_id", "id");



CREATE INDEX "bid_submissions_org_invite_idx" ON "public"."bid_submissions" USING "btree" ("org_id", "bid_invite_id");



CREATE INDEX "bill_lines_bill_idx" ON "public"."bill_lines" USING "btree" ("bill_id");



CREATE INDEX "bill_lines_cost_code_idx" ON "public"."bill_lines" USING "btree" ("cost_code_id");



CREATE INDEX "bill_lines_org_idx" ON "public"."bill_lines" USING "btree" ("org_id");



CREATE INDEX "billable_costs_invoice_idx" ON "public"."billable_costs" USING "btree" ("invoice_id");



CREATE INDEX "billable_costs_org_idx" ON "public"."billable_costs" USING "btree" ("org_id");



CREATE INDEX "billable_costs_org_project_status_date_idx" ON "public"."billable_costs" USING "btree" ("org_id", "project_id", "status", "occurred_on");



CREATE INDEX "billable_costs_project_idx" ON "public"."billable_costs" USING "btree" ("project_id");



CREATE INDEX "billable_costs_source_idx" ON "public"."billable_costs" USING "btree" ("source_type", "source_id");



CREATE UNIQUE INDEX "billable_costs_source_uq" ON "public"."billable_costs" USING "btree" ("source_type", "source_id") WHERE ("status" <> 'voided'::"text");



CREATE INDEX "billable_costs_status_idx" ON "public"."billable_costs" USING "btree" ("status");



CREATE INDEX "budget_lines_budget_idx" ON "public"."budget_lines" USING "btree" ("budget_id");



CREATE INDEX "budget_lines_org_idx" ON "public"."budget_lines" USING "btree" ("org_id");



CREATE INDEX "budget_revision_lines_cost_code_idx" ON "public"."budget_revision_lines" USING "btree" ("cost_code_id");



CREATE INDEX "budget_revision_lines_revision_idx" ON "public"."budget_revision_lines" USING "btree" ("budget_revision_id");



CREATE UNIQUE INDEX "budget_revisions_change_order_unique" ON "public"."budget_revisions" USING "btree" ("org_id", "change_order_id");



CREATE INDEX "budget_revisions_project_idx" ON "public"."budget_revisions" USING "btree" ("project_id");



CREATE INDEX "budget_snapshots_org_idx" ON "public"."budget_snapshots" USING "btree" ("org_id");



CREATE INDEX "budget_snapshots_project_date_idx" ON "public"."budget_snapshots" USING "btree" ("project_id", "snapshot_date");



CREATE UNIQUE INDEX "budget_snapshots_unique_idx" ON "public"."budget_snapshots" USING "btree" ("budget_id", "snapshot_date");



CREATE INDEX "budgets_org_idx" ON "public"."budgets" USING "btree" ("org_id");



CREATE INDEX "budgets_project_idx" ON "public"."budgets" USING "btree" ("project_id");



CREATE INDEX "change_order_lines_change_order_idx" ON "public"."change_order_lines" USING "btree" ("change_order_id");



CREATE INDEX "change_order_lines_cost_code_idx" ON "public"."change_order_lines" USING "btree" ("cost_code_id");



CREATE INDEX "change_order_lines_org_idx" ON "public"."change_order_lines" USING "btree" ("org_id");



CREATE INDEX "change_orders_org_idx" ON "public"."change_orders" USING "btree" ("org_id");



CREATE INDEX "change_orders_project_idx" ON "public"."change_orders" USING "btree" ("project_id");



CREATE INDEX "closeout_items_org_package_idx" ON "public"."closeout_items" USING "btree" ("org_id", "closeout_package_id", "status");



CREATE INDEX "closeout_packages_org_project_idx" ON "public"."closeout_packages" USING "btree" ("org_id", "project_id");



CREATE INDEX "commitment_lines_commitment_idx" ON "public"."commitment_lines" USING "btree" ("commitment_id");



CREATE INDEX "commitment_lines_cost_code_idx" ON "public"."commitment_lines" USING "btree" ("cost_code_id");



CREATE INDEX "commitment_lines_org_idx" ON "public"."commitment_lines" USING "btree" ("org_id");



CREATE INDEX "commitments_org_idx" ON "public"."commitments" USING "btree" ("org_id");



CREATE INDEX "commitments_project_idx" ON "public"."commitments" USING "btree" ("project_id");



CREATE UNIQUE INDEX "companies_org_id_id_uidx" ON "public"."companies" USING "btree" ("org_id", "id");



CREATE INDEX "companies_org_idx" ON "public"."companies" USING "btree" ("org_id");



CREATE INDEX "company_compliance_req_company_idx" ON "public"."company_compliance_requirements" USING "btree" ("company_id");



CREATE INDEX "company_compliance_req_org_idx" ON "public"."company_compliance_requirements" USING "btree" ("org_id");



CREATE INDEX "compliance_doc_types_org_idx" ON "public"."compliance_document_types" USING "btree" ("org_id");



CREATE INDEX "compliance_docs_company_idx" ON "public"."compliance_documents" USING "btree" ("company_id");



CREATE INDEX "compliance_docs_expiry_idx" ON "public"."compliance_documents" USING "btree" ("expiry_date") WHERE ("status" = 'approved'::"text");



CREATE INDEX "compliance_docs_org_idx" ON "public"."compliance_documents" USING "btree" ("org_id");



CREATE INDEX "compliance_docs_pending_idx" ON "public"."compliance_documents" USING "btree" ("org_id", "status") WHERE ("status" = 'pending_review'::"text");



CREATE INDEX "compliance_docs_status_idx" ON "public"."compliance_documents" USING "btree" ("status");



CREATE INDEX "contact_company_links_org_idx" ON "public"."contact_company_links" USING "btree" ("org_id");



CREATE UNIQUE INDEX "contacts_org_id_id_uidx" ON "public"."contacts" USING "btree" ("org_id", "id");



CREATE INDEX "contacts_org_idx" ON "public"."contacts" USING "btree" ("org_id");



CREATE INDEX "contracts_org_idx" ON "public"."contracts" USING "btree" ("org_id");



CREATE UNIQUE INDEX "contracts_org_number_idx" ON "public"."contracts" USING "btree" ("org_id", "number") WHERE ("number" IS NOT NULL);



CREATE INDEX "contracts_project_idx" ON "public"."contracts" USING "btree" ("project_id");



CREATE UNIQUE INDEX "conversation_read_states_contact_idx" ON "public"."conversation_read_states" USING "btree" ("conversation_id", "contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE INDEX "conversation_read_states_org_idx" ON "public"."conversation_read_states" USING "btree" ("org_id");



CREATE UNIQUE INDEX "conversation_read_states_user_idx" ON "public"."conversation_read_states" USING "btree" ("conversation_id", "user_id") WHERE ("user_id" IS NOT NULL);



CREATE INDEX "conversations_audience_company_idx" ON "public"."conversations" USING "btree" ("audience_company_id") WHERE ("audience_company_id" IS NOT NULL);



CREATE INDEX "conversations_last_message_idx" ON "public"."conversations" USING "btree" ("last_message_at" DESC NULLS LAST);



CREATE INDEX "conversations_org_idx" ON "public"."conversations" USING "btree" ("org_id");



CREATE INDEX "conversations_project_idx" ON "public"."conversations" USING "btree" ("project_id");



CREATE UNIQUE INDEX "conversations_unique_audience_idx" ON "public"."conversations" USING "btree" ("org_id", "project_id", "channel", COALESCE("audience_company_id", '00000000-0000-0000-0000-000000000000'::"uuid"));



CREATE INDEX "conversion_run_steps_org_status_idx" ON "public"."conversion_run_steps" USING "btree" ("org_id", "status", "created_at" DESC);



CREATE INDEX "conversion_run_steps_run_idx" ON "public"."conversion_run_steps" USING "btree" ("conversion_run_id", "created_at");



CREATE INDEX "conversion_runs_org_status_idx" ON "public"."conversion_runs" USING "btree" ("org_id", "status", "created_at" DESC);



CREATE INDEX "conversion_runs_project_idx" ON "public"."conversion_runs" USING "btree" ("project_id", "created_at" DESC);



CREATE INDEX "conversion_runs_source_idx" ON "public"."conversion_runs" USING "btree" ("org_id", "source_entity_type", "source_entity_id");



CREATE INDEX "cost_approval_batches_org_project_status_idx" ON "public"."cost_approval_batches" USING "btree" ("org_id", "project_id", "status");



CREATE INDEX "cost_codes_category_idx" ON "public"."cost_codes" USING "btree" ("category");



CREATE INDEX "cost_codes_org_idx" ON "public"."cost_codes" USING "btree" ("org_id");



CREATE INDEX "cost_codes_org_reimbursable_idx" ON "public"."cost_codes" USING "btree" ("org_id", "is_reimbursable_default");



CREATE INDEX "custom_field_values_org_idx" ON "public"."custom_field_values" USING "btree" ("org_id");



CREATE INDEX "custom_fields_org_idx" ON "public"."custom_fields" USING "btree" ("org_id");



CREATE INDEX "daily_log_entries_daily_log_id_idx" ON "public"."daily_log_entries" USING "btree" ("daily_log_id");



CREATE INDEX "daily_log_entries_org_idx" ON "public"."daily_log_entries" USING "btree" ("org_id");



CREATE INDEX "daily_log_entries_project_idx" ON "public"."daily_log_entries" USING "btree" ("project_id");



CREATE INDEX "daily_log_entries_punch_item_id_idx" ON "public"."daily_log_entries" USING "btree" ("punch_item_id");



CREATE INDEX "daily_log_entries_schedule_item_id_idx" ON "public"."daily_log_entries" USING "btree" ("schedule_item_id");



CREATE INDEX "daily_log_entries_task_id_idx" ON "public"."daily_log_entries" USING "btree" ("task_id");



CREATE INDEX "daily_logs_org_idx" ON "public"."daily_logs" USING "btree" ("org_id");



CREATE INDEX "daily_logs_project_idx" ON "public"."daily_logs" USING "btree" ("project_id");



CREATE INDEX "decisions_org_project_idx" ON "public"."decisions" USING "btree" ("org_id", "project_id", "status");



CREATE INDEX "doc_versions_file_version_idx" ON "public"."doc_versions" USING "btree" ("org_id", "file_id", "version_number" DESC);



CREATE INDEX "doc_versions_org_idx" ON "public"."doc_versions" USING "btree" ("org_id");



CREATE INDEX "document_fields_doc_rev_idx" ON "public"."document_fields" USING "btree" ("org_id", "document_id", "revision");



CREATE INDEX "document_fields_document_id_idx" ON "public"."document_fields" USING "btree" ("document_id");



CREATE INDEX "document_signatures_document_id_idx" ON "public"."document_signatures" USING "btree" ("document_id");



CREATE INDEX "document_signatures_org_doc_created_idx" ON "public"."document_signatures" USING "btree" ("org_id", "document_id", "created_at" DESC);



CREATE INDEX "document_signatures_signing_request_id_idx" ON "public"."document_signatures" USING "btree" ("signing_request_id");



CREATE INDEX "document_signing_requests_active_sequence_idx" ON "public"."document_signing_requests" USING "btree" ("org_id", "group_id", "sequence") WHERE (("required" = true) AND ("status" = ANY (ARRAY['draft'::"text", 'sent'::"text", 'viewed'::"text"])));



CREATE INDEX "document_signing_requests_document_id_idx" ON "public"."document_signing_requests" USING "btree" ("document_id");



CREATE INDEX "document_signing_requests_envelope_idx" ON "public"."document_signing_requests" USING "btree" ("org_id", "envelope_id", "sequence", "created_at" DESC) WHERE ("envelope_id" IS NOT NULL);



CREATE INDEX "document_signing_requests_envelope_recipient_idx" ON "public"."document_signing_requests" USING "btree" ("envelope_recipient_id") WHERE ("envelope_recipient_id" IS NOT NULL);



CREATE INDEX "document_signing_requests_group_idx" ON "public"."document_signing_requests" USING "btree" ("org_id", "document_id", "group_id", "sequence");



CREATE INDEX "document_signing_requests_group_status_idx" ON "public"."document_signing_requests" USING "btree" ("org_id", "group_id", "status", "sequence");



CREATE INDEX "document_signing_requests_org_doc_created_idx" ON "public"."document_signing_requests" USING "btree" ("org_id", "document_id", "created_at" DESC);



CREATE INDEX "document_signing_requests_recipient_contact_id_idx" ON "public"."document_signing_requests" USING "btree" ("recipient_contact_id") WHERE ("recipient_contact_id" IS NOT NULL);



CREATE UNIQUE INDEX "document_signing_requests_token_hash_idx" ON "public"."document_signing_requests" USING "btree" ("token_hash") WHERE ("token_hash" IS NOT NULL);



CREATE INDEX "documents_executed_file_id_idx" ON "public"."documents" USING "btree" ("executed_file_id") WHERE ("executed_file_id" IS NOT NULL);



CREATE INDEX "documents_org_project_created_idx" ON "public"."documents" USING "btree" ("org_id", "project_id", "created_at" DESC);



CREATE INDEX "documents_org_source_entity_created_idx" ON "public"."documents" USING "btree" ("org_id", "source_entity_type", "source_entity_id", "created_at" DESC) WHERE (("source_entity_type" IS NOT NULL) AND ("source_entity_id" IS NOT NULL));



CREATE INDEX "documents_org_status_created_idx" ON "public"."documents" USING "btree" ("org_id", "status", "created_at" DESC);



CREATE INDEX "documents_project_id_idx" ON "public"."documents" USING "btree" ("project_id");



CREATE INDEX "documents_source_file_id_idx" ON "public"."documents" USING "btree" ("source_file_id");



CREATE INDEX "draw_schedules_org_idx" ON "public"."draw_schedules" USING "btree" ("org_id");



CREATE INDEX "draw_schedules_project_idx" ON "public"."draw_schedules" USING "btree" ("project_id");



CREATE UNIQUE INDEX "draw_schedules_project_number_idx" ON "public"."draw_schedules" USING "btree" ("project_id", "draw_number");



CREATE INDEX "draw_schedules_status_idx" ON "public"."draw_schedules" USING "btree" ("status");



CREATE INDEX "drawing_markups_creator_idx" ON "public"."drawing_markups" USING "btree" ("org_id", "created_by");



CREATE INDEX "drawing_markups_data_idx" ON "public"."drawing_markups" USING "gin" ("data");



CREATE INDEX "drawing_markups_sheet_idx" ON "public"."drawing_markups" USING "btree" ("org_id", "drawing_sheet_id");



CREATE INDEX "drawing_markups_version_idx" ON "public"."drawing_markups" USING "btree" ("org_id", "sheet_version_id");



CREATE INDEX "drawing_pins_entity_idx" ON "public"."drawing_pins" USING "btree" ("org_id", "entity_type", "entity_id");



CREATE UNIQUE INDEX "drawing_pins_entity_sheet_unique" ON "public"."drawing_pins" USING "btree" ("org_id", "drawing_sheet_id", "entity_type", "entity_id");



CREATE INDEX "drawing_pins_project_idx" ON "public"."drawing_pins" USING "btree" ("org_id", "project_id");



CREATE INDEX "drawing_pins_sheet_idx" ON "public"."drawing_pins" USING "btree" ("org_id", "drawing_sheet_id");



CREATE INDEX "drawing_pins_status_idx" ON "public"."drawing_pins" USING "btree" ("org_id", "status");



CREATE INDEX "drawing_pins_version_idx" ON "public"."drawing_pins" USING "btree" ("org_id", "sheet_version_id");



CREATE INDEX "drawing_revisions_project_idx" ON "public"."drawing_revisions" USING "btree" ("org_id", "project_id");



CREATE INDEX "drawing_revisions_set_idx" ON "public"."drawing_revisions" USING "btree" ("org_id", "drawing_set_id");



CREATE INDEX "drawing_sets_created_at_idx" ON "public"."drawing_sets" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "drawing_sets_org_project_idx" ON "public"."drawing_sets" USING "btree" ("org_id", "project_id");



CREATE INDEX "drawing_sets_status_idx" ON "public"."drawing_sets" USING "btree" ("org_id", "status");



CREATE INDEX "drawing_sheet_versions_revision_idx" ON "public"."drawing_sheet_versions" USING "btree" ("org_id", "drawing_revision_id");



CREATE INDEX "drawing_sheet_versions_sheet_idx" ON "public"."drawing_sheet_versions" USING "btree" ("org_id", "drawing_sheet_id");



CREATE INDEX "drawing_sheets_discipline_idx" ON "public"."drawing_sheets" USING "btree" ("org_id", "project_id", "discipline");



CREATE INDEX "drawing_sheets_number_idx" ON "public"."drawing_sheets" USING "btree" ("org_id", "project_id", "sheet_number");



CREATE INDEX "drawing_sheets_project_idx" ON "public"."drawing_sheets" USING "btree" ("org_id", "project_id");



CREATE INDEX "drawing_sheets_set_idx" ON "public"."drawing_sheets" USING "btree" ("org_id", "drawing_set_id");



CREATE UNIQUE INDEX "entitlements_org_feature_limit_idx" ON "public"."entitlements" USING "btree" ("org_id", "feature_key", COALESCE("limit_type", 'default'::"text"));



CREATE INDEX "envelope_events_org_envelope_created_idx" ON "public"."envelope_events" USING "btree" ("org_id", "envelope_id", "created_at" DESC);



CREATE INDEX "envelope_events_org_event_created_idx" ON "public"."envelope_events" USING "btree" ("org_id", "event_type", "created_at" DESC);



CREATE INDEX "envelope_recipients_contact_idx" ON "public"."envelope_recipients" USING "btree" ("org_id", "contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE INDEX "envelope_recipients_email_idx" ON "public"."envelope_recipients" USING "btree" ("org_id", "email") WHERE ("email" IS NOT NULL);



CREATE INDEX "envelope_recipients_org_envelope_role_idx" ON "public"."envelope_recipients" USING "btree" ("org_id", "envelope_id", "role", "sequence");



CREATE INDEX "envelope_recipients_org_envelope_sequence_idx" ON "public"."envelope_recipients" USING "btree" ("org_id", "envelope_id", "sequence", "created_at");



CREATE INDEX "envelope_recipients_user_idx" ON "public"."envelope_recipients" USING "btree" ("org_id", "user_id") WHERE ("user_id" IS NOT NULL);



CREATE INDEX "envelopes_draft_document_idx" ON "public"."envelopes" USING "btree" ("org_id", "document_id", "created_at" DESC) WHERE ("status" = 'draft'::"text");



CREATE INDEX "envelopes_org_document_created_idx" ON "public"."envelopes" USING "btree" ("org_id", "document_id", "created_at" DESC);



CREATE INDEX "envelopes_org_project_created_idx" ON "public"."envelopes" USING "btree" ("org_id", "project_id", "created_at" DESC);



CREATE INDEX "envelopes_org_source_entity_created_idx" ON "public"."envelopes" USING "btree" ("org_id", "source_entity_type", "source_entity_id", "created_at" DESC) WHERE (("source_entity_type" IS NOT NULL) AND ("source_entity_id" IS NOT NULL));



CREATE INDEX "envelopes_org_status_created_idx" ON "public"."envelopes" USING "btree" ("org_id", "status", "created_at" DESC);



CREATE INDEX "estimate_items_estimate_idx" ON "public"."estimate_items" USING "btree" ("estimate_id");



CREATE INDEX "estimate_items_org_idx" ON "public"."estimate_items" USING "btree" ("org_id");



CREATE INDEX "estimate_templates_org_idx" ON "public"."estimate_templates" USING "btree" ("org_id");



CREATE INDEX "estimates_opportunity_id_idx" ON "public"."estimates" USING "btree" ("opportunity_id");



CREATE INDEX "estimates_org_idx" ON "public"."estimates" USING "btree" ("org_id");



CREATE INDEX "estimates_project_idx" ON "public"."estimates" USING "btree" ("project_id");



CREATE INDEX "events_org_idx" ON "public"."events" USING "btree" ("org_id");



CREATE INDEX "external_portal_accounts_org_status_idx" ON "public"."external_portal_accounts" USING "btree" ("org_id", "status");



CREATE UNIQUE INDEX "external_portal_grants_account_bid_token_uidx" ON "public"."external_portal_account_grants" USING "btree" ("account_id", "bid_access_token_id") WHERE ("bid_access_token_id" IS NOT NULL);



CREATE UNIQUE INDEX "external_portal_grants_account_portal_token_uidx" ON "public"."external_portal_account_grants" USING "btree" ("account_id", "portal_access_token_id") WHERE ("portal_access_token_id" IS NOT NULL);



CREATE INDEX "external_portal_grants_bid_token_idx" ON "public"."external_portal_account_grants" USING "btree" ("bid_access_token_id", "status") WHERE ("bid_access_token_id" IS NOT NULL);



CREATE INDEX "external_portal_grants_portal_token_idx" ON "public"."external_portal_account_grants" USING "btree" ("portal_access_token_id", "status") WHERE ("portal_access_token_id" IS NOT NULL);



CREATE INDEX "external_portal_sessions_account_idx" ON "public"."external_portal_sessions" USING "btree" ("account_id", "expires_at") WHERE ("revoked_at" IS NULL);



CREATE INDEX "file_access_events_created_idx" ON "public"."file_access_events" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "file_access_events_file_idx" ON "public"."file_access_events" USING "btree" ("org_id", "file_id", "created_at" DESC);



CREATE INDEX "file_access_events_user_idx" ON "public"."file_access_events" USING "btree" ("org_id", "actor_user_id", "created_at" DESC);



CREATE INDEX "file_links_entity_idx" ON "public"."file_links" USING "btree" ("org_id", "entity_type", "entity_id");



CREATE INDEX "file_links_message_attachments_idx" ON "public"."file_links" USING "btree" ("entity_type", "entity_id") WHERE ("entity_type" = 'message'::"text");



CREATE INDEX "file_links_org_idx" ON "public"."file_links" USING "btree" ("org_id");



CREATE INDEX "file_links_org_project_idx" ON "public"."file_links" USING "btree" ("org_id", "project_id");



CREATE INDEX "file_links_project_idx" ON "public"."file_links" USING "btree" ("project_id");



CREATE INDEX "file_share_links_file_id_idx" ON "public"."file_share_links" USING "btree" ("file_id");



CREATE INDEX "file_share_links_org_project_idx" ON "public"."file_share_links" USING "btree" ("org_id", "project_id");



CREATE UNIQUE INDEX "file_share_links_token_key" ON "public"."file_share_links" USING "btree" ("token");



CREATE INDEX "files_archived_idx" ON "public"."files" USING "btree" ("org_id", "archived_at") WHERE ("archived_at" IS NOT NULL);



CREATE INDEX "files_daily_log_id_idx" ON "public"."files" USING "btree" ("daily_log_id");



CREATE INDEX "files_folder_path_idx" ON "public"."files" USING "btree" ("org_id", "folder_path");



CREATE INDEX "files_metadata_idx" ON "public"."files" USING "gin" ("metadata");



CREATE INDEX "files_org_idx" ON "public"."files" USING "btree" ("org_id");



CREATE INDEX "files_org_project_category_idx" ON "public"."files" USING "btree" ("org_id", "project_id", "category");



CREATE INDEX "files_org_project_created_idx" ON "public"."files" USING "btree" ("org_id", "project_id", "created_at" DESC);



CREATE INDEX "files_project_idx" ON "public"."files" USING "btree" ("project_id");



CREATE INDEX "files_schedule_item_id_idx" ON "public"."files" USING "btree" ("schedule_item_id");



CREATE INDEX "files_share_with_clients_idx" ON "public"."files" USING "btree" ("project_id", "share_with_clients") WHERE ("share_with_clients" = true);



CREATE INDEX "files_share_with_subs_idx" ON "public"."files" USING "btree" ("project_id", "share_with_subs") WHERE ("share_with_subs" = true);



CREATE INDEX "files_tags_idx" ON "public"."files" USING "gin" ("tags");



CREATE INDEX "form_instances_org_idx" ON "public"."form_instances" USING "btree" ("org_id");



CREATE INDEX "form_responses_org_idx" ON "public"."form_responses" USING "btree" ("org_id");



CREATE INDEX "form_templates_org_idx" ON "public"."form_templates" USING "btree" ("org_id");



CREATE INDEX "idempotency_keys_org_scope_idx" ON "public"."idempotency_keys" USING "btree" ("org_id", "scope");



CREATE INDEX "idx_ai_search_action_requests_org_user_created" ON "public"."ai_search_action_requests" USING "btree" ("org_id", "user_id", "created_at" DESC);



CREATE INDEX "idx_ai_search_action_requests_status" ON "public"."ai_search_action_requests" USING "btree" ("org_id", "user_id", "status", "created_at" DESC);



CREATE INDEX "idx_ai_search_artifacts_expires" ON "public"."ai_search_artifacts" USING "btree" ("expires_at");



CREATE INDEX "idx_ai_search_artifacts_org_created" ON "public"."ai_search_artifacts" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "idx_ai_search_events_org_created" ON "public"."ai_search_events" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "idx_ai_search_events_org_success_created" ON "public"."ai_search_events" USING "btree" ("org_id", "success", "created_at" DESC);



CREATE INDEX "idx_ai_search_events_user_created" ON "public"."ai_search_events" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_ai_search_messages_org_user_created" ON "public"."ai_search_messages" USING "btree" ("org_id", "user_id", "created_at" DESC);



CREATE INDEX "idx_ai_search_messages_session_created" ON "public"."ai_search_messages" USING "btree" ("session_id", "created_at" DESC);



CREATE INDEX "idx_ai_search_sessions_org_user_updated" ON "public"."ai_search_sessions" USING "btree" ("org_id", "user_id", "updated_at" DESC);



CREATE INDEX "idx_authorization_audit_log_action_occurred_at" ON "public"."authorization_audit_log" USING "btree" ("action_key", "occurred_at" DESC);



CREATE INDEX "idx_authorization_audit_log_actor_occurred_at" ON "public"."authorization_audit_log" USING "btree" ("actor_user_id", "occurred_at" DESC);



CREATE INDEX "idx_authorization_audit_log_occurred_at" ON "public"."authorization_audit_log" USING "btree" ("occurred_at" DESC);



CREATE INDEX "idx_authorization_audit_log_org_occurred_at" ON "public"."authorization_audit_log" USING "btree" ("org_id", "occurred_at" DESC);



CREATE INDEX "idx_change_orders_search" ON "public"."change_orders" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((COALESCE("title", ''::"text") || ' '::"text") || COALESCE("description", ''::"text"))));



CREATE INDEX "idx_companies_search" ON "public"."companies" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((COALESCE("name", ''::"text") || ' '::"text") || COALESCE("email", ''::"text"))));



CREATE INDEX "idx_contacts_search" ON "public"."contacts" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((COALESCE("full_name", ''::"text") || ' '::"text") || (COALESCE("email", ''::"public"."citext"))::"text")));



CREATE INDEX "idx_conversations_search" ON "public"."conversations" USING "gin" ("to_tsvector"('"english"'::"regconfig", COALESCE("subject", ''::"text")));



CREATE INDEX "idx_daily_logs_search" ON "public"."daily_logs" USING "gin" ("to_tsvector"('"english"'::"regconfig", COALESCE("summary", ''::"text")));



CREATE INDEX "idx_drawing_sets_search" ON "public"."drawing_sets" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((COALESCE("title", ''::"text") || ' '::"text") || COALESCE("description", ''::"text"))));



CREATE INDEX "idx_drawing_sheet_versions_has_images" ON "public"."drawing_sheet_versions" USING "btree" ("id") WHERE ("thumbnail_url" IS NOT NULL);



CREATE INDEX "idx_drawing_sheet_versions_needs_images" ON "public"."drawing_sheet_versions" USING "btree" ("created_at") WHERE ("thumbnail_url" IS NULL);



CREATE INDEX "idx_drawing_sheet_versions_needs_tiles" ON "public"."drawing_sheet_versions" USING "btree" ("created_at") WHERE ("tile_manifest" IS NULL);



CREATE INDEX "idx_drawing_sheet_versions_thumb_path" ON "public"."drawing_sheet_versions" USING "btree" ("drawing_sheet_id") WHERE ("thumb_path" IS NOT NULL);



CREATE UNIQUE INDEX "idx_drawing_sheets_list_id" ON "public"."drawing_sheets_list_mv" USING "btree" ("id");



CREATE INDEX "idx_drawing_sheets_list_org_project_sort" ON "public"."drawing_sheets_list_mv" USING "btree" ("org_id", "project_id", "sort_order");



CREATE INDEX "idx_files_search" ON "public"."files" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((COALESCE("file_name", ''::"text") || ' '::"text") || COALESCE("description", ''::"text"))));



CREATE INDEX "idx_files_status" ON "public"."files" USING "btree" ("org_id", "project_id", "status");



CREATE INDEX "idx_impersonation_sessions_actor_started_at" ON "public"."impersonation_sessions" USING "btree" ("actor_user_id", "started_at" DESC);



CREATE INDEX "idx_impersonation_sessions_org_started_at" ON "public"."impersonation_sessions" USING "btree" ("org_id", "started_at" DESC);



CREATE INDEX "idx_impersonation_sessions_target_started_at" ON "public"."impersonation_sessions" USING "btree" ("target_user_id", "started_at" DESC);



CREATE INDEX "idx_invoices_search" ON "public"."invoices" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((COALESCE("title", ''::"text") || ' '::"text") || COALESCE("invoice_number", ''::"text"))));



CREATE INDEX "idx_memberships_invite_token" ON "public"."memberships" USING "btree" ("invite_token") WHERE ("invite_token" IS NOT NULL);



CREATE INDEX "idx_messages_search" ON "public"."messages" USING "gin" ("to_tsvector"('"english"'::"regconfig", COALESCE("body", ''::"text")));



CREATE INDEX "idx_platform_memberships_role_status" ON "public"."platform_memberships" USING "btree" ("role_id", "status");



CREATE INDEX "idx_platform_memberships_user_status" ON "public"."platform_memberships" USING "btree" ("user_id", "status");



CREATE INDEX "idx_project_vendors_company" ON "public"."project_vendors" USING "btree" ("company_id");



CREATE INDEX "idx_project_vendors_contact" ON "public"."project_vendors" USING "btree" ("contact_id");



CREATE INDEX "idx_project_vendors_project" ON "public"."project_vendors" USING "btree" ("project_id");



CREATE INDEX "idx_projects_client_id" ON "public"."projects" USING "btree" ("client_id");



CREATE INDEX "idx_projects_name_trgm" ON "public"."projects" USING "gin" ("name" "public"."gin_trgm_ops");



CREATE INDEX "idx_projects_org_updated_at" ON "public"."projects" USING "btree" ("org_id", "updated_at" DESC);



CREATE INDEX "idx_projects_search" ON "public"."projects" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((COALESCE("name", ''::"text") || ' '::"text") || COALESCE("description", ''::"text"))));



CREATE INDEX "idx_punch_items_search" ON "public"."punch_items" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((COALESCE("title", ''::"text") || ' '::"text") || COALESCE("description", ''::"text"))));



CREATE INDEX "idx_rfis_search" ON "public"."rfis" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((COALESCE("subject", ''::"text") || ' '::"text") || COALESCE("question", ''::"text"))));



CREATE INDEX "idx_schedule_items_cost_code_id" ON "public"."schedule_items" USING "btree" ("cost_code_id");



CREATE INDEX "idx_schedule_items_search" ON "public"."schedule_items" USING "gin" ("to_tsvector"('"english"'::"regconfig", COALESCE("name", ''::"text")));



CREATE UNIQUE INDEX "idx_search_documents_entity" ON "public"."search_documents" USING "btree" ("org_id", "entity_type", "entity_id");



CREATE INDEX "idx_search_documents_project_updated" ON "public"."search_documents" USING "btree" ("org_id", "project_id", "updated_at" DESC);



CREATE INDEX "idx_search_documents_vector" ON "public"."search_documents" USING "gin" ("search_vector");



CREATE UNIQUE INDEX "idx_search_embeddings_document_model" ON "public"."search_embeddings" USING "btree" ("document_id", "model");



CREATE INDEX "idx_search_embeddings_org_model" ON "public"."search_embeddings" USING "btree" ("org_id", "model", "updated_at" DESC);



CREATE INDEX "idx_search_embeddings_vector_cosine" ON "public"."search_embeddings" USING "ivfflat" ("embedding" "public"."vector_cosine_ops") WITH ("lists"='100');



CREATE INDEX "idx_submittals_search" ON "public"."submittals" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((COALESCE("title", ''::"text") || ' '::"text") || COALESCE("description", ''::"text"))));



CREATE INDEX "idx_tasks_search" ON "public"."tasks" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((COALESCE("title", ''::"text") || ' '::"text") || COALESCE("description", ''::"text"))));



CREATE INDEX "invoice_lines_cost_code_idx" ON "public"."invoice_lines" USING "btree" ("cost_code_id");



CREATE INDEX "invoice_lines_invoice_idx" ON "public"."invoice_lines" USING "btree" ("invoice_id");



CREATE INDEX "invoice_lines_org_idx" ON "public"."invoice_lines" USING "btree" ("org_id");



CREATE INDEX "invoice_views_invoice_idx" ON "public"."invoice_views" USING "btree" ("invoice_id");



CREATE INDEX "invoice_views_org_idx" ON "public"."invoice_views" USING "btree" ("org_id");



CREATE INDEX "invoice_views_viewed_at_idx" ON "public"."invoice_views" USING "btree" ("viewed_at");



CREATE INDEX "invoices_org_idx" ON "public"."invoices" USING "btree" ("org_id");



CREATE INDEX "invoices_project_idx" ON "public"."invoices" USING "btree" ("project_id");



CREATE INDEX "invoices_qbo_sync_idx" ON "public"."invoices" USING "btree" ("org_id", "qbo_sync_status") WHERE ("qbo_sync_status" IS NOT NULL);



CREATE INDEX "invoices_status_idx" ON "public"."invoices" USING "btree" ("status");



CREATE UNIQUE INDEX "invoices_token_key" ON "public"."invoices" USING "btree" ("token") WHERE ("token" IS NOT NULL);



CREATE INDEX "invoices_viewed_at_idx" ON "public"."invoices" USING "btree" ("viewed_at");



CREATE INDEX "late_fee_applications_invoice_idx" ON "public"."late_fee_applications" USING "btree" ("invoice_id");



CREATE INDEX "late_fee_applications_org_idx" ON "public"."late_fee_applications" USING "btree" ("org_id");



CREATE UNIQUE INDEX "late_fee_applications_unique_idx" ON "public"."late_fee_applications" USING "btree" ("invoice_id", "late_fee_rule_id", "application_number");



CREATE INDEX "late_fees_org_idx" ON "public"."late_fees" USING "btree" ("org_id");



CREATE INDEX "late_fees_project_idx" ON "public"."late_fees" USING "btree" ("project_id");



CREATE INDEX "lien_waivers_org_idx" ON "public"."lien_waivers" USING "btree" ("org_id");



CREATE INDEX "lien_waivers_payment_idx" ON "public"."lien_waivers" USING "btree" ("payment_id");



CREATE INDEX "lien_waivers_project_idx" ON "public"."lien_waivers" USING "btree" ("project_id");



CREATE INDEX "lien_waivers_status_idx" ON "public"."lien_waivers" USING "btree" ("status");



CREATE UNIQUE INDEX "lien_waivers_token_idx" ON "public"."lien_waivers" USING "btree" ("token_hash") WHERE ("token_hash" IS NOT NULL);



CREATE INDEX "markup_rules_contract_idx" ON "public"."markup_rules" USING "btree" ("contract_id");



CREATE INDEX "markup_rules_cost_code_idx" ON "public"."markup_rules" USING "btree" ("cost_code_id");



CREATE INDEX "markup_rules_org_idx" ON "public"."markup_rules" USING "btree" ("org_id");



CREATE INDEX "markup_rules_org_scope_dates_idx" ON "public"."markup_rules" USING "btree" ("org_id", "scope", "effective_from", "effective_to");



CREATE INDEX "memberships_org_created_at_idx" ON "public"."memberships" USING "btree" ("org_id", "created_at");



CREATE INDEX "memberships_org_status_idx" ON "public"."memberships" USING "btree" ("org_id", "status");



CREATE UNIQUE INDEX "memberships_org_user_idx" ON "public"."memberships" USING "btree" ("org_id", "user_id");



CREATE INDEX "mentions_org_idx" ON "public"."mentions" USING "btree" ("org_id");



CREATE INDEX "messages_conversation_idx" ON "public"."messages" USING "btree" ("conversation_id");



CREATE INDEX "messages_org_idx" ON "public"."messages" USING "btree" ("org_id");



CREATE INDEX "notification_deliveries_org_idx" ON "public"."notification_deliveries" USING "btree" ("org_id");



CREATE INDEX "notifications_org_idx" ON "public"."notifications" USING "btree" ("org_id");



CREATE INDEX "notifications_user_idx" ON "public"."notifications" USING "btree" ("user_id");



CREATE INDEX "opportunities_org_client_idx" ON "public"."opportunities" USING "btree" ("org_id", "client_contact_id");



CREATE INDEX "opportunities_org_owner_idx" ON "public"."opportunities" USING "btree" ("org_id", "owner_user_id");



CREATE INDEX "opportunities_org_status_idx" ON "public"."opportunities" USING "btree" ("org_id", "status");



CREATE INDEX "outbox_org_idx" ON "public"."outbox" USING "btree" ("org_id");



CREATE INDEX "payment_intents_connected_account_idx" ON "public"."payment_intents" USING "btree" ("connected_account_id");



CREATE UNIQUE INDEX "payment_intents_idempotency_idx" ON "public"."payment_intents" USING "btree" ("idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE INDEX "payment_intents_invoice_idx" ON "public"."payment_intents" USING "btree" ("invoice_id");



CREATE INDEX "payment_intents_org_idx" ON "public"."payment_intents" USING "btree" ("org_id");



CREATE UNIQUE INDEX "payment_intents_provider_intent_idx" ON "public"."payment_intents" USING "btree" ("provider_intent_id") WHERE ("provider_intent_id" IS NOT NULL);



CREATE INDEX "payment_intents_status_idx" ON "public"."payment_intents" USING "btree" ("status");



CREATE INDEX "payment_links_invoice_idx" ON "public"."payment_links" USING "btree" ("invoice_id");



CREATE INDEX "payment_links_org_idx" ON "public"."payment_links" USING "btree" ("org_id");



CREATE UNIQUE INDEX "payment_links_token_hash_idx" ON "public"."payment_links" USING "btree" ("token_hash");



CREATE INDEX "payment_methods_contact_idx" ON "public"."payment_methods" USING "btree" ("contact_id");



CREATE INDEX "payment_methods_org_idx" ON "public"."payment_methods" USING "btree" ("org_id");



CREATE UNIQUE INDEX "payment_methods_provider_method_idx" ON "public"."payment_methods" USING "btree" ("provider", "provider_method_id") WHERE ("provider_method_id" IS NOT NULL);



CREATE INDEX "payment_schedules_next_charge_idx" ON "public"."payment_schedules" USING "btree" ("next_charge_date") WHERE ("status" = 'active'::"text");



CREATE INDEX "payment_schedules_org_idx" ON "public"."payment_schedules" USING "btree" ("org_id");



CREATE INDEX "payments_connected_account_idx" ON "public"."payments" USING "btree" ("connected_account_id");



CREATE UNIQUE INDEX "payments_idempotency_idx" ON "public"."payments" USING "btree" ("idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE INDEX "payments_org_idx" ON "public"."payments" USING "btree" ("org_id");



CREATE INDEX "payments_project_idx" ON "public"."payments" USING "btree" ("project_id");



CREATE INDEX "payments_provider_idx" ON "public"."payments" USING "btree" ("provider_payment_id");



CREATE INDEX "payments_status_idx" ON "public"."payments" USING "btree" ("status");



CREATE INDEX "photos_org_idx" ON "public"."photos" USING "btree" ("org_id");



CREATE INDEX "photos_project_idx" ON "public"."photos" USING "btree" ("project_id");



CREATE INDEX "plans_stripe_price_id_idx" ON "public"."plans" USING "btree" ("stripe_price_id");



CREATE INDEX "portal_access_tokens_company_idx" ON "public"."portal_access_tokens" USING "btree" ("company_id") WHERE ("company_id" IS NOT NULL);



CREATE INDEX "portal_access_tokens_org_idx" ON "public"."portal_access_tokens" USING "btree" ("org_id");



CREATE INDEX "portal_access_tokens_paused_idx" ON "public"."portal_access_tokens" USING "btree" ("project_id", "paused_at") WHERE ("revoked_at" IS NULL);



CREATE INDEX "portal_access_tokens_portal_type_idx" ON "public"."portal_access_tokens" USING "btree" ("portal_type");



CREATE INDEX "portal_access_tokens_project_idx" ON "public"."portal_access_tokens" USING "btree" ("project_id");



CREATE INDEX "portal_access_tokens_token_idx" ON "public"."portal_access_tokens" USING "btree" ("token") WHERE ("revoked_at" IS NULL);



CREATE INDEX "project_cost_code_progress_org_idx" ON "public"."project_cost_code_progress" USING "btree" ("org_id");



CREATE INDEX "project_cost_code_progress_project_idx" ON "public"."project_cost_code_progress" USING "btree" ("project_id");



CREATE INDEX "project_expenses_date_idx" ON "public"."project_expenses" USING "btree" ("expense_date");



CREATE INDEX "project_expenses_org_idx" ON "public"."project_expenses" USING "btree" ("org_id");



CREATE INDEX "project_expenses_org_project_status_date_idx" ON "public"."project_expenses" USING "btree" ("org_id", "project_id", "status", "expense_date");



CREATE INDEX "project_expenses_project_idx" ON "public"."project_expenses" USING "btree" ("project_id");



CREATE INDEX "project_expenses_qbo_id_idx" ON "public"."project_expenses" USING "btree" ("org_id", "qbo_id") WHERE ("qbo_id" IS NOT NULL);



CREATE INDEX "project_expenses_qbo_sync_idx" ON "public"."project_expenses" USING "btree" ("org_id", "qbo_sync_status") WHERE ("qbo_sync_status" IS NOT NULL);



CREATE INDEX "project_expenses_status_idx" ON "public"."project_expenses" USING "btree" ("status");



CREATE INDEX "project_file_folder_permissions_org_project_idx" ON "public"."project_file_folder_permissions" USING "btree" ("org_id", "project_id");



CREATE UNIQUE INDEX "project_file_folder_permissions_unique_idx" ON "public"."project_file_folder_permissions" USING "btree" ("org_id", "project_id", "path");



CREATE INDEX "project_file_folders_org_project_idx" ON "public"."project_file_folders" USING "btree" ("org_id", "project_id");



CREATE UNIQUE INDEX "project_file_folders_unique_path_idx" ON "public"."project_file_folders" USING "btree" ("org_id", "project_id", "path");



CREATE INDEX "project_members_org_idx" ON "public"."project_members" USING "btree" ("org_id");



CREATE INDEX "project_members_org_user_idx" ON "public"."project_members" USING "btree" ("org_id", "user_id");



CREATE INDEX "project_selections_org_idx" ON "public"."project_selections" USING "btree" ("org_id");



CREATE INDEX "project_selections_project_idx" ON "public"."project_selections" USING "btree" ("project_id");



CREATE INDEX "projects_opportunity_id_idx" ON "public"."projects" USING "btree" ("opportunity_id");



CREATE UNIQUE INDEX "projects_opportunity_id_unique" ON "public"."projects" USING "btree" ("opportunity_id") WHERE ("opportunity_id" IS NOT NULL);



CREATE UNIQUE INDEX "projects_org_id_id_uidx" ON "public"."projects" USING "btree" ("org_id", "id");



CREATE INDEX "projects_org_idx" ON "public"."projects" USING "btree" ("org_id");



CREATE INDEX "proposal_lines_org_idx" ON "public"."proposal_lines" USING "btree" ("org_id");



CREATE INDEX "proposal_lines_proposal_idx" ON "public"."proposal_lines" USING "btree" ("proposal_id");



CREATE INDEX "proposals_opportunity_id_idx" ON "public"."proposals" USING "btree" ("opportunity_id");



CREATE INDEX "proposals_org_idx" ON "public"."proposals" USING "btree" ("org_id");



CREATE UNIQUE INDEX "proposals_org_number_idx" ON "public"."proposals" USING "btree" ("org_id", "number") WHERE ("number" IS NOT NULL);



CREATE INDEX "proposals_project_idx" ON "public"."proposals" USING "btree" ("project_id");



CREATE UNIQUE INDEX "proposals_token_hash_idx" ON "public"."proposals" USING "btree" ("token_hash") WHERE ("token_hash" IS NOT NULL);



CREATE INDEX "punch_items_org_idx" ON "public"."punch_items" USING "btree" ("org_id");



CREATE INDEX "punch_items_project_idx" ON "public"."punch_items" USING "btree" ("project_id");



CREATE INDEX "qbo_connections_expires_idx" ON "public"."qbo_connections" USING "btree" ("token_expires_at") WHERE ("status" = 'active'::"text");



CREATE UNIQUE INDEX "qbo_connections_org_active_idx" ON "public"."qbo_connections" USING "btree" ("org_id") WHERE ("status" = 'active'::"text");



CREATE INDEX "qbo_connections_refresh_expiry_idx" ON "public"."qbo_connections" USING "btree" ("status", "refresh_token_expires_at") WHERE ("status" = 'active'::"text");



CREATE UNIQUE INDEX "qbo_invoice_reservations_active_idx" ON "public"."qbo_invoice_reservations" USING "btree" ("org_id", "reserved_number") WHERE ("status" = 'reserved'::"text");



CREATE INDEX "qbo_invoice_reservations_expires_idx" ON "public"."qbo_invoice_reservations" USING "btree" ("expires_at") WHERE ("status" = 'reserved'::"text");



CREATE UNIQUE INDEX "qbo_sync_records_entity_idx" ON "public"."qbo_sync_records" USING "btree" ("org_id", "entity_type", "entity_id");



CREATE INDEX "qbo_sync_records_qbo_idx" ON "public"."qbo_sync_records" USING "btree" ("connection_id", "qbo_id");



CREATE INDEX "qbo_webhook_events_process_idx" ON "public"."qbo_webhook_events" USING "btree" ("process_status", "received_at" DESC);



CREATE INDEX "qbo_webhook_events_received_idx" ON "public"."qbo_webhook_events" USING "btree" ("received_at" DESC);



CREATE INDEX "receipts_org_idx" ON "public"."receipts" USING "btree" ("org_id");



CREATE INDEX "reminder_deliveries_invoice_idx" ON "public"."reminder_deliveries" USING "btree" ("invoice_id");



CREATE INDEX "reminder_deliveries_org_idx" ON "public"."reminder_deliveries" USING "btree" ("org_id");



CREATE UNIQUE INDEX "reminder_deliveries_unique_idx" ON "public"."reminder_deliveries" USING "btree" ("reminder_id", "invoice_id", "channel", "created_on");



CREATE INDEX "reminders_invoice_idx" ON "public"."reminders" USING "btree" ("invoice_id");



CREATE INDEX "reminders_org_idx" ON "public"."reminders" USING "btree" ("org_id");



CREATE INDEX "retainage_contract_idx" ON "public"."retainage" USING "btree" ("contract_id");



CREATE INDEX "retainage_org_idx" ON "public"."retainage" USING "btree" ("org_id");



CREATE INDEX "retainage_project_idx" ON "public"."retainage" USING "btree" ("project_id");



CREATE INDEX "retainage_status_idx" ON "public"."retainage" USING "btree" ("status");



CREATE INDEX "rfi_responses_rfi_idx" ON "public"."rfi_responses" USING "btree" ("rfi_id");



CREATE INDEX "rfis_assigned_company_idx" ON "public"."rfis" USING "btree" ("assigned_company_id");



CREATE INDEX "rfis_notify_contact_idx" ON "public"."rfis" USING "btree" ("notify_contact_id") WHERE ("notify_contact_id" IS NOT NULL);



CREATE INDEX "rfis_org_idx" ON "public"."rfis" USING "btree" ("org_id");



CREATE INDEX "rfis_project_idx" ON "public"."rfis" USING "btree" ("project_id");



CREATE INDEX "schedule_assignments_company_idx" ON "public"."schedule_assignments" USING "btree" ("company_id") WHERE ("company_id" IS NOT NULL);



CREATE INDEX "schedule_assignments_item_idx" ON "public"."schedule_assignments" USING "btree" ("schedule_item_id");



CREATE INDEX "schedule_assignments_org_idx" ON "public"."schedule_assignments" USING "btree" ("org_id");



CREATE INDEX "schedule_assignments_project_idx" ON "public"."schedule_assignments" USING "btree" ("project_id");



CREATE INDEX "schedule_assignments_user_idx" ON "public"."schedule_assignments" USING "btree" ("user_id") WHERE ("user_id" IS NOT NULL);



CREATE UNIQUE INDEX "schedule_baselines_active_idx" ON "public"."schedule_baselines" USING "btree" ("project_id") WHERE ("is_active" = true);



CREATE INDEX "schedule_baselines_org_idx" ON "public"."schedule_baselines" USING "btree" ("org_id");



CREATE INDEX "schedule_baselines_project_idx" ON "public"."schedule_baselines" USING "btree" ("project_id");



CREATE INDEX "schedule_dependencies_org_idx" ON "public"."schedule_dependencies" USING "btree" ("org_id");



CREATE INDEX "schedule_dependencies_project_idx" ON "public"."schedule_dependencies" USING "btree" ("project_id");



CREATE INDEX "schedule_items_org_idx" ON "public"."schedule_items" USING "btree" ("org_id");



CREATE INDEX "schedule_items_project_idx" ON "public"."schedule_items" USING "btree" ("project_id");



CREATE INDEX "schedule_templates_org_idx" ON "public"."schedule_templates" USING "btree" ("org_id");



CREATE INDEX "selection_categories_org_idx" ON "public"."selection_categories" USING "btree" ("org_id");



CREATE INDEX "selection_options_category_idx" ON "public"."selection_options" USING "btree" ("category_id");



CREATE INDEX "selection_options_org_idx" ON "public"."selection_options" USING "btree" ("org_id");



CREATE UNIQUE INDEX "stripe_connected_accounts_account_idx" ON "public"."stripe_connected_accounts" USING "btree" ("stripe_account_id");



CREATE UNIQUE INDEX "stripe_connected_accounts_org_idx" ON "public"."stripe_connected_accounts" USING "btree" ("org_id");



CREATE INDEX "stripe_connected_accounts_status_idx" ON "public"."stripe_connected_accounts" USING "btree" ("org_id", "status");



CREATE INDEX "submittal_items_submittal_idx" ON "public"."submittal_items" USING "btree" ("submittal_id");



CREATE INDEX "submittals_assigned_company_idx" ON "public"."submittals" USING "btree" ("assigned_company_id");



CREATE INDEX "submittals_org_idx" ON "public"."submittals" USING "btree" ("org_id");



CREATE INDEX "submittals_project_idx" ON "public"."submittals" USING "btree" ("project_id");



CREATE INDEX "subscriptions_external_customer_id_idx" ON "public"."subscriptions" USING "btree" ("external_customer_id") WHERE ("external_customer_id" IS NOT NULL);



CREATE UNIQUE INDEX "subscriptions_external_subscription_id_key" ON "public"."subscriptions" USING "btree" ("external_subscription_id") WHERE ("external_subscription_id" IS NOT NULL);



CREATE UNIQUE INDEX "subscriptions_org_active_idx" ON "public"."subscriptions" USING "btree" ("org_id") WHERE ("status" = 'active'::"public"."subscription_status");



CREATE UNIQUE INDEX "task_assignments_contact_unique" ON "public"."task_assignments" USING "btree" ("task_id", "contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE INDEX "task_assignments_org_idx" ON "public"."task_assignments" USING "btree" ("org_id");



CREATE UNIQUE INDEX "task_assignments_user_unique" ON "public"."task_assignments" USING "btree" ("task_id", "user_id") WHERE ("user_id" IS NOT NULL);



CREATE INDEX "tasks_org_idx" ON "public"."tasks" USING "btree" ("org_id");



CREATE INDEX "tasks_project_idx" ON "public"."tasks" USING "btree" ("project_id");



CREATE INDEX "time_entries_approval_token_hash_idx" ON "public"."time_entries" USING "btree" ("approval_token_hash") WHERE ("approval_token_hash" IS NOT NULL);



CREATE INDEX "time_entries_org_idx" ON "public"."time_entries" USING "btree" ("org_id");



CREATE INDEX "time_entries_org_project_status_date_idx" ON "public"."time_entries" USING "btree" ("org_id", "project_id", "status", "work_date");



CREATE INDEX "time_entries_project_idx" ON "public"."time_entries" USING "btree" ("project_id");



CREATE INDEX "time_entries_status_idx" ON "public"."time_entries" USING "btree" ("status");



CREATE INDEX "time_entries_work_date_idx" ON "public"."time_entries" USING "btree" ("work_date");



CREATE UNIQUE INDEX "user_notification_prefs_user_org_idx" ON "public"."user_notification_prefs" USING "btree" ("user_id", "org_id");



CREATE INDEX "variance_alerts_org_idx" ON "public"."variance_alerts" USING "btree" ("org_id");



CREATE INDEX "variance_alerts_project_idx" ON "public"."variance_alerts" USING "btree" ("project_id");



CREATE INDEX "variance_alerts_status_idx" ON "public"."variance_alerts" USING "btree" ("status") WHERE ("status" = 'active'::"text");



CREATE INDEX "vendor_bills_approved_at_idx" ON "public"."vendor_bills" USING "btree" ("org_id", "approved_at");



CREATE INDEX "vendor_bills_org_idx" ON "public"."vendor_bills" USING "btree" ("org_id");



CREATE INDEX "vendor_bills_org_status_paid_idx" ON "public"."vendor_bills" USING "btree" ("org_id", "status", "paid_cents");



CREATE INDEX "vendor_bills_paid_at_idx" ON "public"."vendor_bills" USING "btree" ("org_id", "paid_at");



CREATE INDEX "vendor_bills_project_idx" ON "public"."vendor_bills" USING "btree" ("project_id");



CREATE INDEX "vendor_bills_qbo_id_idx" ON "public"."vendor_bills" USING "btree" ("org_id", "qbo_id") WHERE ("qbo_id" IS NOT NULL);



CREATE INDEX "vendor_bills_qbo_sync_idx" ON "public"."vendor_bills" USING "btree" ("org_id", "qbo_sync_status") WHERE ("qbo_sync_status" IS NOT NULL);



CREATE INDEX "warranty_requests_org_project_idx" ON "public"."warranty_requests" USING "btree" ("org_id", "project_id", "status");



CREATE INDEX "webhook_events_org_idx" ON "public"."webhook_events" USING "btree" ("org_id", "created_at" DESC);



CREATE UNIQUE INDEX "webhook_events_provider_event_idx" ON "public"."webhook_events" USING "btree" ("provider", "provider_event_id");



CREATE INDEX "workflow_runs_org_idx" ON "public"."workflow_runs" USING "btree" ("org_id");



CREATE INDEX "workflow_runs_workflow_idx" ON "public"."workflow_runs" USING "btree" ("workflow_id");



CREATE INDEX "workflows_org_idx" ON "public"."workflows" USING "btree" ("org_id");



CREATE OR REPLACE TRIGGER "ai_search_action_requests_set_updated_at" BEFORE UPDATE ON "public"."ai_search_action_requests" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "ai_search_sessions_set_updated_at" BEFORE UPDATE ON "public"."ai_search_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "allowances_set_updated_at" BEFORE UPDATE ON "public"."allowances" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "app_users_set_updated_at" BEFORE UPDATE ON "public"."app_users" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "approvals_set_updated_at" BEFORE UPDATE ON "public"."approvals" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "billable_costs_set_updated_at" BEFORE UPDATE ON "public"."billable_costs" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "budget_revisions_updated_at" BEFORE UPDATE ON "public"."budget_revisions" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "budgets_set_updated_at" BEFORE UPDATE ON "public"."budgets" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "change_orders_set_updated_at" BEFORE UPDATE ON "public"."change_orders" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "change_requests_set_updated_at" BEFORE UPDATE ON "public"."change_requests" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "commitments_set_updated_at" BEFORE UPDATE ON "public"."commitments" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "companies_set_updated_at" BEFORE UPDATE ON "public"."companies" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "contacts_set_updated_at" BEFORE UPDATE ON "public"."contacts" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "contracts_set_updated_at" BEFORE UPDATE ON "public"."contracts" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "conversation_read_states_set_updated_at" BEFORE UPDATE ON "public"."conversation_read_states" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "conversion_run_steps_set_updated_at" BEFORE UPDATE ON "public"."conversion_run_steps" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "conversion_runs_set_updated_at" BEFORE UPDATE ON "public"."conversion_runs" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "cost_approval_batches_set_updated_at" BEFORE UPDATE ON "public"."cost_approval_batches" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "cost_codes_set_updated_at" BEFORE UPDATE ON "public"."cost_codes" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "custom_field_values_set_updated_at" BEFORE UPDATE ON "public"."custom_field_values" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "custom_fields_set_updated_at" BEFORE UPDATE ON "public"."custom_fields" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "daily_logs_set_updated_at" BEFORE UPDATE ON "public"."daily_logs" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "documents_set_updated_at" BEFORE UPDATE ON "public"."documents" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "documents_sync_source_entity_from_metadata" BEFORE INSERT OR UPDATE OF "metadata", "source_entity_type", "source_entity_id" ON "public"."documents" FOR EACH ROW EXECUTE FUNCTION "public"."tg_documents_sync_source_entity_from_metadata"();



CREATE OR REPLACE TRIGGER "draw_schedules_set_updated_at" BEFORE UPDATE ON "public"."draw_schedules" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "drawing_markups_updated_at" BEFORE UPDATE ON "public"."drawing_markups" FOR EACH ROW EXECUTE FUNCTION "public"."update_drawing_markups_updated_at"();



CREATE OR REPLACE TRIGGER "drawing_pins_updated_at" BEFORE UPDATE ON "public"."drawing_pins" FOR EACH ROW EXECUTE FUNCTION "public"."update_drawing_pins_updated_at"();



CREATE OR REPLACE TRIGGER "drawing_sets_updated_at" BEFORE UPDATE ON "public"."drawing_sets" FOR EACH ROW EXECUTE FUNCTION "public"."update_drawing_sets_updated_at"();



CREATE OR REPLACE TRIGGER "drawing_sheets_updated_at" BEFORE UPDATE ON "public"."drawing_sheets" FOR EACH ROW EXECUTE FUNCTION "public"."update_drawing_sheets_updated_at"();



CREATE OR REPLACE TRIGGER "envelopes_set_updated_at" BEFORE UPDATE ON "public"."envelopes" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "estimate_templates_set_updated_at" BEFORE UPDATE ON "public"."estimate_templates" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "estimates_set_updated_at" BEFORE UPDATE ON "public"."estimates" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "feature_flags_set_updated_at" BEFORE UPDATE ON "public"."feature_flags" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "files_set_updated_at" BEFORE UPDATE ON "public"."files" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "form_instances_set_updated_at" BEFORE UPDATE ON "public"."form_instances" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "form_templates_set_updated_at" BEFORE UPDATE ON "public"."form_templates" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "invoices_set_updated_at" BEFORE UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "late_fees_set_updated_at" BEFORE UPDATE ON "public"."late_fees" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "licenses_set_updated_at" BEFORE UPDATE ON "public"."licenses" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "lien_waivers_set_updated_at" BEFORE UPDATE ON "public"."lien_waivers" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "markup_rules_set_updated_at" BEFORE UPDATE ON "public"."markup_rules" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "membership_permission_overrides_set_updated_at" BEFORE UPDATE ON "public"."membership_permission_overrides" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "memberships_set_updated_at" BEFORE UPDATE ON "public"."memberships" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "messages_update_conversation_last_message" AFTER INSERT ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."update_conversation_last_message_at"();



CREATE OR REPLACE TRIGGER "org_settings_set_updated_at" BEFORE UPDATE ON "public"."org_settings" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "orgs_set_updated_at" BEFORE UPDATE ON "public"."orgs" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "outbox_set_updated_at" BEFORE UPDATE ON "public"."outbox" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "payment_intents_set_updated_at" BEFORE UPDATE ON "public"."payment_intents" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "payment_links_set_updated_at" BEFORE UPDATE ON "public"."payment_links" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "payment_methods_set_updated_at" BEFORE UPDATE ON "public"."payment_methods" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "payment_schedules_set_updated_at" BEFORE UPDATE ON "public"."payment_schedules" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "payments_set_updated_at" BEFORE UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "platform_memberships_set_updated_at" BEFORE UPDATE ON "public"."platform_memberships" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "platform_settings_set_updated_at" BEFORE UPDATE ON "public"."platform_settings" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "project_cost_code_progress_updated_at" BEFORE UPDATE ON "public"."project_cost_code_progress" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "project_expenses_set_updated_at" BEFORE UPDATE ON "public"."project_expenses" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "project_file_folder_permissions_set_updated_at" BEFORE UPDATE ON "public"."project_file_folder_permissions" FOR EACH ROW EXECUTE FUNCTION "public"."set_project_file_folder_permissions_updated_at"();



CREATE OR REPLACE TRIGGER "project_members_set_updated_at" BEFORE UPDATE ON "public"."project_members" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "project_selections_set_updated_at" BEFORE UPDATE ON "public"."project_selections" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "project_settings_set_updated_at" BEFORE UPDATE ON "public"."project_settings" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "projects_set_updated_at" BEFORE UPDATE ON "public"."projects" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "proposals_set_updated_at" BEFORE UPDATE ON "public"."proposals" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "punch_items_set_updated_at" BEFORE UPDATE ON "public"."punch_items" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "qbo_connections_set_updated_at" BEFORE UPDATE ON "public"."qbo_connections" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "reminders_set_updated_at" BEFORE UPDATE ON "public"."reminders" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "retainage_set_updated_at" BEFORE UPDATE ON "public"."retainage" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "rfis_set_updated_at" BEFORE UPDATE ON "public"."rfis" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "roles_set_updated_at" BEFORE UPDATE ON "public"."roles" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "schedule_assignments_set_updated_at" BEFORE UPDATE ON "public"."schedule_assignments" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "schedule_items_set_updated_at" BEFORE UPDATE ON "public"."schedule_items" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "schedule_templates_set_updated_at" BEFORE UPDATE ON "public"."schedule_templates" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "search_documents_set_updated_at" BEFORE UPDATE ON "public"."search_documents" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "search_embeddings_set_updated_at" BEFORE UPDATE ON "public"."search_embeddings" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "seed_compliance_doc_types_on_org_create" AFTER INSERT ON "public"."orgs" FOR EACH ROW EXECUTE FUNCTION "public"."seed_compliance_document_types"();



CREATE OR REPLACE TRIGGER "selection_categories_set_updated_at" BEFORE UPDATE ON "public"."selection_categories" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "selection_options_set_updated_at" BEFORE UPDATE ON "public"."selection_options" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "stripe_connected_accounts_set_updated_at" BEFORE UPDATE ON "public"."stripe_connected_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "submittals_set_updated_at" BEFORE UPDATE ON "public"."submittals" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "subscriptions_set_updated_at" BEFORE UPDATE ON "public"."subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "support_contracts_set_updated_at" BEFORE UPDATE ON "public"."support_contracts" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "tasks_set_updated_at" BEFORE UPDATE ON "public"."tasks" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "tg_document_packets_set_updated_at" BEFORE UPDATE ON "public"."document_packets" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "time_entries_set_updated_at" BEFORE UPDATE ON "public"."time_entries" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_budget_line_lock_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."budget_lines" FOR EACH ROW EXECUTE FUNCTION "public"."budget_line_lock_guard"();



CREATE OR REPLACE TRIGGER "trg_budget_lock_guard" BEFORE UPDATE ON "public"."budgets" FOR EACH ROW EXECUTE FUNCTION "public"."budget_lock_guard"();



CREATE OR REPLACE TRIGGER "trg_platform_memberships_role_scope" BEFORE INSERT OR UPDATE ON "public"."platform_memberships" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_platform_membership_role_scope"();



CREATE OR REPLACE TRIGGER "vendor_bills_set_updated_at" BEFORE UPDATE ON "public"."vendor_bills" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "workflows_set_updated_at" BEFORE UPDATE ON "public"."workflows" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



ALTER TABLE ONLY "public"."ai_search_action_requests"
    ADD CONSTRAINT "ai_search_action_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_search_action_requests"
    ADD CONSTRAINT "ai_search_action_requests_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."ai_search_sessions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_search_action_requests"
    ADD CONSTRAINT "ai_search_action_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_search_artifacts"
    ADD CONSTRAINT "ai_search_artifacts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."ai_search_artifacts"
    ADD CONSTRAINT "ai_search_artifacts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_search_events"
    ADD CONSTRAINT "ai_search_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_search_events"
    ADD CONSTRAINT "ai_search_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."ai_search_sessions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_search_events"
    ADD CONSTRAINT "ai_search_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_search_messages"
    ADD CONSTRAINT "ai_search_messages_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_search_messages"
    ADD CONSTRAINT "ai_search_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."ai_search_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_search_messages"
    ADD CONSTRAINT "ai_search_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_search_sessions"
    ADD CONSTRAINT "ai_search_sessions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_search_sessions"
    ADD CONSTRAINT "ai_search_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."allowances"
    ADD CONSTRAINT "allowances_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."allowances"
    ADD CONSTRAINT "allowances_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."allowances"
    ADD CONSTRAINT "allowances_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."app_users"
    ADD CONSTRAINT "app_users_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."approvals"
    ADD CONSTRAINT "approvals_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."approvals"
    ADD CONSTRAINT "approvals_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."approvals"
    ADD CONSTRAINT "approvals_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."arc_bid_benchmark_facts"
    ADD CONSTRAINT "arc_bid_benchmark_facts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."arc_bid_benchmark_facts"
    ADD CONSTRAINT "arc_bid_benchmark_invite_org_fk" FOREIGN KEY ("org_id", "bid_invite_id") REFERENCES "public"."bid_invites"("org_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."arc_bid_benchmark_facts"
    ADD CONSTRAINT "arc_bid_benchmark_package_org_fk" FOREIGN KEY ("org_id", "bid_package_id") REFERENCES "public"."bid_packages"("org_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."arc_bid_benchmark_facts"
    ADD CONSTRAINT "arc_bid_benchmark_project_org_fk" FOREIGN KEY ("org_id", "project_id") REFERENCES "public"."projects"("org_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."arc_bid_benchmark_facts"
    ADD CONSTRAINT "arc_bid_benchmark_submission_org_fk" FOREIGN KEY ("org_id", "bid_submission_id") REFERENCES "public"."bid_submissions"("org_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."authorization_audit_log"
    ADD CONSTRAINT "authorization_audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."authorization_audit_log"
    ADD CONSTRAINT "authorization_audit_log_impersonation_session_id_fkey" FOREIGN KEY ("impersonation_session_id") REFERENCES "public"."impersonation_sessions"("id");



ALTER TABLE ONLY "public"."authorization_audit_log"
    ADD CONSTRAINT "authorization_audit_log_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id");



ALTER TABLE ONLY "public"."authorization_audit_log"
    ADD CONSTRAINT "authorization_audit_log_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");



ALTER TABLE ONLY "public"."bid_access_tokens"
    ADD CONSTRAINT "bid_access_tokens_bid_invite_id_fkey" FOREIGN KEY ("bid_invite_id") REFERENCES "public"."bid_invites"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_access_tokens"
    ADD CONSTRAINT "bid_access_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bid_access_tokens"
    ADD CONSTRAINT "bid_access_tokens_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_access_tokens"
    ADD CONSTRAINT "bid_access_tokens_org_invite_fk" FOREIGN KEY ("org_id", "bid_invite_id") REFERENCES "public"."bid_invites"("org_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_addenda"
    ADD CONSTRAINT "bid_addenda_bid_package_id_fkey" FOREIGN KEY ("bid_package_id") REFERENCES "public"."bid_packages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_addenda"
    ADD CONSTRAINT "bid_addenda_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bid_addenda"
    ADD CONSTRAINT "bid_addenda_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_addenda"
    ADD CONSTRAINT "bid_addenda_org_package_fk" FOREIGN KEY ("org_id", "bid_package_id") REFERENCES "public"."bid_packages"("org_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_addendum_acknowledgements"
    ADD CONSTRAINT "bid_addendum_ack_org_addendum_fk" FOREIGN KEY ("org_id", "bid_addendum_id") REFERENCES "public"."bid_addenda"("org_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_addendum_acknowledgements"
    ADD CONSTRAINT "bid_addendum_ack_org_invite_fk" FOREIGN KEY ("org_id", "bid_invite_id") REFERENCES "public"."bid_invites"("org_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_addendum_acknowledgements"
    ADD CONSTRAINT "bid_addendum_acknowledgements_bid_addendum_id_fkey" FOREIGN KEY ("bid_addendum_id") REFERENCES "public"."bid_addenda"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_addendum_acknowledgements"
    ADD CONSTRAINT "bid_addendum_acknowledgements_bid_invite_id_fkey" FOREIGN KEY ("bid_invite_id") REFERENCES "public"."bid_invites"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_addendum_acknowledgements"
    ADD CONSTRAINT "bid_addendum_acknowledgements_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_awards"
    ADD CONSTRAINT "bid_awards_awarded_by_fkey" FOREIGN KEY ("awarded_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bid_awards"
    ADD CONSTRAINT "bid_awards_awarded_commitment_id_fkey" FOREIGN KEY ("awarded_commitment_id") REFERENCES "public"."commitments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bid_awards"
    ADD CONSTRAINT "bid_awards_awarded_submission_id_fkey" FOREIGN KEY ("awarded_submission_id") REFERENCES "public"."bid_submissions"("id");



ALTER TABLE ONLY "public"."bid_awards"
    ADD CONSTRAINT "bid_awards_bid_package_id_fkey" FOREIGN KEY ("bid_package_id") REFERENCES "public"."bid_packages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_awards"
    ADD CONSTRAINT "bid_awards_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_awards"
    ADD CONSTRAINT "bid_awards_org_package_fk" FOREIGN KEY ("org_id", "bid_package_id") REFERENCES "public"."bid_packages"("org_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_awards"
    ADD CONSTRAINT "bid_awards_org_submission_fk" FOREIGN KEY ("org_id", "awarded_submission_id") REFERENCES "public"."bid_submissions"("org_id", "id");



ALTER TABLE ONLY "public"."bid_invites"
    ADD CONSTRAINT "bid_invites_bid_package_id_fkey" FOREIGN KEY ("bid_package_id") REFERENCES "public"."bid_packages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_invites"
    ADD CONSTRAINT "bid_invites_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_invites"
    ADD CONSTRAINT "bid_invites_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bid_invites"
    ADD CONSTRAINT "bid_invites_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bid_invites"
    ADD CONSTRAINT "bid_invites_org_company_fk" FOREIGN KEY ("org_id", "company_id") REFERENCES "public"."companies"("org_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_invites"
    ADD CONSTRAINT "bid_invites_org_contact_fk" FOREIGN KEY ("org_id", "contact_id") REFERENCES "public"."contacts"("org_id", "id");



ALTER TABLE ONLY "public"."bid_invites"
    ADD CONSTRAINT "bid_invites_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_invites"
    ADD CONSTRAINT "bid_invites_org_package_fk" FOREIGN KEY ("org_id", "bid_package_id") REFERENCES "public"."bid_packages"("org_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_packages"
    ADD CONSTRAINT "bid_packages_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bid_packages"
    ADD CONSTRAINT "bid_packages_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bid_packages"
    ADD CONSTRAINT "bid_packages_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_packages"
    ADD CONSTRAINT "bid_packages_org_project_fk" FOREIGN KEY ("org_id", "project_id") REFERENCES "public"."projects"("org_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_packages"
    ADD CONSTRAINT "bid_packages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_submissions"
    ADD CONSTRAINT "bid_submissions_bid_invite_id_fkey" FOREIGN KEY ("bid_invite_id") REFERENCES "public"."bid_invites"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_submissions"
    ADD CONSTRAINT "bid_submissions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_submissions"
    ADD CONSTRAINT "bid_submissions_org_invite_fk" FOREIGN KEY ("org_id", "bid_invite_id") REFERENCES "public"."bid_invites"("org_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bill_lines"
    ADD CONSTRAINT "bill_lines_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "public"."vendor_bills"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bill_lines"
    ADD CONSTRAINT "bill_lines_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bill_lines"
    ADD CONSTRAINT "bill_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."billable_costs"
    ADD CONSTRAINT "billable_costs_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."billable_costs"
    ADD CONSTRAINT "billable_costs_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."billable_costs"
    ADD CONSTRAINT "billable_costs_invoice_line_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."billable_costs"
    ADD CONSTRAINT "billable_costs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."billable_costs"
    ADD CONSTRAINT "billable_costs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."billable_costs"
    ADD CONSTRAINT "billable_costs_source_company_id_fkey" FOREIGN KEY ("source_company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."budget_lines"
    ADD CONSTRAINT "budget_lines_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budget_lines"
    ADD CONSTRAINT "budget_lines_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."budget_lines"
    ADD CONSTRAINT "budget_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budget_revision_lines"
    ADD CONSTRAINT "budget_revision_lines_budget_revision_id_fkey" FOREIGN KEY ("budget_revision_id") REFERENCES "public"."budget_revisions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budget_revision_lines"
    ADD CONSTRAINT "budget_revision_lines_change_order_line_id_fkey" FOREIGN KEY ("change_order_line_id") REFERENCES "public"."change_order_lines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."budget_revision_lines"
    ADD CONSTRAINT "budget_revision_lines_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."budget_revision_lines"
    ADD CONSTRAINT "budget_revision_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budget_revisions"
    ADD CONSTRAINT "budget_revisions_change_order_id_fkey" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."budget_revisions"
    ADD CONSTRAINT "budget_revisions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budget_revisions"
    ADD CONSTRAINT "budget_revisions_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."budget_revisions"
    ADD CONSTRAINT "budget_revisions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budget_snapshots"
    ADD CONSTRAINT "budget_snapshots_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budget_snapshots"
    ADD CONSTRAINT "budget_snapshots_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budget_snapshots"
    ADD CONSTRAINT "budget_snapshots_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."change_order_lines"
    ADD CONSTRAINT "change_order_lines_change_order_id_fkey" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."change_order_lines"
    ADD CONSTRAINT "change_order_lines_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."change_order_lines"
    ADD CONSTRAINT "change_order_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."change_orders"
    ADD CONSTRAINT "change_orders_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."change_orders"
    ADD CONSTRAINT "change_orders_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."change_orders"
    ADD CONSTRAINT "change_orders_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."change_orders"
    ADD CONSTRAINT "change_orders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."change_orders"
    ADD CONSTRAINT "change_orders_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."change_requests"
    ADD CONSTRAINT "change_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."change_requests"
    ADD CONSTRAINT "change_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."closeout_items"
    ADD CONSTRAINT "closeout_items_closeout_package_id_fkey" FOREIGN KEY ("closeout_package_id") REFERENCES "public"."closeout_packages"("id");



ALTER TABLE ONLY "public"."closeout_items"
    ADD CONSTRAINT "closeout_items_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id");



ALTER TABLE ONLY "public"."closeout_items"
    ADD CONSTRAINT "closeout_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id");



ALTER TABLE ONLY "public"."closeout_items"
    ADD CONSTRAINT "closeout_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");



ALTER TABLE ONLY "public"."closeout_packages"
    ADD CONSTRAINT "closeout_packages_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id");



ALTER TABLE ONLY "public"."closeout_packages"
    ADD CONSTRAINT "closeout_packages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");



ALTER TABLE ONLY "public"."commitment_lines"
    ADD CONSTRAINT "commitment_lines_commitment_id_fkey" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."commitment_lines"
    ADD CONSTRAINT "commitment_lines_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."commitment_lines"
    ADD CONSTRAINT "commitment_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."commitments"
    ADD CONSTRAINT "commitments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."commitments"
    ADD CONSTRAINT "commitments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."commitments"
    ADD CONSTRAINT "commitments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."company_compliance_requirements"
    ADD CONSTRAINT "company_compliance_requirements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."company_compliance_requirements"
    ADD CONSTRAINT "company_compliance_requirements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."company_compliance_requirements"
    ADD CONSTRAINT "company_compliance_requirements_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "public"."compliance_document_types"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."company_compliance_requirements"
    ADD CONSTRAINT "company_compliance_requirements_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."compliance_document_types"
    ADD CONSTRAINT "compliance_document_types_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."compliance_documents"
    ADD CONSTRAINT "compliance_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."compliance_documents"
    ADD CONSTRAINT "compliance_documents_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "public"."compliance_document_types"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."compliance_documents"
    ADD CONSTRAINT "compliance_documents_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."compliance_documents"
    ADD CONSTRAINT "compliance_documents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."compliance_documents"
    ADD CONSTRAINT "compliance_documents_portal_token_id_fkey" FOREIGN KEY ("portal_token_id") REFERENCES "public"."portal_access_tokens"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."compliance_documents"
    ADD CONSTRAINT "compliance_documents_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "public"."company_compliance_requirements"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."compliance_documents"
    ADD CONSTRAINT "compliance_documents_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."contact_company_links"
    ADD CONSTRAINT "contact_company_links_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_company_links"
    ADD CONSTRAINT "contact_company_links_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_company_links"
    ADD CONSTRAINT "contact_company_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_primary_company_id_fkey" FOREIGN KEY ("primary_company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."conversation_read_states"
    ADD CONSTRAINT "conversation_read_states_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversation_read_states"
    ADD CONSTRAINT "conversation_read_states_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversation_read_states"
    ADD CONSTRAINT "conversation_read_states_last_read_message_id_fkey" FOREIGN KEY ("last_read_message_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."conversation_read_states"
    ADD CONSTRAINT "conversation_read_states_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversation_read_states"
    ADD CONSTRAINT "conversation_read_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_audience_company_id_fkey" FOREIGN KEY ("audience_company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_audience_contact_id_fkey" FOREIGN KEY ("audience_contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."conversion_run_steps"
    ADD CONSTRAINT "conversion_run_steps_conversion_run_id_fkey" FOREIGN KEY ("conversion_run_id") REFERENCES "public"."conversion_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversion_run_steps"
    ADD CONSTRAINT "conversion_run_steps_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversion_runs"
    ADD CONSTRAINT "conversion_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversion_runs"
    ADD CONSTRAINT "conversion_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."conversion_runs"
    ADD CONSTRAINT "conversion_runs_triggered_by_fkey" FOREIGN KEY ("triggered_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cost_approval_batches"
    ADD CONSTRAINT "cost_approval_batches_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cost_approval_batches"
    ADD CONSTRAINT "cost_approval_batches_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cost_codes"
    ADD CONSTRAINT "cost_codes_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cost_codes"
    ADD CONSTRAINT "cost_codes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."custom_field_values"
    ADD CONSTRAINT "custom_field_values_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "public"."custom_fields"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_field_values"
    ADD CONSTRAINT "custom_field_values_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_field_values"
    ADD CONSTRAINT "custom_field_values_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."custom_fields"
    ADD CONSTRAINT "custom_fields_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."daily_log_entries"
    ADD CONSTRAINT "daily_log_entries_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."daily_log_entries"
    ADD CONSTRAINT "daily_log_entries_daily_log_id_fkey" FOREIGN KEY ("daily_log_id") REFERENCES "public"."daily_logs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."daily_log_entries"
    ADD CONSTRAINT "daily_log_entries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."daily_log_entries"
    ADD CONSTRAINT "daily_log_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."daily_log_entries"
    ADD CONSTRAINT "daily_log_entries_punch_item_id_fkey" FOREIGN KEY ("punch_item_id") REFERENCES "public"."punch_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."daily_log_entries"
    ADD CONSTRAINT "daily_log_entries_schedule_item_id_fkey" FOREIGN KEY ("schedule_item_id") REFERENCES "public"."schedule_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."daily_log_entries"
    ADD CONSTRAINT "daily_log_entries_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."daily_logs"
    ADD CONSTRAINT "daily_logs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."daily_logs"
    ADD CONSTRAINT "daily_logs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."daily_logs"
    ADD CONSTRAINT "daily_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."decisions"
    ADD CONSTRAINT "decisions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."decisions"
    ADD CONSTRAINT "decisions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id");



ALTER TABLE ONLY "public"."decisions"
    ADD CONSTRAINT "decisions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");



ALTER TABLE ONLY "public"."doc_versions"
    ADD CONSTRAINT "doc_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."doc_versions"
    ADD CONSTRAINT "doc_versions_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."doc_versions"
    ADD CONSTRAINT "doc_versions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_fields"
    ADD CONSTRAINT "document_fields_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_fields"
    ADD CONSTRAINT "document_fields_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_packet_items"
    ADD CONSTRAINT "document_packet_items_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_packet_items"
    ADD CONSTRAINT "document_packet_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_packet_items"
    ADD CONSTRAINT "document_packet_items_packet_id_fkey" FOREIGN KEY ("packet_id") REFERENCES "public"."document_packets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_packets"
    ADD CONSTRAINT "document_packets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."document_packets"
    ADD CONSTRAINT "document_packets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_packets"
    ADD CONSTRAINT "document_packets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_signatures"
    ADD CONSTRAINT "document_signatures_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_signatures"
    ADD CONSTRAINT "document_signatures_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_signatures"
    ADD CONSTRAINT "document_signatures_signing_request_id_fkey" FOREIGN KEY ("signing_request_id") REFERENCES "public"."document_signing_requests"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_signing_requests"
    ADD CONSTRAINT "document_signing_requests_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."document_signing_requests"
    ADD CONSTRAINT "document_signing_requests_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_signing_requests"
    ADD CONSTRAINT "document_signing_requests_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_signing_requests"
    ADD CONSTRAINT "document_signing_requests_envelope_recipient_id_fkey" FOREIGN KEY ("envelope_recipient_id") REFERENCES "public"."envelope_recipients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."document_signing_requests"
    ADD CONSTRAINT "document_signing_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_signing_requests"
    ADD CONSTRAINT "document_signing_requests_recipient_contact_id_fkey" FOREIGN KEY ("recipient_contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_executed_file_id_fkey" FOREIGN KEY ("executed_file_id") REFERENCES "public"."files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_source_file_id_fkey" FOREIGN KEY ("source_file_id") REFERENCES "public"."files"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."draw_schedules"
    ADD CONSTRAINT "draw_schedules_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."draw_schedules"
    ADD CONSTRAINT "draw_schedules_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."draw_schedules"
    ADD CONSTRAINT "draw_schedules_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "public"."schedule_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."draw_schedules"
    ADD CONSTRAINT "draw_schedules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."draw_schedules"
    ADD CONSTRAINT "draw_schedules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_markups"
    ADD CONSTRAINT "drawing_markups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."drawing_markups"
    ADD CONSTRAINT "drawing_markups_drawing_sheet_id_fkey" FOREIGN KEY ("drawing_sheet_id") REFERENCES "public"."drawing_sheets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_markups"
    ADD CONSTRAINT "drawing_markups_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_markups"
    ADD CONSTRAINT "drawing_markups_sheet_version_id_fkey" FOREIGN KEY ("sheet_version_id") REFERENCES "public"."drawing_sheet_versions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."drawing_pins"
    ADD CONSTRAINT "drawing_pins_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."drawing_pins"
    ADD CONSTRAINT "drawing_pins_drawing_sheet_id_fkey" FOREIGN KEY ("drawing_sheet_id") REFERENCES "public"."drawing_sheets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_pins"
    ADD CONSTRAINT "drawing_pins_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_pins"
    ADD CONSTRAINT "drawing_pins_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_pins"
    ADD CONSTRAINT "drawing_pins_sheet_version_id_fkey" FOREIGN KEY ("sheet_version_id") REFERENCES "public"."drawing_sheet_versions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."drawing_revisions"
    ADD CONSTRAINT "drawing_revisions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."drawing_revisions"
    ADD CONSTRAINT "drawing_revisions_drawing_set_id_fkey" FOREIGN KEY ("drawing_set_id") REFERENCES "public"."drawing_sets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."drawing_revisions"
    ADD CONSTRAINT "drawing_revisions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_revisions"
    ADD CONSTRAINT "drawing_revisions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_sets"
    ADD CONSTRAINT "drawing_sets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."drawing_sets"
    ADD CONSTRAINT "drawing_sets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_sets"
    ADD CONSTRAINT "drawing_sets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_sets"
    ADD CONSTRAINT "drawing_sets_source_file_id_fkey" FOREIGN KEY ("source_file_id") REFERENCES "public"."files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."drawing_sheet_versions"
    ADD CONSTRAINT "drawing_sheet_versions_drawing_revision_id_fkey" FOREIGN KEY ("drawing_revision_id") REFERENCES "public"."drawing_revisions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_sheet_versions"
    ADD CONSTRAINT "drawing_sheet_versions_drawing_sheet_id_fkey" FOREIGN KEY ("drawing_sheet_id") REFERENCES "public"."drawing_sheets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_sheet_versions"
    ADD CONSTRAINT "drawing_sheet_versions_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."drawing_sheet_versions"
    ADD CONSTRAINT "drawing_sheet_versions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_sheet_versions"
    ADD CONSTRAINT "drawing_sheet_versions_thumbnail_file_id_fkey" FOREIGN KEY ("thumbnail_file_id") REFERENCES "public"."files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."drawing_sheets"
    ADD CONSTRAINT "drawing_sheets_current_revision_id_fkey" FOREIGN KEY ("current_revision_id") REFERENCES "public"."drawing_revisions"("id");



ALTER TABLE ONLY "public"."drawing_sheets"
    ADD CONSTRAINT "drawing_sheets_drawing_set_id_fkey" FOREIGN KEY ("drawing_set_id") REFERENCES "public"."drawing_sets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_sheets"
    ADD CONSTRAINT "drawing_sheets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_sheets"
    ADD CONSTRAINT "drawing_sheets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."entitlements"
    ADD CONSTRAINT "entitlements_feature_key_fkey" FOREIGN KEY ("feature_key") REFERENCES "public"."plan_features"("feature_key");



ALTER TABLE ONLY "public"."entitlements"
    ADD CONSTRAINT "entitlements_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."envelope_events"
    ADD CONSTRAINT "envelope_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."envelope_events"
    ADD CONSTRAINT "envelope_events_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."envelope_events"
    ADD CONSTRAINT "envelope_events_envelope_recipient_id_fkey" FOREIGN KEY ("envelope_recipient_id") REFERENCES "public"."envelope_recipients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."envelope_events"
    ADD CONSTRAINT "envelope_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."envelope_recipients"
    ADD CONSTRAINT "envelope_recipients_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."envelope_recipients"
    ADD CONSTRAINT "envelope_recipients_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."envelope_recipients"
    ADD CONSTRAINT "envelope_recipients_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."envelope_recipients"
    ADD CONSTRAINT "envelope_recipients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."envelopes"
    ADD CONSTRAINT "envelopes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."envelopes"
    ADD CONSTRAINT "envelopes_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."envelopes"
    ADD CONSTRAINT "envelopes_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."envelopes"
    ADD CONSTRAINT "envelopes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."estimate_items"
    ADD CONSTRAINT "estimate_items_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."estimate_items"
    ADD CONSTRAINT "estimate_items_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."estimate_items"
    ADD CONSTRAINT "estimate_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."estimate_templates"
    ADD CONSTRAINT "estimate_templates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."estimates"
    ADD CONSTRAINT "estimates_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."estimates"
    ADD CONSTRAINT "estimates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."estimates"
    ADD CONSTRAINT "estimates_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."estimates"
    ADD CONSTRAINT "estimates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."estimates"
    ADD CONSTRAINT "estimates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."estimates"
    ADD CONSTRAINT "estimates_recipient_contact_id_fkey" FOREIGN KEY ("recipient_contact_id") REFERENCES "public"."contacts"("id");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."external_portal_account_grants"
    ADD CONSTRAINT "external_portal_account_grants_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."external_portal_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."external_portal_account_grants"
    ADD CONSTRAINT "external_portal_account_grants_bid_access_token_id_fkey" FOREIGN KEY ("bid_access_token_id") REFERENCES "public"."bid_access_tokens"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."external_portal_account_grants"
    ADD CONSTRAINT "external_portal_account_grants_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."external_portal_account_grants"
    ADD CONSTRAINT "external_portal_account_grants_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."external_portal_account_grants"
    ADD CONSTRAINT "external_portal_account_grants_portal_access_token_id_fkey" FOREIGN KEY ("portal_access_token_id") REFERENCES "public"."portal_access_tokens"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."external_portal_accounts"
    ADD CONSTRAINT "external_portal_accounts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."external_portal_accounts"
    ADD CONSTRAINT "external_portal_accounts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."external_portal_sessions"
    ADD CONSTRAINT "external_portal_sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."external_portal_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."external_portal_sessions"
    ADD CONSTRAINT "external_portal_sessions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."feature_flags"
    ADD CONSTRAINT "feature_flags_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."file_access_events"
    ADD CONSTRAINT "file_access_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."file_access_events"
    ADD CONSTRAINT "file_access_events_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."file_access_events"
    ADD CONSTRAINT "file_access_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."file_links"
    ADD CONSTRAINT "file_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."file_links"
    ADD CONSTRAINT "file_links_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."file_links"
    ADD CONSTRAINT "file_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."file_links"
    ADD CONSTRAINT "file_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."file_share_links"
    ADD CONSTRAINT "file_share_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."file_share_links"
    ADD CONSTRAINT "file_share_links_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."file_share_links"
    ADD CONSTRAINT "file_share_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."file_share_links"
    ADD CONSTRAINT "file_share_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."files"
    ADD CONSTRAINT "files_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "public"."doc_versions"("id");



ALTER TABLE ONLY "public"."files"
    ADD CONSTRAINT "files_daily_log_id_fkey" FOREIGN KEY ("daily_log_id") REFERENCES "public"."daily_logs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."files"
    ADD CONSTRAINT "files_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."files"
    ADD CONSTRAINT "files_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."files"
    ADD CONSTRAINT "files_schedule_item_id_fkey" FOREIGN KEY ("schedule_item_id") REFERENCES "public"."schedule_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."files"
    ADD CONSTRAINT "files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."form_instances"
    ADD CONSTRAINT "form_instances_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."form_instances"
    ADD CONSTRAINT "form_instances_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."form_instances"
    ADD CONSTRAINT "form_instances_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."form_templates"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."form_responses"
    ADD CONSTRAINT "form_responses_form_instance_id_fkey" FOREIGN KEY ("form_instance_id") REFERENCES "public"."form_instances"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."form_responses"
    ADD CONSTRAINT "form_responses_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."form_responses"
    ADD CONSTRAINT "form_responses_responder_id_fkey" FOREIGN KEY ("responder_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."form_templates"
    ADD CONSTRAINT "form_templates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."impersonation_sessions"
    ADD CONSTRAINT "impersonation_sessions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."impersonation_sessions"
    ADD CONSTRAINT "impersonation_sessions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."impersonation_sessions"
    ADD CONSTRAINT "impersonation_sessions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id");



ALTER TABLE ONLY "public"."impersonation_sessions"
    ADD CONSTRAINT "impersonation_sessions_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."invoice_lines"
    ADD CONSTRAINT "invoice_lines_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invoice_lines"
    ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoice_lines"
    ADD CONSTRAINT "invoice_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoice_views"
    ADD CONSTRAINT "invoice_views_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoice_views"
    ADD CONSTRAINT "invoice_views_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_recipient_contact_id_fkey" FOREIGN KEY ("recipient_contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."late_fee_applications"
    ADD CONSTRAINT "late_fee_applications_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."late_fee_applications"
    ADD CONSTRAINT "late_fee_applications_invoice_line_id_fkey" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."late_fee_applications"
    ADD CONSTRAINT "late_fee_applications_late_fee_rule_id_fkey" FOREIGN KEY ("late_fee_rule_id") REFERENCES "public"."late_fees"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."late_fee_applications"
    ADD CONSTRAINT "late_fee_applications_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."late_fees"
    ADD CONSTRAINT "late_fees_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."late_fees"
    ADD CONSTRAINT "late_fees_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."licenses"
    ADD CONSTRAINT "licenses_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."licenses"
    ADD CONSTRAINT "licenses_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code");



ALTER TABLE ONLY "public"."lien_waivers"
    ADD CONSTRAINT "lien_waivers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lien_waivers"
    ADD CONSTRAINT "lien_waivers_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lien_waivers"
    ADD CONSTRAINT "lien_waivers_document_file_id_fkey" FOREIGN KEY ("document_file_id") REFERENCES "public"."files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lien_waivers"
    ADD CONSTRAINT "lien_waivers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lien_waivers"
    ADD CONSTRAINT "lien_waivers_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lien_waivers"
    ADD CONSTRAINT "lien_waivers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lien_waivers"
    ADD CONSTRAINT "lien_waivers_signed_file_id_fkey" FOREIGN KEY ("signed_file_id") REFERENCES "public"."files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."markup_rules"
    ADD CONSTRAINT "markup_rules_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."markup_rules"
    ADD CONSTRAINT "markup_rules_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."markup_rules"
    ADD CONSTRAINT "markup_rules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."membership_permission_overrides"
    ADD CONSTRAINT "membership_permission_overrides_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."membership_permission_overrides"
    ADD CONSTRAINT "membership_permission_overrides_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id");



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mentions"
    ADD CONSTRAINT "mentions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."mentions"
    ADD CONSTRAINT "mentions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mentions"
    ADD CONSTRAINT "mentions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mentions"
    ADD CONSTRAINT "mentions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."notification_deliveries"
    ADD CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_deliveries"
    ADD CONSTRAINT "notification_deliveries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."opportunities"
    ADD CONSTRAINT "opportunities_client_contact_id_fkey" FOREIGN KEY ("client_contact_id") REFERENCES "public"."contacts"("id");



ALTER TABLE ONLY "public"."opportunities"
    ADD CONSTRAINT "opportunities_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."opportunities"
    ADD CONSTRAINT "opportunities_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."org_settings"
    ADD CONSTRAINT "org_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."orgs"
    ADD CONSTRAINT "orgs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."outbox"
    ADD CONSTRAINT "outbox_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."outbox"
    ADD CONSTRAINT "outbox_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_intents"
    ADD CONSTRAINT "payment_intents_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payment_intents"
    ADD CONSTRAINT "payment_intents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_intents"
    ADD CONSTRAINT "payment_intents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payment_links"
    ADD CONSTRAINT "payment_links_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_links"
    ADD CONSTRAINT "payment_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_methods"
    ADD CONSTRAINT "payment_methods_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payment_methods"
    ADD CONSTRAINT "payment_methods_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_schedules"
    ADD CONSTRAINT "payment_schedules_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payment_schedules"
    ADD CONSTRAINT "payment_schedules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_schedules"
    ADD CONSTRAINT "payment_schedules_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payment_schedules"
    ADD CONSTRAINT "payment_schedules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "public"."vendor_bills"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_captured_by_fkey" FOREIGN KEY ("captured_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_daily_log_id_fkey" FOREIGN KEY ("daily_log_id") REFERENCES "public"."daily_logs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."plan_feature_limits"
    ADD CONSTRAINT "plan_feature_limits_feature_key_fkey" FOREIGN KEY ("feature_key") REFERENCES "public"."plan_features"("feature_key") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."plan_feature_limits"
    ADD CONSTRAINT "plan_feature_limits_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."platform_memberships"
    ADD CONSTRAINT "platform_memberships_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."platform_memberships"
    ADD CONSTRAINT "platform_memberships_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id");



ALTER TABLE ONLY "public"."platform_memberships"
    ADD CONSTRAINT "platform_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."platform_settings"
    ADD CONSTRAINT "platform_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."portal_access_tokens"
    ADD CONSTRAINT "portal_access_tokens_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."portal_access_tokens"
    ADD CONSTRAINT "portal_access_tokens_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."portal_access_tokens"
    ADD CONSTRAINT "portal_access_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."portal_access_tokens"
    ADD CONSTRAINT "portal_access_tokens_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."portal_access_tokens"
    ADD CONSTRAINT "portal_access_tokens_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_cost_code_progress"
    ADD CONSTRAINT "project_cost_code_progress_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_cost_code_progress"
    ADD CONSTRAINT "project_cost_code_progress_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_cost_code_progress"
    ADD CONSTRAINT "project_cost_code_progress_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_expenses"
    ADD CONSTRAINT "project_expenses_approved_by_pm_user_id_fkey" FOREIGN KEY ("approved_by_pm_user_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."project_expenses"
    ADD CONSTRAINT "project_expenses_billable_cost_fk" FOREIGN KEY ("billable_cost_id") REFERENCES "public"."billable_costs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_expenses"
    ADD CONSTRAINT "project_expenses_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_expenses"
    ADD CONSTRAINT "project_expenses_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_expenses"
    ADD CONSTRAINT "project_expenses_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_expenses"
    ADD CONSTRAINT "project_expenses_receipt_file_id_fkey" FOREIGN KEY ("receipt_file_id") REFERENCES "public"."files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_expenses"
    ADD CONSTRAINT "project_expenses_submitted_by_user_id_fkey" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."project_expenses"
    ADD CONSTRAINT "project_expenses_vendor_company_id_fkey" FOREIGN KEY ("vendor_company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_file_folder_permissions"
    ADD CONSTRAINT "project_file_folder_permissions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_file_folder_permissions"
    ADD CONSTRAINT "project_file_folder_permissions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_file_folder_permissions"
    ADD CONSTRAINT "project_file_folder_permissions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_file_folder_permissions"
    ADD CONSTRAINT "project_file_folder_permissions_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_file_folders"
    ADD CONSTRAINT "project_file_folders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_file_folders"
    ADD CONSTRAINT "project_file_folders_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_file_folders"
    ADD CONSTRAINT "project_file_folders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id");



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_selections"
    ADD CONSTRAINT "project_selections_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."selection_categories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_selections"
    ADD CONSTRAINT "project_selections_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_selections"
    ADD CONSTRAINT "project_selections_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_selections"
    ADD CONSTRAINT "project_selections_selected_by_contact_id_fkey" FOREIGN KEY ("selected_by_contact_id") REFERENCES "public"."contacts"("id");



ALTER TABLE ONLY "public"."project_selections"
    ADD CONSTRAINT "project_selections_selected_by_user_id_fkey" FOREIGN KEY ("selected_by_user_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."project_selections"
    ADD CONSTRAINT "project_selections_selected_option_id_fkey" FOREIGN KEY ("selected_option_id") REFERENCES "public"."selection_options"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_settings"
    ADD CONSTRAINT "project_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_settings"
    ADD CONSTRAINT "project_settings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_vendors"
    ADD CONSTRAINT "project_vendors_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_vendors"
    ADD CONSTRAINT "project_vendors_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_vendors"
    ADD CONSTRAINT "project_vendors_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_vendors"
    ADD CONSTRAINT "project_vendors_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."proposal_lines"
    ADD CONSTRAINT "proposal_lines_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."proposal_lines"
    ADD CONSTRAINT "proposal_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."proposal_lines"
    ADD CONSTRAINT "proposal_lines_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."proposals"
    ADD CONSTRAINT "proposals_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."proposals"
    ADD CONSTRAINT "proposals_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."proposals"
    ADD CONSTRAINT "proposals_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."proposals"
    ADD CONSTRAINT "proposals_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."proposals"
    ADD CONSTRAINT "proposals_recipient_contact_id_fkey" FOREIGN KEY ("recipient_contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."punch_items"
    ADD CONSTRAINT "punch_items_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."punch_items"
    ADD CONSTRAINT "punch_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."punch_items"
    ADD CONSTRAINT "punch_items_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."punch_items"
    ADD CONSTRAINT "punch_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."punch_items"
    ADD CONSTRAINT "punch_items_portal_token_id_fkey" FOREIGN KEY ("portal_token_id") REFERENCES "public"."portal_access_tokens"("id");



ALTER TABLE ONLY "public"."punch_items"
    ADD CONSTRAINT "punch_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."punch_items"
    ADD CONSTRAINT "punch_items_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."punch_items"
    ADD CONSTRAINT "punch_items_schedule_item_id_fkey" FOREIGN KEY ("schedule_item_id") REFERENCES "public"."schedule_items"("id");



ALTER TABLE ONLY "public"."punch_items"
    ADD CONSTRAINT "punch_items_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."qbo_connections"
    ADD CONSTRAINT "qbo_connections_connected_by_fkey" FOREIGN KEY ("connected_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."qbo_connections"
    ADD CONSTRAINT "qbo_connections_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."qbo_invoice_reservations"
    ADD CONSTRAINT "qbo_invoice_reservations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."qbo_invoice_reservations"
    ADD CONSTRAINT "qbo_invoice_reservations_reserved_by_fkey" FOREIGN KEY ("reserved_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."qbo_invoice_reservations"
    ADD CONSTRAINT "qbo_invoice_reservations_used_by_invoice_id_fkey" FOREIGN KEY ("used_by_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."qbo_sync_records"
    ADD CONSTRAINT "qbo_sync_records_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."qbo_connections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."qbo_sync_records"
    ADD CONSTRAINT "qbo_sync_records_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."receipts"
    ADD CONSTRAINT "receipts_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."receipts"
    ADD CONSTRAINT "receipts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."receipts"
    ADD CONSTRAINT "receipts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reminder_deliveries"
    ADD CONSTRAINT "reminder_deliveries_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reminder_deliveries"
    ADD CONSTRAINT "reminder_deliveries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reminder_deliveries"
    ADD CONSTRAINT "reminder_deliveries_reminder_id_fkey" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reminders"
    ADD CONSTRAINT "reminders_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reminders"
    ADD CONSTRAINT "reminders_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."retainage"
    ADD CONSTRAINT "retainage_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."retainage"
    ADD CONSTRAINT "retainage_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."retainage"
    ADD CONSTRAINT "retainage_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."retainage"
    ADD CONSTRAINT "retainage_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."retainage"
    ADD CONSTRAINT "retainage_release_invoice_id_fkey" FOREIGN KEY ("release_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."rfi_responses"
    ADD CONSTRAINT "rfi_responses_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."rfi_responses"
    ADD CONSTRAINT "rfi_responses_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rfi_responses"
    ADD CONSTRAINT "rfi_responses_portal_token_id_fkey" FOREIGN KEY ("portal_token_id") REFERENCES "public"."portal_access_tokens"("id");



ALTER TABLE ONLY "public"."rfi_responses"
    ADD CONSTRAINT "rfi_responses_responder_contact_id_fkey" FOREIGN KEY ("responder_contact_id") REFERENCES "public"."contacts"("id");



ALTER TABLE ONLY "public"."rfi_responses"
    ADD CONSTRAINT "rfi_responses_responder_user_id_fkey" FOREIGN KEY ("responder_user_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."rfi_responses"
    ADD CONSTRAINT "rfi_responses_rfi_id_fkey" FOREIGN KEY ("rfi_id") REFERENCES "public"."rfis"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rfis"
    ADD CONSTRAINT "rfis_assigned_company_id_fkey" FOREIGN KEY ("assigned_company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."rfis"
    ADD CONSTRAINT "rfis_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."rfis"
    ADD CONSTRAINT "rfis_attachment_file_id_fkey" FOREIGN KEY ("attachment_file_id") REFERENCES "public"."files"("id");



ALTER TABLE ONLY "public"."rfis"
    ADD CONSTRAINT "rfis_decided_by_contact_id_fkey" FOREIGN KEY ("decided_by_contact_id") REFERENCES "public"."contacts"("id");



ALTER TABLE ONLY "public"."rfis"
    ADD CONSTRAINT "rfis_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."rfis"
    ADD CONSTRAINT "rfis_decision_portal_token_id_fkey" FOREIGN KEY ("decision_portal_token_id") REFERENCES "public"."portal_access_tokens"("id");



ALTER TABLE ONLY "public"."rfis"
    ADD CONSTRAINT "rfis_notify_contact_id_fkey" FOREIGN KEY ("notify_contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."rfis"
    ADD CONSTRAINT "rfis_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rfis"
    ADD CONSTRAINT "rfis_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rfis"
    ADD CONSTRAINT "rfis_submitted_by_company_id_fkey" FOREIGN KEY ("submitted_by_company_id") REFERENCES "public"."companies"("id");



ALTER TABLE ONLY "public"."rfis"
    ADD CONSTRAINT "rfis_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_assignments"
    ADD CONSTRAINT "schedule_assignments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."schedule_assignments"
    ADD CONSTRAINT "schedule_assignments_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."schedule_assignments"
    ADD CONSTRAINT "schedule_assignments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_assignments"
    ADD CONSTRAINT "schedule_assignments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_assignments"
    ADD CONSTRAINT "schedule_assignments_schedule_item_id_fkey" FOREIGN KEY ("schedule_item_id") REFERENCES "public"."schedule_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_assignments"
    ADD CONSTRAINT "schedule_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."schedule_baselines"
    ADD CONSTRAINT "schedule_baselines_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."schedule_baselines"
    ADD CONSTRAINT "schedule_baselines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_baselines"
    ADD CONSTRAINT "schedule_baselines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_dependencies"
    ADD CONSTRAINT "schedule_dependencies_depends_on_item_id_fkey" FOREIGN KEY ("depends_on_item_id") REFERENCES "public"."schedule_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_dependencies"
    ADD CONSTRAINT "schedule_dependencies_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."schedule_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_dependencies"
    ADD CONSTRAINT "schedule_dependencies_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_dependencies"
    ADD CONSTRAINT "schedule_dependencies_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_items"
    ADD CONSTRAINT "schedule_items_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."schedule_items"
    ADD CONSTRAINT "schedule_items_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."schedule_items"
    ADD CONSTRAINT "schedule_items_inspected_by_fkey" FOREIGN KEY ("inspected_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."schedule_items"
    ADD CONSTRAINT "schedule_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_items"
    ADD CONSTRAINT "schedule_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_templates"
    ADD CONSTRAINT "schedule_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."schedule_templates"
    ADD CONSTRAINT "schedule_templates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."search_documents"
    ADD CONSTRAINT "search_documents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."search_documents"
    ADD CONSTRAINT "search_documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."search_embeddings"
    ADD CONSTRAINT "search_embeddings_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."search_documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."search_embeddings"
    ADD CONSTRAINT "search_embeddings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."selection_categories"
    ADD CONSTRAINT "selection_categories_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."selection_options"
    ADD CONSTRAINT "selection_options_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."selection_categories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."selection_options"
    ADD CONSTRAINT "selection_options_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."selection_options"
    ADD CONSTRAINT "selection_options_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stripe_connected_accounts"
    ADD CONSTRAINT "stripe_connected_accounts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."stripe_connected_accounts"
    ADD CONSTRAINT "stripe_connected_accounts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."submittal_items"
    ADD CONSTRAINT "submittal_items_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."submittal_items"
    ADD CONSTRAINT "submittal_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."submittal_items"
    ADD CONSTRAINT "submittal_items_portal_token_id_fkey" FOREIGN KEY ("portal_token_id") REFERENCES "public"."portal_access_tokens"("id");



ALTER TABLE ONLY "public"."submittal_items"
    ADD CONSTRAINT "submittal_items_responder_contact_id_fkey" FOREIGN KEY ("responder_contact_id") REFERENCES "public"."contacts"("id");



ALTER TABLE ONLY "public"."submittal_items"
    ADD CONSTRAINT "submittal_items_responder_user_id_fkey" FOREIGN KEY ("responder_user_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."submittal_items"
    ADD CONSTRAINT "submittal_items_submittal_id_fkey" FOREIGN KEY ("submittal_id") REFERENCES "public"."submittals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."submittals"
    ADD CONSTRAINT "submittals_assigned_company_id_fkey" FOREIGN KEY ("assigned_company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."submittals"
    ADD CONSTRAINT "submittals_attachment_file_id_fkey" FOREIGN KEY ("attachment_file_id") REFERENCES "public"."files"("id");



ALTER TABLE ONLY "public"."submittals"
    ADD CONSTRAINT "submittals_decision_by_contact_id_fkey" FOREIGN KEY ("decision_by_contact_id") REFERENCES "public"."contacts"("id");



ALTER TABLE ONLY "public"."submittals"
    ADD CONSTRAINT "submittals_decision_by_user_id_fkey" FOREIGN KEY ("decision_by_user_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."submittals"
    ADD CONSTRAINT "submittals_decision_portal_token_id_fkey" FOREIGN KEY ("decision_portal_token_id") REFERENCES "public"."portal_access_tokens"("id");



ALTER TABLE ONLY "public"."submittals"
    ADD CONSTRAINT "submittals_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."submittals"
    ADD CONSTRAINT "submittals_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."submittals"
    ADD CONSTRAINT "submittals_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."submittals"
    ADD CONSTRAINT "submittals_submitted_by_company_id_fkey" FOREIGN KEY ("submitted_by_company_id") REFERENCES "public"."companies"("id");



ALTER TABLE ONLY "public"."submittals"
    ADD CONSTRAINT "submittals_submitted_by_contact_id_fkey" FOREIGN KEY ("submitted_by_contact_id") REFERENCES "public"."contacts"("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code");



ALTER TABLE ONLY "public"."support_contracts"
    ADD CONSTRAINT "support_contracts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_assignments"
    ADD CONSTRAINT "task_assignments_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."task_assignments"
    ADD CONSTRAINT "task_assignments_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."task_assignments"
    ADD CONSTRAINT "task_assignments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_assignments"
    ADD CONSTRAINT "task_assignments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_assignments"
    ADD CONSTRAINT "task_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_approved_by_pm_user_id_fkey" FOREIGN KEY ("approved_by_pm_user_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_billable_cost_fk" FOREIGN KEY ("billable_cost_id") REFERENCES "public"."billable_costs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_worker_company_id_fkey" FOREIGN KEY ("worker_company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_worker_user_id_fkey" FOREIGN KEY ("worker_user_id") REFERENCES "public"."app_users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_notification_prefs"
    ADD CONSTRAINT "user_notification_prefs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_notification_prefs"
    ADD CONSTRAINT "user_notification_prefs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."variance_alerts"
    ADD CONSTRAINT "variance_alerts_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."variance_alerts"
    ADD CONSTRAINT "variance_alerts_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."variance_alerts"
    ADD CONSTRAINT "variance_alerts_cost_code_id_fkey" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."variance_alerts"
    ADD CONSTRAINT "variance_alerts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."variance_alerts"
    ADD CONSTRAINT "variance_alerts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_commitment_id_fkey" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_submitted_by_contact_id_fkey" FOREIGN KEY ("submitted_by_contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."warranty_requests"
    ADD CONSTRAINT "warranty_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id");



ALTER TABLE ONLY "public"."warranty_requests"
    ADD CONSTRAINT "warranty_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");



ALTER TABLE ONLY "public"."warranty_requests"
    ADD CONSTRAINT "warranty_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."contacts"("id");



ALTER TABLE ONLY "public"."webhook_events"
    ADD CONSTRAINT "webhook_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."workflow_runs"
    ADD CONSTRAINT "workflow_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workflow_runs"
    ADD CONSTRAINT "workflow_runs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workflows"
    ADD CONSTRAINT "workflows_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."workflows"
    ADD CONSTRAINT "workflows_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE;



CREATE POLICY "Org members can insert file access events" ON "public"."file_access_events" FOR INSERT WITH CHECK ("public"."is_org_member"("org_id"));



CREATE POLICY "Org members can view file access events" ON "public"."file_access_events" FOR SELECT USING ("public"."is_org_member"("org_id"));



CREATE POLICY "Users can delete progress in their org" ON "public"."project_cost_code_progress" FOR DELETE USING (("org_id" = (( SELECT ("auth"."jwt"() ->> 'org_id'::"text")))::"uuid"));



CREATE POLICY "Users can insert progress in their org" ON "public"."project_cost_code_progress" FOR INSERT WITH CHECK (("org_id" = (( SELECT ("auth"."jwt"() ->> 'org_id'::"text")))::"uuid"));



CREATE POLICY "Users can manage project vendors in their org" ON "public"."project_vendors" USING (("org_id" IN ( SELECT "memberships"."org_id"
   FROM "public"."memberships"
  WHERE (("memberships"."user_id" = "auth"."uid"()) AND ("memberships"."status" = 'active'::"public"."membership_status")))));



CREATE POLICY "Users can update progress in their org" ON "public"."project_cost_code_progress" FOR UPDATE USING (("org_id" = (( SELECT ("auth"."jwt"() ->> 'org_id'::"text")))::"uuid")) WITH CHECK (("org_id" = (( SELECT ("auth"."jwt"() ->> 'org_id'::"text")))::"uuid"));



CREATE POLICY "Users can view progress in their org" ON "public"."project_cost_code_progress" FOR SELECT USING (("org_id" = (( SELECT ("auth"."jwt"() ->> 'org_id'::"text")))::"uuid"));



CREATE POLICY "Users can view project vendors in their org" ON "public"."project_vendors" FOR SELECT USING (("org_id" IN ( SELECT "memberships"."org_id"
   FROM "public"."memberships"
  WHERE (("memberships"."user_id" = "auth"."uid"()) AND ("memberships"."status" = 'active'::"public"."membership_status")))));



ALTER TABLE "public"."ai_search_action_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_search_action_requests_access" ON "public"."ai_search_action_requests" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND ("auth"."uid"() = "user_id")))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND ("auth"."uid"() = "user_id"))));



ALTER TABLE "public"."ai_search_artifacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_search_artifacts_access" ON "public"."ai_search_artifacts" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."ai_search_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_search_events_access" ON "public"."ai_search_events" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND ("auth"."uid"() = "user_id")))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND ("auth"."uid"() = "user_id"))));



ALTER TABLE "public"."ai_search_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_search_messages_access" ON "public"."ai_search_messages" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND ("auth"."uid"() = "user_id")))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND ("auth"."uid"() = "user_id"))));



ALTER TABLE "public"."ai_search_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_search_sessions_access" ON "public"."ai_search_sessions" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND ("auth"."uid"() = "user_id")))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND ("auth"."uid"() = "user_id"))));



ALTER TABLE "public"."allowances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "allowances_access" ON "public"."allowances" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."app_users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "app_users_owner_access" ON "public"."app_users" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR ("id" = "auth"."uid"())));



CREATE POLICY "app_users_self_update" ON "public"."app_users" FOR UPDATE USING ((("auth"."role"() = 'service_role'::"text") OR ("id" = "auth"."uid"())));



ALTER TABLE "public"."approvals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "approvals_access" ON "public"."approvals" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."arc_bid_benchmark_facts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "arc_bid_benchmark_facts_service_role" ON "public"."arc_bid_benchmark_facts" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_log_read" ON "public"."audit_log" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."authorization_audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "authorization_audit_log_service_role_access" ON "public"."authorization_audit_log" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."bid_access_tokens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bid_access_tokens_access" ON "public"."bid_access_tokens" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."bid_addenda" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bid_addenda_access" ON "public"."bid_addenda" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."bid_addendum_acknowledgements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bid_addendum_acknowledgements_access" ON "public"."bid_addendum_acknowledgements" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."bid_awards" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bid_awards_access" ON "public"."bid_awards" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."bid_invites" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bid_invites_access" ON "public"."bid_invites" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."bid_packages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bid_packages_access" ON "public"."bid_packages" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."bid_submissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bid_submissions_access" ON "public"."bid_submissions" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."bill_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bill_lines_access" ON "public"."bill_lines" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."vendor_bills" "vb"
  WHERE (("vb"."id" = "bill_lines"."bill_id") AND ("vb"."org_id" = "bill_lines"."org_id") AND (("vb"."project_id" IS NULL) OR "public"."is_project_member"("vb"."project_id") OR "public"."is_org_admin_member"("bill_lines"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."vendor_bills" "vb"
  WHERE (("vb"."id" = "bill_lines"."bill_id") AND ("vb"."org_id" = "bill_lines"."org_id") AND (("vb"."project_id" IS NULL) OR "public"."is_project_member"("vb"."project_id") OR "public"."is_org_admin_member"("bill_lines"."org_id"))))))));



ALTER TABLE "public"."billable_costs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "billable_costs_access" ON "public"."billable_costs" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."budget_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "budget_lines_access" ON "public"."budget_lines" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."budget_revision_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "budget_revision_lines_access" ON "public"."budget_revision_lines" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."budget_revisions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "budget_revisions_access" ON "public"."budget_revisions" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."budget_snapshots" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "budget_snapshots_access" ON "public"."budget_snapshots" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."budgets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "budgets_access" ON "public"."budgets" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."change_order_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "change_order_lines_access" ON "public"."change_order_lines" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."change_orders" "co"
  WHERE (("co"."id" = "change_order_lines"."change_order_id") AND ("co"."org_id" = "change_order_lines"."org_id") AND (("co"."project_id" IS NULL) OR "public"."is_project_member"("co"."project_id") OR "public"."is_org_admin_member"("change_order_lines"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."change_orders" "co"
  WHERE (("co"."id" = "change_order_lines"."change_order_id") AND ("co"."org_id" = "change_order_lines"."org_id") AND (("co"."project_id" IS NULL) OR "public"."is_project_member"("co"."project_id") OR "public"."is_org_admin_member"("change_order_lines"."org_id"))))))));



ALTER TABLE "public"."change_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "change_orders_access" ON "public"."change_orders" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."change_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "change_requests_access" ON "public"."change_requests" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."closeout_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "closeout_items_access" ON "public"."closeout_items" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."closeout_packages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "closeout_packages_access" ON "public"."closeout_packages" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."commitment_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "commitment_lines_access" ON "public"."commitment_lines" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."commitments" "c"
  WHERE (("c"."id" = "commitment_lines"."commitment_id") AND ("c"."org_id" = "commitment_lines"."org_id") AND (("c"."project_id" IS NULL) OR "public"."is_project_member"("c"."project_id") OR "public"."is_org_admin_member"("commitment_lines"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."commitments" "c"
  WHERE (("c"."id" = "commitment_lines"."commitment_id") AND ("c"."org_id" = "commitment_lines"."org_id") AND (("c"."project_id" IS NULL) OR "public"."is_project_member"("c"."project_id") OR "public"."is_org_admin_member"("commitment_lines"."org_id"))))))));



ALTER TABLE "public"."commitments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "commitments_access" ON "public"."commitments" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."companies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "companies_access" ON "public"."companies" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



CREATE POLICY "company_compliance_req_org_access" ON "public"."company_compliance_requirements" USING (("org_id" IN ( SELECT "memberships"."org_id"
   FROM "public"."memberships"
  WHERE (("memberships"."user_id" = "auth"."uid"()) AND ("memberships"."status" = 'active'::"public"."membership_status")))));



ALTER TABLE "public"."company_compliance_requirements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "compliance_doc_types_org_access" ON "public"."compliance_document_types" USING (("org_id" IN ( SELECT "memberships"."org_id"
   FROM "public"."memberships"
  WHERE (("memberships"."user_id" = "auth"."uid"()) AND ("memberships"."status" = 'active'::"public"."membership_status")))));



CREATE POLICY "compliance_docs_org_access" ON "public"."compliance_documents" USING (("org_id" IN ( SELECT "memberships"."org_id"
   FROM "public"."memberships"
  WHERE (("memberships"."user_id" = "auth"."uid"()) AND ("memberships"."status" = 'active'::"public"."membership_status")))));



ALTER TABLE "public"."compliance_document_types" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."compliance_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact_company_links" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contact_company_links_access" ON "public"."contact_company_links" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."contacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contacts_access" ON "public"."contacts" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."contracts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contracts_access" ON "public"."contracts" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."conversation_read_states" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "conversation_read_states_access" ON "public"."conversation_read_states" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "conversations_access" ON "public"."conversations" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."conversion_run_steps" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "conversion_run_steps_access" ON "public"."conversion_run_steps" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."conversion_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "conversion_runs_access" ON "public"."conversion_runs" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."cost_approval_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cost_approval_batches_access" ON "public"."cost_approval_batches" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."cost_codes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cost_codes_access" ON "public"."cost_codes" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."custom_field_values" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "custom_field_values_access" ON "public"."custom_field_values" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."custom_fields" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "custom_fields_access" ON "public"."custom_fields" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."daily_log_entries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "daily_log_entries_access" ON "public"."daily_log_entries" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."daily_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "daily_logs_access" ON "public"."daily_logs" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."decisions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "decisions_access" ON "public"."decisions" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."doc_versions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "doc_versions_access" ON "public"."doc_versions" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."document_fields" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "document_fields_access" ON "public"."document_fields" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."documents" "d"
  WHERE (("d"."id" = "document_fields"."document_id") AND ("d"."org_id" = "document_fields"."org_id") AND (("d"."project_id" IS NULL) OR "public"."is_project_member"("d"."project_id") OR "public"."is_org_admin_member"("document_fields"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."documents" "d"
  WHERE (("d"."id" = "document_fields"."document_id") AND ("d"."org_id" = "document_fields"."org_id") AND (("d"."project_id" IS NULL) OR "public"."is_project_member"("d"."project_id") OR "public"."is_org_admin_member"("document_fields"."org_id"))))))));



ALTER TABLE "public"."document_packet_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "document_packet_items_access" ON "public"."document_packet_items" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."document_packets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "document_packets_access" ON "public"."document_packets" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."document_signatures" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "document_signatures_access" ON "public"."document_signatures" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."documents" "d"
  WHERE (("d"."id" = "document_signatures"."document_id") AND ("d"."org_id" = "document_signatures"."org_id") AND (("d"."project_id" IS NULL) OR "public"."is_project_member"("d"."project_id") OR "public"."is_org_admin_member"("document_signatures"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."documents" "d"
  WHERE (("d"."id" = "document_signatures"."document_id") AND ("d"."org_id" = "document_signatures"."org_id") AND (("d"."project_id" IS NULL) OR "public"."is_project_member"("d"."project_id") OR "public"."is_org_admin_member"("document_signatures"."org_id"))))))));



ALTER TABLE "public"."document_signing_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "document_signing_requests_access" ON "public"."document_signing_requests" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."documents" "d"
  WHERE (("d"."id" = "document_signing_requests"."document_id") AND ("d"."org_id" = "document_signing_requests"."org_id") AND (("d"."project_id" IS NULL) OR "public"."is_project_member"("d"."project_id") OR "public"."is_org_admin_member"("document_signing_requests"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."documents" "d"
  WHERE (("d"."id" = "document_signing_requests"."document_id") AND ("d"."org_id" = "document_signing_requests"."org_id") AND (("d"."project_id" IS NULL) OR "public"."is_project_member"("d"."project_id") OR "public"."is_org_admin_member"("document_signing_requests"."org_id"))))))));



ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "documents_access" ON "public"."documents" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."draw_schedules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "draw_schedules_access" ON "public"."draw_schedules" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."drawing_markups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drawing_markups_access" ON "public"."drawing_markups" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."drawing_sheets" "ds"
  WHERE (("ds"."id" = "drawing_markups"."drawing_sheet_id") AND ("ds"."org_id" = "drawing_markups"."org_id") AND (("ds"."project_id" IS NULL) OR "public"."is_project_member"("ds"."project_id") OR "public"."is_org_admin_member"("drawing_markups"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."drawing_sheets" "ds"
  WHERE (("ds"."id" = "drawing_markups"."drawing_sheet_id") AND ("ds"."org_id" = "drawing_markups"."org_id") AND (("ds"."project_id" IS NULL) OR "public"."is_project_member"("ds"."project_id") OR "public"."is_org_admin_member"("drawing_markups"."org_id"))))))));



ALTER TABLE "public"."drawing_pins" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drawing_pins_access" ON "public"."drawing_pins" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."drawing_revisions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drawing_revisions_access" ON "public"."drawing_revisions" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."drawing_sets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drawing_sets_access" ON "public"."drawing_sets" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."drawing_sheet_versions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drawing_sheet_versions_access" ON "public"."drawing_sheet_versions" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."drawing_sheets" "ds"
  WHERE (("ds"."id" = "drawing_sheet_versions"."drawing_sheet_id") AND ("ds"."org_id" = "drawing_sheet_versions"."org_id") AND (("ds"."project_id" IS NULL) OR "public"."is_project_member"("ds"."project_id") OR "public"."is_org_admin_member"("drawing_sheet_versions"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."drawing_sheets" "ds"
  WHERE (("ds"."id" = "drawing_sheet_versions"."drawing_sheet_id") AND ("ds"."org_id" = "drawing_sheet_versions"."org_id") AND (("ds"."project_id" IS NULL) OR "public"."is_project_member"("ds"."project_id") OR "public"."is_org_admin_member"("drawing_sheet_versions"."org_id"))))))));



ALTER TABLE "public"."drawing_sheets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drawing_sheets_access" ON "public"."drawing_sheets" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."entitlements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "entitlements_access" ON "public"."entitlements" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."envelope_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "envelope_events_access" ON "public"."envelope_events" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."envelopes" "e"
  WHERE (("e"."id" = "envelope_events"."envelope_id") AND ("e"."org_id" = "envelope_events"."org_id") AND (("e"."project_id" IS NULL) OR "public"."is_project_member"("e"."project_id") OR "public"."is_org_admin_member"("envelope_events"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."envelopes" "e"
  WHERE (("e"."id" = "envelope_events"."envelope_id") AND ("e"."org_id" = "envelope_events"."org_id") AND (("e"."project_id" IS NULL) OR "public"."is_project_member"("e"."project_id") OR "public"."is_org_admin_member"("envelope_events"."org_id"))))))));



ALTER TABLE "public"."envelope_recipients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "envelope_recipients_access" ON "public"."envelope_recipients" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."envelopes" "e"
  WHERE (("e"."id" = "envelope_recipients"."envelope_id") AND ("e"."org_id" = "envelope_recipients"."org_id") AND (("e"."project_id" IS NULL) OR "public"."is_project_member"("e"."project_id") OR "public"."is_org_admin_member"("envelope_recipients"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."envelopes" "e"
  WHERE (("e"."id" = "envelope_recipients"."envelope_id") AND ("e"."org_id" = "envelope_recipients"."org_id") AND (("e"."project_id" IS NULL) OR "public"."is_project_member"("e"."project_id") OR "public"."is_org_admin_member"("envelope_recipients"."org_id"))))))));



ALTER TABLE "public"."envelopes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "envelopes_access" ON "public"."envelopes" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."estimate_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "estimate_items_access" ON "public"."estimate_items" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."estimate_templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "estimate_templates_access" ON "public"."estimate_templates" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."estimates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "estimates_access" ON "public"."estimates" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "events_access" ON "public"."events" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."external_portal_account_grants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "external_portal_account_grants_service_role" ON "public"."external_portal_account_grants" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."external_portal_accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "external_portal_accounts_service_role" ON "public"."external_portal_accounts" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."external_portal_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "external_portal_sessions_service_role" ON "public"."external_portal_sessions" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."feature_flags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "feature_flags_access" ON "public"."feature_flags" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."file_access_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."file_links" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "file_links_access" ON "public"."file_links" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."file_share_links" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "file_share_links_access" ON "public"."file_share_links" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."files" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "files_access" ON "public"."files" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."form_instances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "form_instances_access" ON "public"."form_instances" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."form_responses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "form_responses_access" ON "public"."form_responses" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."form_templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "form_templates_access" ON "public"."form_templates" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."idempotency_keys" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "idempotency_keys_access" ON "public"."idempotency_keys" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."impersonation_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "impersonation_sessions_service_role_access" ON "public"."impersonation_sessions" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."invoice_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invoice_lines_access" ON "public"."invoice_lines" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."invoices" "i"
  WHERE (("i"."id" = "invoice_lines"."invoice_id") AND ("i"."org_id" = "invoice_lines"."org_id") AND (("i"."project_id" IS NULL) OR "public"."is_project_member"("i"."project_id") OR "public"."is_org_admin_member"("invoice_lines"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."invoices" "i"
  WHERE (("i"."id" = "invoice_lines"."invoice_id") AND ("i"."org_id" = "invoice_lines"."org_id") AND (("i"."project_id" IS NULL) OR "public"."is_project_member"("i"."project_id") OR "public"."is_org_admin_member"("invoice_lines"."org_id"))))))));



ALTER TABLE "public"."invoice_views" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invoice_views_access" ON "public"."invoice_views" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invoices_access" ON "public"."invoices" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."late_fee_applications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "late_fee_applications_access" ON "public"."late_fee_applications" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."late_fees" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "late_fees_access" ON "public"."late_fees" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."licenses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "licenses_access" ON "public"."licenses" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."lien_waivers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lien_waivers_access" ON "public"."lien_waivers" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."markup_rules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "markup_rules_access" ON "public"."markup_rules" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."membership_permission_overrides" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "membership_permission_overrides_service_role" ON "public"."membership_permission_overrides" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."memberships" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "memberships_access" ON "public"."memberships" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."mentions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mentions_access" ON "public"."mentions" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM ("public"."messages" "m"
     JOIN "public"."conversations" "c" ON (("c"."id" = "m"."conversation_id")))
  WHERE (("m"."id" = "mentions"."message_id") AND ("m"."org_id" = "mentions"."org_id") AND ("c"."org_id" = "mentions"."org_id") AND (("c"."project_id" IS NULL) OR "public"."is_project_member"("c"."project_id") OR "public"."is_org_admin_member"("mentions"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM ("public"."messages" "m"
     JOIN "public"."conversations" "c" ON (("c"."id" = "m"."conversation_id")))
  WHERE (("m"."id" = "mentions"."message_id") AND ("m"."org_id" = "mentions"."org_id") AND ("c"."org_id" = "mentions"."org_id") AND (("c"."project_id" IS NULL) OR "public"."is_project_member"("c"."project_id") OR "public"."is_org_admin_member"("mentions"."org_id"))))))));



ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "messages_access" ON "public"."messages" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."conversations" "c"
  WHERE (("c"."id" = "messages"."conversation_id") AND ("c"."org_id" = "messages"."org_id") AND (("c"."project_id" IS NULL) OR "public"."is_project_member"("c"."project_id") OR "public"."is_org_admin_member"("messages"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."conversations" "c"
  WHERE (("c"."id" = "messages"."conversation_id") AND ("c"."org_id" = "messages"."org_id") AND (("c"."project_id" IS NULL) OR "public"."is_project_member"("c"."project_id") OR "public"."is_org_admin_member"("messages"."org_id"))))))));



ALTER TABLE "public"."notification_deliveries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notification_deliveries_access" ON "public"."notification_deliveries" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notifications_access" ON "public"."notifications" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."opportunities" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "opportunities_access" ON "public"."opportunities" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."org_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "org_settings_access" ON "public"."org_settings" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."orgs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "orgs_access" ON "public"."orgs" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("auth"."uid"() IS NOT NULL)));



ALTER TABLE "public"."outbox" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "outbox_access" ON "public"."outbox" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."payment_intents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payment_intents_access" ON "public"."payment_intents" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."payment_links" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payment_links_access" ON "public"."payment_links" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."payment_methods" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payment_methods_access" ON "public"."payment_methods" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."payment_schedules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payment_schedules_access" ON "public"."payment_schedules" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payments_access" ON "public"."payments" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "permissions_access" ON "public"."permissions" FOR SELECT USING (true);



ALTER TABLE "public"."photos" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "photos_access" ON "public"."photos" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."plan_feature_limits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "plan_feature_limits_read" ON "public"."plan_feature_limits" FOR SELECT USING (true);



ALTER TABLE "public"."plan_features" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "plan_features_read" ON "public"."plan_features" FOR SELECT USING (true);



ALTER TABLE "public"."plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "plans_read" ON "public"."plans" FOR SELECT USING (true);



ALTER TABLE "public"."platform_memberships" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_memberships_service_role_access" ON "public"."platform_memberships" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."platform_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_settings_service_role_only" ON "public"."platform_settings" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."portal_access_tokens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "portal_tokens_service_role" ON "public"."portal_access_tokens" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."project_cost_code_progress" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."project_expenses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_expenses_access" ON "public"."project_expenses" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."project_file_folder_permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_file_folder_permissions_access" ON "public"."project_file_folder_permissions" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."project_file_folders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_file_folders_access" ON "public"."project_file_folders" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."project_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_members_access" ON "public"."project_members" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."project_selections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_selections_access" ON "public"."project_selections" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."project_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_settings_access" ON "public"."project_settings" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."project_vendors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "projects_access" ON "public"."projects" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."proposal_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "proposal_lines_access" ON "public"."proposal_lines" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."proposals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "proposals_access" ON "public"."proposals" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."punch_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "punch_items_access" ON "public"."punch_items" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."qbo_connections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "qbo_connections_access" ON "public"."qbo_connections" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."qbo_invoice_reservations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "qbo_invoice_reservations_access" ON "public"."qbo_invoice_reservations" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."qbo_sync_records" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "qbo_sync_records_access" ON "public"."qbo_sync_records" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."qbo_webhook_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "qbo_webhook_events_access" ON "public"."qbo_webhook_events" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."receipts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "receipts_access" ON "public"."receipts" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."payments" "p"
  WHERE (("p"."id" = "receipts"."payment_id") AND ("p"."org_id" = "receipts"."org_id") AND (("p"."project_id" IS NULL) OR "public"."is_project_member"("p"."project_id") OR "public"."is_org_admin_member"("receipts"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."payments" "p"
  WHERE (("p"."id" = "receipts"."payment_id") AND ("p"."org_id" = "receipts"."org_id") AND (("p"."project_id" IS NULL) OR "public"."is_project_member"("p"."project_id") OR "public"."is_org_admin_member"("receipts"."org_id"))))))));



ALTER TABLE "public"."reminder_deliveries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reminder_deliveries_access" ON "public"."reminder_deliveries" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."reminders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reminders_access" ON "public"."reminders" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."retainage" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "retainage_access" ON "public"."retainage" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."rfi_responses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "rfi_responses_access" ON "public"."rfi_responses" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."rfis" "r"
  WHERE (("r"."id" = "rfi_responses"."rfi_id") AND ("r"."org_id" = "rfi_responses"."org_id") AND (("r"."project_id" IS NULL) OR "public"."is_project_member"("r"."project_id") OR "public"."is_org_admin_member"("rfi_responses"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."rfis" "r"
  WHERE (("r"."id" = "rfi_responses"."rfi_id") AND ("r"."org_id" = "rfi_responses"."org_id") AND (("r"."project_id" IS NULL) OR "public"."is_project_member"("r"."project_id") OR "public"."is_org_admin_member"("rfi_responses"."org_id"))))))));



ALTER TABLE "public"."rfis" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "rfis_access" ON "public"."rfis" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."role_permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "role_permissions_access" ON "public"."role_permissions" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "roles_access" ON "public"."roles" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."schedule_assignments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "schedule_assignments_access" ON "public"."schedule_assignments" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."schedule_baselines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "schedule_baselines_access" ON "public"."schedule_baselines" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."schedule_dependencies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "schedule_dependencies_access" ON "public"."schedule_dependencies" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."schedule_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "schedule_items_access" ON "public"."schedule_items" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."schedule_templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "schedule_templates_access" ON "public"."schedule_templates" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."search_documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "search_documents_access" ON "public"."search_documents" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."search_embeddings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "search_embeddings_access" ON "public"."search_embeddings" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."selection_categories" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "selection_categories_access" ON "public"."selection_categories" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."selection_options" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "selection_options_access" ON "public"."selection_options" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."stripe_connected_accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "stripe_connected_accounts_access" ON "public"."stripe_connected_accounts" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."submittal_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "submittal_items_access" ON "public"."submittal_items" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."submittals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "submittals_access" ON "public"."submittals" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subscriptions_access" ON "public"."subscriptions" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."support_contracts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "support_contracts_access" ON "public"."support_contracts" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."task_assignments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "task_assignments_access" ON "public"."task_assignments" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."tasks" "t"
  WHERE (("t"."id" = "task_assignments"."task_id") AND ("t"."org_id" = "task_assignments"."org_id") AND (("t"."project_id" IS NULL) OR "public"."is_project_member"("t"."project_id") OR "public"."is_org_admin_member"("task_assignments"."org_id")))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (EXISTS ( SELECT 1
   FROM "public"."tasks" "t"
  WHERE (("t"."id" = "task_assignments"."task_id") AND ("t"."org_id" = "task_assignments"."org_id") AND (("t"."project_id" IS NULL) OR "public"."is_project_member"("t"."project_id") OR "public"."is_org_admin_member"("task_assignments"."org_id"))))))));



ALTER TABLE "public"."tasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tasks_access" ON "public"."tasks" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."time_entries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "time_entries_access" ON "public"."time_entries" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."user_notification_prefs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_notification_prefs_access" ON "public"."user_notification_prefs" USING ((("auth"."role"() = 'service_role'::"text") OR (("auth"."uid"() = "user_id") AND "public"."is_org_member"("org_id")))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (("auth"."uid"() = "user_id") AND "public"."is_org_member"("org_id"))));



ALTER TABLE "public"."variance_alerts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "variance_alerts_access" ON "public"."variance_alerts" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."vendor_bills" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vendor_bills_access" ON "public"."vendor_bills" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."warranty_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "warranty_requests_access" ON "public"."warranty_requests" USING ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id"))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("public"."is_org_member"("org_id") AND (("project_id" IS NULL) OR "public"."is_project_member"("project_id") OR "public"."is_org_admin_member"("org_id")))));



ALTER TABLE "public"."webhook_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "webhook_events_access" ON "public"."webhook_events" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."workflow_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workflow_runs_access" ON "public"."workflow_runs" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));



ALTER TABLE "public"."workflows" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workflows_access" ON "public"."workflows" USING ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR "public"."is_org_member"("org_id")));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "service_role";



GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_in"("cstring", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_in"("cstring", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_in"("cstring", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_in"("cstring", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_out"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_out"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_out"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_out"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_recv"("internal", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_recv"("internal", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_recv"("internal", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_recv"("internal", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_send"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_send"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_send"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_send"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_typmod_in"("cstring"[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_typmod_in"("cstring"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_typmod_in"("cstring"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_typmod_in"("cstring"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_in"("cstring", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_in"("cstring", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_in"("cstring", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_in"("cstring", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_out"("public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_out"("public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_out"("public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_out"("public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_recv"("internal", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_recv"("internal", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_recv"("internal", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_recv"("internal", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_send"("public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_send"("public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_send"("public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_send"("public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_typmod_in"("cstring"[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_typmod_in"("cstring"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_typmod_in"("cstring"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_typmod_in"("cstring"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_in"("cstring", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_in"("cstring", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_in"("cstring", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_in"("cstring", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_out"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_out"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_out"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_out"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_recv"("internal", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_recv"("internal", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_recv"("internal", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_recv"("internal", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_send"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_send"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_send"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_send"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_typmod_in"("cstring"[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_typmod_in"("cstring"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_typmod_in"("cstring"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_typmod_in"("cstring"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_halfvec"(real[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(real[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(real[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(real[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(real[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(real[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(real[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(real[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_vector"(real[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_vector"(real[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_vector"(real[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_vector"(real[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_halfvec"(double precision[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(double precision[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(double precision[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(double precision[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(double precision[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(double precision[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(double precision[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(double precision[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_vector"(double precision[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_vector"(double precision[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_vector"(double precision[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_vector"(double precision[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_halfvec"(integer[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(integer[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(integer[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(integer[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(integer[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(integer[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(integer[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(integer[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_vector"(integer[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_vector"(integer[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_vector"(integer[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_vector"(integer[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_halfvec"(numeric[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(numeric[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(numeric[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(numeric[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(numeric[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(numeric[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(numeric[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(numeric[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_vector"(numeric[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_vector"(numeric[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_vector"(numeric[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_vector"(numeric[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."citext"(character) TO "postgres";
GRANT ALL ON FUNCTION "public"."citext"(character) TO "anon";
GRANT ALL ON FUNCTION "public"."citext"(character) TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext"(character) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_to_float4"("public"."halfvec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_to_float4"("public"."halfvec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_to_float4"("public"."halfvec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_to_float4"("public"."halfvec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec"("public"."halfvec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec"("public"."halfvec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec"("public"."halfvec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec"("public"."halfvec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_to_sparsevec"("public"."halfvec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_to_sparsevec"("public"."halfvec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_to_sparsevec"("public"."halfvec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_to_sparsevec"("public"."halfvec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_to_vector"("public"."halfvec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_to_vector"("public"."halfvec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_to_vector"("public"."halfvec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_to_vector"("public"."halfvec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."citext"("inet") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext"("inet") TO "anon";
GRANT ALL ON FUNCTION "public"."citext"("inet") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext"("inet") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_to_halfvec"("public"."sparsevec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_to_halfvec"("public"."sparsevec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_to_halfvec"("public"."sparsevec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_to_halfvec"("public"."sparsevec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec"("public"."sparsevec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec"("public"."sparsevec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec"("public"."sparsevec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec"("public"."sparsevec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_to_vector"("public"."sparsevec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_to_vector"("public"."sparsevec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_to_vector"("public"."sparsevec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_to_vector"("public"."sparsevec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_to_float4"("public"."vector", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_to_float4"("public"."vector", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_to_float4"("public"."vector", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_to_float4"("public"."vector", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_to_halfvec"("public"."vector", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_to_halfvec"("public"."vector", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_to_halfvec"("public"."vector", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_to_halfvec"("public"."vector", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_to_sparsevec"("public"."vector", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_to_sparsevec"("public"."vector", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_to_sparsevec"("public"."vector", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_to_sparsevec"("public"."vector", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector"("public"."vector", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector"("public"."vector", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."vector"("public"."vector", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector"("public"."vector", integer, boolean) TO "service_role";






















































































































































GRANT ALL ON FUNCTION "public"."arc_benchmark_days_bucket"("p_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."arc_benchmark_days_bucket"("p_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."arc_benchmark_days_bucket"("p_days" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."arc_benchmark_normalize_trade"("p_trade" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."arc_benchmark_normalize_trade"("p_trade" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."arc_benchmark_normalize_trade"("p_trade" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."arc_benchmark_value_bucket"("p_value" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."arc_benchmark_value_bucket"("p_value" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."arc_benchmark_value_bucket"("p_value" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."budget_line_lock_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."budget_line_lock_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."budget_line_lock_guard"() TO "service_role";



GRANT ALL ON FUNCTION "public"."budget_lock_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."budget_lock_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."budget_lock_guard"() TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_jobs"("job_types" "text"[], "limit_value" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_jobs"("job_types" "text"[], "limit_value" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_jobs"("job_types" "text"[], "limit_value" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_invoice_from_billable_costs_atomic"("p_org_id" "uuid", "p_project_id" "uuid", "p_actor_id" "uuid", "p_invoice_number" "text", "p_token" "text", "p_title" "text", "p_issue_date" "date", "p_due_date" "date", "p_from_date" "date", "p_to_date" "date", "p_group_by" "text", "p_cost_ids" "uuid"[], "p_preview" "jsonb", "p_idempotency_key" "text", "p_reservation_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."create_invoice_from_billable_costs_atomic"("p_org_id" "uuid", "p_project_id" "uuid", "p_actor_id" "uuid", "p_invoice_number" "text", "p_token" "text", "p_title" "text", "p_issue_date" "date", "p_due_date" "date", "p_from_date" "date", "p_to_date" "date", "p_group_by" "text", "p_cost_ids" "uuid"[], "p_preview" "jsonb", "p_idempotency_key" "text", "p_reservation_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_invoice_from_billable_costs_atomic"("p_org_id" "uuid", "p_project_id" "uuid", "p_actor_id" "uuid", "p_invoice_number" "text", "p_token" "text", "p_title" "text", "p_issue_date" "date", "p_due_date" "date", "p_from_date" "date", "p_to_date" "date", "p_group_by" "text", "p_cost_ids" "uuid"[], "p_preview" "jsonb", "p_idempotency_key" "text", "p_reservation_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."enforce_platform_membership_role_scope"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_platform_membership_role_scope"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_platform_membership_role_scope"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_next_version_number"("p_file_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_next_version_number"("p_file_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_next_version_number"("p_file_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_user_sessions"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_sessions"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_sessions"() TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_accum"(double precision[], "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_accum"(double precision[], "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_accum"(double precision[], "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_accum"(double precision[], "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_add"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_add"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_add"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_add"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_avg"(double precision[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_avg"(double precision[]) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_avg"(double precision[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_avg"(double precision[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_cmp"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_cmp"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_cmp"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_cmp"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_combine"(double precision[], double precision[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_combine"(double precision[], double precision[]) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_combine"(double precision[], double precision[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_combine"(double precision[], double precision[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_concat"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_concat"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_concat"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_concat"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_eq"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_eq"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_eq"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_eq"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_ge"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_ge"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_ge"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_ge"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_gt"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_gt"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_gt"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_gt"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_l2_squared_distance"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_l2_squared_distance"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_l2_squared_distance"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_l2_squared_distance"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_le"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_le"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_le"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_le"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_lt"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_lt"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_lt"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_lt"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_mul"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_mul"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_mul"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_mul"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_ne"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_ne"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_ne"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_ne"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_negative_inner_product"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_negative_inner_product"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_negative_inner_product"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_negative_inner_product"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_spherical_distance"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_spherical_distance"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_spherical_distance"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_spherical_distance"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_sub"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_sub"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_sub"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_sub"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."hamming_distance"(bit, bit) TO "postgres";
GRANT ALL ON FUNCTION "public"."hamming_distance"(bit, bit) TO "anon";
GRANT ALL ON FUNCTION "public"."hamming_distance"(bit, bit) TO "authenticated";
GRANT ALL ON FUNCTION "public"."hamming_distance"(bit, bit) TO "service_role";



GRANT ALL ON FUNCTION "public"."hnsw_bit_support"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."hnsw_bit_support"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."hnsw_bit_support"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."hnsw_bit_support"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."hnsw_halfvec_support"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."hnsw_halfvec_support"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."hnsw_halfvec_support"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."hnsw_halfvec_support"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."hnsw_sparsevec_support"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."hnsw_sparsevec_support"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."hnsw_sparsevec_support"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."hnsw_sparsevec_support"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."hnswhandler"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."hnswhandler"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."hnswhandler"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."hnswhandler"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_portal_access"("token_id_input" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."increment_portal_access"("token_id_input" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_portal_access"("token_id_input" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."inner_product"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."inner_product"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."inner_product"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_org_admin_member"("check_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_org_admin_member"("check_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_org_admin_member"("check_org_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_org_member"("check_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_org_member"("check_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_org_member"("check_org_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_project_member"("check_project_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_project_member"("check_project_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_project_member"("check_project_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."ivfflat_bit_support"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."ivfflat_bit_support"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."ivfflat_bit_support"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ivfflat_bit_support"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."ivfflat_halfvec_support"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."ivfflat_halfvec_support"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."ivfflat_halfvec_support"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ivfflat_halfvec_support"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."ivfflathandler"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."ivfflathandler"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."ivfflathandler"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ivfflathandler"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."jaccard_distance"(bit, bit) TO "postgres";
GRANT ALL ON FUNCTION "public"."jaccard_distance"(bit, bit) TO "anon";
GRANT ALL ON FUNCTION "public"."jaccard_distance"(bit, bit) TO "authenticated";
GRANT ALL ON FUNCTION "public"."jaccard_distance"(bit, bit) TO "service_role";



GRANT ALL ON FUNCTION "public"."l1_distance"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l1_distance"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l1_distance"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_distance"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_distance"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_distance"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_norm"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_norm"("public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."match_search_embeddings"("p_org_id" "uuid", "p_query_embedding" "text", "p_limit" integer, "p_entity_types" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."match_search_embeddings"("p_org_id" "uuid", "p_query_embedding" "text", "p_limit" integer, "p_entity_types" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_search_embeddings"("p_org_id" "uuid", "p_query_embedding" "text", "p_limit" integer, "p_entity_types" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."next_rfi_number"("p_project_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."next_rfi_number"("p_project_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."next_rfi_number"("p_project_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."next_submittal_number"("p_project_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."next_submittal_number"("p_project_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."next_submittal_number"("p_project_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."photo_timeline_for_portal"("p_project_id" "uuid", "p_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."photo_timeline_for_portal"("p_project_id" "uuid", "p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."photo_timeline_for_portal"("p_project_id" "uuid", "p_org_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_bid_submission_benchmark"("p_bid_submission_id" "uuid", "p_min_sample_size" integer, "p_min_orgs" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_bid_submission_benchmark"("p_bid_submission_id" "uuid", "p_min_sample_size" integer, "p_min_orgs" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_bid_submission_benchmarks"("p_bid_submission_ids" "uuid"[], "p_min_sample_size" integer, "p_min_orgs" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_bid_submission_benchmarks"("p_bid_submission_ids" "uuid"[], "p_min_sample_size" integer, "p_min_orgs" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."refresh_drawing_sheets_list"() TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_drawing_sheets_list"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_drawing_sheets_list"() TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."revoke_user_session"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."revoke_user_session"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."revoke_user_session"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."run_bid_award_conversion"("p_org_id" "uuid", "p_bid_submission_id" "uuid", "p_awarded_by" "uuid", "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."run_bid_award_conversion"("p_org_id" "uuid", "p_bid_submission_id" "uuid", "p_awarded_by" "uuid", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."run_bid_award_conversion"("p_org_id" "uuid", "p_bid_submission_id" "uuid", "p_awarded_by" "uuid", "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."run_proposal_acceptance_conversion"("p_org_id" "uuid", "p_proposal_id" "uuid", "p_project_id" "uuid", "p_signature_data" "jsonb", "p_executed_file_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."run_proposal_acceptance_conversion"("p_org_id" "uuid", "p_proposal_id" "uuid", "p_project_id" "uuid", "p_signature_data" "jsonb", "p_executed_file_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."run_proposal_acceptance_conversion"("p_org_id" "uuid", "p_proposal_id" "uuid", "p_project_id" "uuid", "p_signature_data" "jsonb", "p_executed_file_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."seed_compliance_document_types"() TO "anon";
GRANT ALL ON FUNCTION "public"."seed_compliance_document_types"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."seed_compliance_document_types"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "postgres";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "anon";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_project_file_folder_permissions_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_project_file_folder_permissions_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_project_file_folder_permissions_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."show_limit"() TO "postgres";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "postgres";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "anon";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_cmp"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_cmp"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_cmp"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_cmp"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_eq"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_eq"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_eq"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_eq"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_ge"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_ge"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_ge"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_ge"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_gt"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_gt"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_gt"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_gt"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_l2_squared_distance"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_l2_squared_distance"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_l2_squared_distance"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_l2_squared_distance"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_le"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_le"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_le"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_le"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_lt"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_lt"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_lt"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_lt"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_ne"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_ne"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_ne"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_ne"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_negative_inner_product"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_negative_inner_product"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_negative_inner_product"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_negative_inner_product"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."subvector"("public"."halfvec", integer, integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."subvector"("public"."halfvec", integer, integer) TO "anon";
GRANT ALL ON FUNCTION "public"."subvector"("public"."halfvec", integer, integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."subvector"("public"."halfvec", integer, integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."subvector"("public"."vector", integer, integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."subvector"("public"."vector", integer, integer) TO "anon";
GRANT ALL ON FUNCTION "public"."subvector"("public"."vector", integer, integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."subvector"("public"."vector", integer, integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."tg_documents_sync_source_entity_from_metadata"() TO "anon";
GRANT ALL ON FUNCTION "public"."tg_documents_sync_source_entity_from_metadata"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."tg_documents_sync_source_entity_from_metadata"() TO "service_role";



GRANT ALL ON FUNCTION "public"."tg_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."tg_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."tg_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_conversation_last_message_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_conversation_last_message_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_conversation_last_message_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_drawing_markups_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_drawing_markups_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_drawing_markups_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_drawing_pins_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_drawing_pins_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_drawing_pins_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_drawing_sets_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_drawing_sets_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_drawing_sets_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_drawing_sheets_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_drawing_sheets_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_drawing_sheets_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_accum"(double precision[], "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_accum"(double precision[], "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_accum"(double precision[], "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_accum"(double precision[], "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_add"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_add"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_add"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_add"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_avg"(double precision[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_avg"(double precision[]) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_avg"(double precision[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_avg"(double precision[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_cmp"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_cmp"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_cmp"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_cmp"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_combine"(double precision[], double precision[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_combine"(double precision[], double precision[]) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_combine"(double precision[], double precision[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_combine"(double precision[], double precision[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_concat"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_concat"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_concat"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_concat"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_dims"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_dims"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_eq"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_eq"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_eq"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_eq"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_ge"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_ge"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_ge"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_ge"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_gt"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_gt"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_gt"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_gt"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_l2_squared_distance"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_l2_squared_distance"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_l2_squared_distance"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_l2_squared_distance"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_le"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_le"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_le"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_le"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_lt"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_lt"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_lt"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_lt"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_mul"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_mul"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_mul"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_mul"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_ne"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_ne"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_ne"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_ne"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_negative_inner_product"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_negative_inner_product"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_negative_inner_product"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_negative_inner_product"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_norm"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_norm"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_norm"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_norm"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_spherical_distance"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_spherical_distance"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_spherical_distance"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_spherical_distance"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_sub"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_sub"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_sub"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_sub"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "service_role";












GRANT ALL ON FUNCTION "public"."avg"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."avg"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."avg"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."avg"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."avg"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."avg"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."avg"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."avg"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."sum"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sum"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."sum"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sum"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sum"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."sum"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."sum"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sum"("public"."vector") TO "service_role";









GRANT ALL ON TABLE "public"."ai_search_action_requests" TO "anon";
GRANT ALL ON TABLE "public"."ai_search_action_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_search_action_requests" TO "service_role";



GRANT ALL ON TABLE "public"."ai_search_artifacts" TO "anon";
GRANT ALL ON TABLE "public"."ai_search_artifacts" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_search_artifacts" TO "service_role";



GRANT ALL ON TABLE "public"."ai_search_events" TO "anon";
GRANT ALL ON TABLE "public"."ai_search_events" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_search_events" TO "service_role";



GRANT ALL ON TABLE "public"."ai_search_messages" TO "anon";
GRANT ALL ON TABLE "public"."ai_search_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_search_messages" TO "service_role";



GRANT ALL ON TABLE "public"."ai_search_sessions" TO "anon";
GRANT ALL ON TABLE "public"."ai_search_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_search_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."allowances" TO "anon";
GRANT ALL ON TABLE "public"."allowances" TO "authenticated";
GRANT ALL ON TABLE "public"."allowances" TO "service_role";



GRANT ALL ON TABLE "public"."app_users" TO "anon";
GRANT ALL ON TABLE "public"."app_users" TO "authenticated";
GRANT ALL ON TABLE "public"."app_users" TO "service_role";



GRANT ALL ON TABLE "public"."approvals" TO "anon";
GRANT ALL ON TABLE "public"."approvals" TO "authenticated";
GRANT ALL ON TABLE "public"."approvals" TO "service_role";



GRANT ALL ON TABLE "public"."arc_bid_benchmark_facts" TO "anon";
GRANT ALL ON TABLE "public"."arc_bid_benchmark_facts" TO "authenticated";
GRANT ALL ON TABLE "public"."arc_bid_benchmark_facts" TO "service_role";



GRANT ALL ON TABLE "public"."audit_log" TO "anon";
GRANT ALL ON TABLE "public"."audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."audit_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."audit_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."audit_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."authorization_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."authorization_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."authorization_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."bid_access_tokens" TO "anon";
GRANT ALL ON TABLE "public"."bid_access_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."bid_access_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."bid_addenda" TO "anon";
GRANT ALL ON TABLE "public"."bid_addenda" TO "authenticated";
GRANT ALL ON TABLE "public"."bid_addenda" TO "service_role";



GRANT ALL ON TABLE "public"."bid_addendum_acknowledgements" TO "anon";
GRANT ALL ON TABLE "public"."bid_addendum_acknowledgements" TO "authenticated";
GRANT ALL ON TABLE "public"."bid_addendum_acknowledgements" TO "service_role";



GRANT ALL ON TABLE "public"."bid_awards" TO "anon";
GRANT ALL ON TABLE "public"."bid_awards" TO "authenticated";
GRANT ALL ON TABLE "public"."bid_awards" TO "service_role";



GRANT ALL ON TABLE "public"."bid_invites" TO "anon";
GRANT ALL ON TABLE "public"."bid_invites" TO "authenticated";
GRANT ALL ON TABLE "public"."bid_invites" TO "service_role";



GRANT ALL ON TABLE "public"."bid_packages" TO "anon";
GRANT ALL ON TABLE "public"."bid_packages" TO "authenticated";
GRANT ALL ON TABLE "public"."bid_packages" TO "service_role";



GRANT ALL ON TABLE "public"."bid_submissions" TO "anon";
GRANT ALL ON TABLE "public"."bid_submissions" TO "authenticated";
GRANT ALL ON TABLE "public"."bid_submissions" TO "service_role";



GRANT ALL ON TABLE "public"."bill_lines" TO "anon";
GRANT ALL ON TABLE "public"."bill_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."bill_lines" TO "service_role";



GRANT ALL ON TABLE "public"."billable_costs" TO "anon";
GRANT ALL ON TABLE "public"."billable_costs" TO "authenticated";
GRANT ALL ON TABLE "public"."billable_costs" TO "service_role";



GRANT ALL ON TABLE "public"."budget_lines" TO "anon";
GRANT ALL ON TABLE "public"."budget_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."budget_lines" TO "service_role";



GRANT ALL ON TABLE "public"."budget_revision_lines" TO "anon";
GRANT ALL ON TABLE "public"."budget_revision_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."budget_revision_lines" TO "service_role";



GRANT ALL ON TABLE "public"."budget_revisions" TO "anon";
GRANT ALL ON TABLE "public"."budget_revisions" TO "authenticated";
GRANT ALL ON TABLE "public"."budget_revisions" TO "service_role";



GRANT ALL ON TABLE "public"."budget_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."budget_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."budget_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."budgets" TO "anon";
GRANT ALL ON TABLE "public"."budgets" TO "authenticated";
GRANT ALL ON TABLE "public"."budgets" TO "service_role";



GRANT ALL ON TABLE "public"."change_order_lines" TO "anon";
GRANT ALL ON TABLE "public"."change_order_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."change_order_lines" TO "service_role";



GRANT ALL ON TABLE "public"."change_orders" TO "anon";
GRANT ALL ON TABLE "public"."change_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."change_orders" TO "service_role";



GRANT ALL ON TABLE "public"."change_requests" TO "anon";
GRANT ALL ON TABLE "public"."change_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."change_requests" TO "service_role";



GRANT ALL ON TABLE "public"."closeout_items" TO "anon";
GRANT ALL ON TABLE "public"."closeout_items" TO "authenticated";
GRANT ALL ON TABLE "public"."closeout_items" TO "service_role";



GRANT ALL ON TABLE "public"."closeout_packages" TO "anon";
GRANT ALL ON TABLE "public"."closeout_packages" TO "authenticated";
GRANT ALL ON TABLE "public"."closeout_packages" TO "service_role";



GRANT ALL ON TABLE "public"."commitment_lines" TO "anon";
GRANT ALL ON TABLE "public"."commitment_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."commitment_lines" TO "service_role";



GRANT ALL ON TABLE "public"."commitments" TO "anon";
GRANT ALL ON TABLE "public"."commitments" TO "authenticated";
GRANT ALL ON TABLE "public"."commitments" TO "service_role";



GRANT ALL ON TABLE "public"."companies" TO "anon";
GRANT ALL ON TABLE "public"."companies" TO "authenticated";
GRANT ALL ON TABLE "public"."companies" TO "service_role";



GRANT ALL ON TABLE "public"."company_compliance_requirements" TO "anon";
GRANT ALL ON TABLE "public"."company_compliance_requirements" TO "authenticated";
GRANT ALL ON TABLE "public"."company_compliance_requirements" TO "service_role";



GRANT ALL ON TABLE "public"."compliance_document_types" TO "anon";
GRANT ALL ON TABLE "public"."compliance_document_types" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_document_types" TO "service_role";



GRANT ALL ON TABLE "public"."compliance_documents" TO "anon";
GRANT ALL ON TABLE "public"."compliance_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_documents" TO "service_role";



GRANT ALL ON TABLE "public"."contact_company_links" TO "anon";
GRANT ALL ON TABLE "public"."contact_company_links" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_company_links" TO "service_role";



GRANT ALL ON TABLE "public"."contacts" TO "anon";
GRANT ALL ON TABLE "public"."contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."contacts" TO "service_role";



GRANT ALL ON TABLE "public"."contracts" TO "anon";
GRANT ALL ON TABLE "public"."contracts" TO "authenticated";
GRANT ALL ON TABLE "public"."contracts" TO "service_role";



GRANT ALL ON TABLE "public"."conversation_read_states" TO "anon";
GRANT ALL ON TABLE "public"."conversation_read_states" TO "authenticated";
GRANT ALL ON TABLE "public"."conversation_read_states" TO "service_role";



GRANT ALL ON TABLE "public"."conversations" TO "anon";
GRANT ALL ON TABLE "public"."conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."conversations" TO "service_role";



GRANT ALL ON TABLE "public"."conversion_run_steps" TO "anon";
GRANT ALL ON TABLE "public"."conversion_run_steps" TO "authenticated";
GRANT ALL ON TABLE "public"."conversion_run_steps" TO "service_role";



GRANT ALL ON TABLE "public"."conversion_runs" TO "anon";
GRANT ALL ON TABLE "public"."conversion_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."conversion_runs" TO "service_role";



GRANT ALL ON TABLE "public"."cost_approval_batches" TO "anon";
GRANT ALL ON TABLE "public"."cost_approval_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."cost_approval_batches" TO "service_role";



GRANT ALL ON TABLE "public"."cost_codes" TO "anon";
GRANT ALL ON TABLE "public"."cost_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."cost_codes" TO "service_role";



GRANT ALL ON TABLE "public"."custom_field_values" TO "anon";
GRANT ALL ON TABLE "public"."custom_field_values" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_field_values" TO "service_role";



GRANT ALL ON TABLE "public"."custom_fields" TO "anon";
GRANT ALL ON TABLE "public"."custom_fields" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_fields" TO "service_role";



GRANT ALL ON TABLE "public"."daily_log_entries" TO "anon";
GRANT ALL ON TABLE "public"."daily_log_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_log_entries" TO "service_role";



GRANT ALL ON TABLE "public"."daily_logs" TO "anon";
GRANT ALL ON TABLE "public"."daily_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_logs" TO "service_role";



GRANT ALL ON TABLE "public"."decisions" TO "anon";
GRANT ALL ON TABLE "public"."decisions" TO "authenticated";
GRANT ALL ON TABLE "public"."decisions" TO "service_role";



GRANT ALL ON TABLE "public"."doc_versions" TO "anon";
GRANT ALL ON TABLE "public"."doc_versions" TO "authenticated";
GRANT ALL ON TABLE "public"."doc_versions" TO "service_role";



GRANT ALL ON TABLE "public"."document_fields" TO "anon";
GRANT ALL ON TABLE "public"."document_fields" TO "authenticated";
GRANT ALL ON TABLE "public"."document_fields" TO "service_role";



GRANT ALL ON TABLE "public"."document_packet_items" TO "anon";
GRANT ALL ON TABLE "public"."document_packet_items" TO "authenticated";
GRANT ALL ON TABLE "public"."document_packet_items" TO "service_role";



GRANT ALL ON TABLE "public"."document_packets" TO "anon";
GRANT ALL ON TABLE "public"."document_packets" TO "authenticated";
GRANT ALL ON TABLE "public"."document_packets" TO "service_role";



GRANT ALL ON TABLE "public"."document_signatures" TO "anon";
GRANT ALL ON TABLE "public"."document_signatures" TO "authenticated";
GRANT ALL ON TABLE "public"."document_signatures" TO "service_role";



GRANT ALL ON TABLE "public"."document_signing_requests" TO "anon";
GRANT ALL ON TABLE "public"."document_signing_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."document_signing_requests" TO "service_role";



GRANT ALL ON TABLE "public"."documents" TO "anon";
GRANT ALL ON TABLE "public"."documents" TO "authenticated";
GRANT ALL ON TABLE "public"."documents" TO "service_role";



GRANT ALL ON TABLE "public"."draw_schedules" TO "anon";
GRANT ALL ON TABLE "public"."draw_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."draw_schedules" TO "service_role";



GRANT ALL ON TABLE "public"."drawing_markups" TO "anon";
GRANT ALL ON TABLE "public"."drawing_markups" TO "authenticated";
GRANT ALL ON TABLE "public"."drawing_markups" TO "service_role";



GRANT ALL ON TABLE "public"."drawing_pins" TO "anon";
GRANT ALL ON TABLE "public"."drawing_pins" TO "authenticated";
GRANT ALL ON TABLE "public"."drawing_pins" TO "service_role";



GRANT ALL ON TABLE "public"."drawing_revisions" TO "anon";
GRANT ALL ON TABLE "public"."drawing_revisions" TO "authenticated";
GRANT ALL ON TABLE "public"."drawing_revisions" TO "service_role";



GRANT ALL ON TABLE "public"."drawing_sets" TO "anon";
GRANT ALL ON TABLE "public"."drawing_sets" TO "authenticated";
GRANT ALL ON TABLE "public"."drawing_sets" TO "service_role";



GRANT ALL ON TABLE "public"."drawing_sheet_versions" TO "anon";
GRANT ALL ON TABLE "public"."drawing_sheet_versions" TO "authenticated";
GRANT ALL ON TABLE "public"."drawing_sheet_versions" TO "service_role";



GRANT ALL ON TABLE "public"."drawing_sheets" TO "anon";
GRANT ALL ON TABLE "public"."drawing_sheets" TO "authenticated";
GRANT ALL ON TABLE "public"."drawing_sheets" TO "service_role";



GRANT ALL ON TABLE "public"."drawing_sheets_list_mv" TO "service_role";



GRANT ALL ON TABLE "public"."drawing_sheets_list" TO "anon";
GRANT ALL ON TABLE "public"."drawing_sheets_list" TO "authenticated";
GRANT ALL ON TABLE "public"."drawing_sheets_list" TO "service_role";



GRANT ALL ON TABLE "public"."entitlements" TO "anon";
GRANT ALL ON TABLE "public"."entitlements" TO "authenticated";
GRANT ALL ON TABLE "public"."entitlements" TO "service_role";



GRANT ALL ON TABLE "public"."envelope_events" TO "anon";
GRANT ALL ON TABLE "public"."envelope_events" TO "authenticated";
GRANT ALL ON TABLE "public"."envelope_events" TO "service_role";



GRANT ALL ON TABLE "public"."envelope_recipients" TO "anon";
GRANT ALL ON TABLE "public"."envelope_recipients" TO "authenticated";
GRANT ALL ON TABLE "public"."envelope_recipients" TO "service_role";



GRANT ALL ON TABLE "public"."envelopes" TO "anon";
GRANT ALL ON TABLE "public"."envelopes" TO "authenticated";
GRANT ALL ON TABLE "public"."envelopes" TO "service_role";



GRANT ALL ON TABLE "public"."estimate_items" TO "anon";
GRANT ALL ON TABLE "public"."estimate_items" TO "authenticated";
GRANT ALL ON TABLE "public"."estimate_items" TO "service_role";



GRANT ALL ON TABLE "public"."estimate_templates" TO "anon";
GRANT ALL ON TABLE "public"."estimate_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."estimate_templates" TO "service_role";



GRANT ALL ON TABLE "public"."estimates" TO "anon";
GRANT ALL ON TABLE "public"."estimates" TO "authenticated";
GRANT ALL ON TABLE "public"."estimates" TO "service_role";



GRANT ALL ON TABLE "public"."events" TO "anon";
GRANT ALL ON TABLE "public"."events" TO "authenticated";
GRANT ALL ON TABLE "public"."events" TO "service_role";



GRANT ALL ON TABLE "public"."external_portal_account_grants" TO "anon";
GRANT ALL ON TABLE "public"."external_portal_account_grants" TO "authenticated";
GRANT ALL ON TABLE "public"."external_portal_account_grants" TO "service_role";



GRANT ALL ON TABLE "public"."external_portal_accounts" TO "anon";
GRANT ALL ON TABLE "public"."external_portal_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."external_portal_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."external_portal_sessions" TO "anon";
GRANT ALL ON TABLE "public"."external_portal_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."external_portal_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."feature_flags" TO "anon";
GRANT ALL ON TABLE "public"."feature_flags" TO "authenticated";
GRANT ALL ON TABLE "public"."feature_flags" TO "service_role";



GRANT ALL ON TABLE "public"."file_access_events" TO "anon";
GRANT ALL ON TABLE "public"."file_access_events" TO "authenticated";
GRANT ALL ON TABLE "public"."file_access_events" TO "service_role";



GRANT ALL ON TABLE "public"."file_links" TO "anon";
GRANT ALL ON TABLE "public"."file_links" TO "authenticated";
GRANT ALL ON TABLE "public"."file_links" TO "service_role";



GRANT ALL ON TABLE "public"."file_share_links" TO "anon";
GRANT ALL ON TABLE "public"."file_share_links" TO "authenticated";
GRANT ALL ON TABLE "public"."file_share_links" TO "service_role";



GRANT ALL ON TABLE "public"."files" TO "anon";
GRANT ALL ON TABLE "public"."files" TO "authenticated";
GRANT ALL ON TABLE "public"."files" TO "service_role";



GRANT ALL ON TABLE "public"."form_instances" TO "anon";
GRANT ALL ON TABLE "public"."form_instances" TO "authenticated";
GRANT ALL ON TABLE "public"."form_instances" TO "service_role";



GRANT ALL ON TABLE "public"."form_responses" TO "anon";
GRANT ALL ON TABLE "public"."form_responses" TO "authenticated";
GRANT ALL ON TABLE "public"."form_responses" TO "service_role";



GRANT ALL ON TABLE "public"."form_templates" TO "anon";
GRANT ALL ON TABLE "public"."form_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."form_templates" TO "service_role";



GRANT ALL ON TABLE "public"."idempotency_keys" TO "anon";
GRANT ALL ON TABLE "public"."idempotency_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."idempotency_keys" TO "service_role";



GRANT ALL ON TABLE "public"."impersonation_sessions" TO "anon";
GRANT ALL ON TABLE "public"."impersonation_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."impersonation_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."invoice_lines" TO "anon";
GRANT ALL ON TABLE "public"."invoice_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."invoice_lines" TO "service_role";



GRANT ALL ON TABLE "public"."invoice_views" TO "anon";
GRANT ALL ON TABLE "public"."invoice_views" TO "authenticated";
GRANT ALL ON TABLE "public"."invoice_views" TO "service_role";



GRANT ALL ON TABLE "public"."invoices" TO "anon";
GRANT ALL ON TABLE "public"."invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."invoices" TO "service_role";



GRANT ALL ON TABLE "public"."late_fee_applications" TO "anon";
GRANT ALL ON TABLE "public"."late_fee_applications" TO "authenticated";
GRANT ALL ON TABLE "public"."late_fee_applications" TO "service_role";



GRANT ALL ON TABLE "public"."late_fees" TO "anon";
GRANT ALL ON TABLE "public"."late_fees" TO "authenticated";
GRANT ALL ON TABLE "public"."late_fees" TO "service_role";



GRANT ALL ON TABLE "public"."licenses" TO "anon";
GRANT ALL ON TABLE "public"."licenses" TO "authenticated";
GRANT ALL ON TABLE "public"."licenses" TO "service_role";



GRANT ALL ON TABLE "public"."lien_waivers" TO "anon";
GRANT ALL ON TABLE "public"."lien_waivers" TO "authenticated";
GRANT ALL ON TABLE "public"."lien_waivers" TO "service_role";



GRANT ALL ON TABLE "public"."markup_rules" TO "anon";
GRANT ALL ON TABLE "public"."markup_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."markup_rules" TO "service_role";



GRANT ALL ON TABLE "public"."membership_permission_overrides" TO "anon";
GRANT ALL ON TABLE "public"."membership_permission_overrides" TO "authenticated";
GRANT ALL ON TABLE "public"."membership_permission_overrides" TO "service_role";



GRANT ALL ON TABLE "public"."memberships" TO "anon";
GRANT ALL ON TABLE "public"."memberships" TO "authenticated";
GRANT ALL ON TABLE "public"."memberships" TO "service_role";



GRANT ALL ON TABLE "public"."mentions" TO "anon";
GRANT ALL ON TABLE "public"."mentions" TO "authenticated";
GRANT ALL ON TABLE "public"."mentions" TO "service_role";



GRANT ALL ON TABLE "public"."messages" TO "anon";
GRANT ALL ON TABLE "public"."messages" TO "authenticated";
GRANT ALL ON TABLE "public"."messages" TO "service_role";



GRANT ALL ON TABLE "public"."notification_deliveries" TO "anon";
GRANT ALL ON TABLE "public"."notification_deliveries" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_deliveries" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."opportunities" TO "anon";
GRANT ALL ON TABLE "public"."opportunities" TO "authenticated";
GRANT ALL ON TABLE "public"."opportunities" TO "service_role";



GRANT ALL ON TABLE "public"."org_settings" TO "anon";
GRANT ALL ON TABLE "public"."org_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."org_settings" TO "service_role";



GRANT ALL ON TABLE "public"."orgs" TO "anon";
GRANT ALL ON TABLE "public"."orgs" TO "authenticated";
GRANT ALL ON TABLE "public"."orgs" TO "service_role";



GRANT ALL ON TABLE "public"."outbox" TO "anon";
GRANT ALL ON TABLE "public"."outbox" TO "authenticated";
GRANT ALL ON TABLE "public"."outbox" TO "service_role";



GRANT ALL ON SEQUENCE "public"."outbox_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."outbox_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."outbox_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."payment_intents" TO "anon";
GRANT ALL ON TABLE "public"."payment_intents" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_intents" TO "service_role";



GRANT ALL ON TABLE "public"."payment_links" TO "anon";
GRANT ALL ON TABLE "public"."payment_links" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_links" TO "service_role";



GRANT ALL ON TABLE "public"."payment_methods" TO "anon";
GRANT ALL ON TABLE "public"."payment_methods" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_methods" TO "service_role";



GRANT ALL ON TABLE "public"."payment_schedules" TO "anon";
GRANT ALL ON TABLE "public"."payment_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_schedules" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON TABLE "public"."permissions" TO "anon";
GRANT ALL ON TABLE "public"."permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."permissions" TO "service_role";



GRANT ALL ON TABLE "public"."photos" TO "anon";
GRANT ALL ON TABLE "public"."photos" TO "authenticated";
GRANT ALL ON TABLE "public"."photos" TO "service_role";



GRANT ALL ON TABLE "public"."plan_feature_limits" TO "anon";
GRANT ALL ON TABLE "public"."plan_feature_limits" TO "authenticated";
GRANT ALL ON TABLE "public"."plan_feature_limits" TO "service_role";



GRANT ALL ON TABLE "public"."plan_features" TO "anon";
GRANT ALL ON TABLE "public"."plan_features" TO "authenticated";
GRANT ALL ON TABLE "public"."plan_features" TO "service_role";



GRANT ALL ON TABLE "public"."plans" TO "anon";
GRANT ALL ON TABLE "public"."plans" TO "authenticated";
GRANT ALL ON TABLE "public"."plans" TO "service_role";



GRANT ALL ON TABLE "public"."platform_memberships" TO "anon";
GRANT ALL ON TABLE "public"."platform_memberships" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_memberships" TO "service_role";



GRANT ALL ON TABLE "public"."platform_settings" TO "anon";
GRANT ALL ON TABLE "public"."platform_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_settings" TO "service_role";



GRANT ALL ON TABLE "public"."portal_access_tokens" TO "anon";
GRANT ALL ON TABLE "public"."portal_access_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."portal_access_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."project_cost_code_progress" TO "anon";
GRANT ALL ON TABLE "public"."project_cost_code_progress" TO "authenticated";
GRANT ALL ON TABLE "public"."project_cost_code_progress" TO "service_role";



GRANT ALL ON TABLE "public"."project_expenses" TO "anon";
GRANT ALL ON TABLE "public"."project_expenses" TO "authenticated";
GRANT ALL ON TABLE "public"."project_expenses" TO "service_role";



GRANT ALL ON TABLE "public"."project_file_folder_permissions" TO "anon";
GRANT ALL ON TABLE "public"."project_file_folder_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."project_file_folder_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."project_file_folders" TO "anon";
GRANT ALL ON TABLE "public"."project_file_folders" TO "authenticated";
GRANT ALL ON TABLE "public"."project_file_folders" TO "service_role";



GRANT ALL ON TABLE "public"."project_members" TO "anon";
GRANT ALL ON TABLE "public"."project_members" TO "authenticated";
GRANT ALL ON TABLE "public"."project_members" TO "service_role";



GRANT ALL ON TABLE "public"."project_selections" TO "anon";
GRANT ALL ON TABLE "public"."project_selections" TO "authenticated";
GRANT ALL ON TABLE "public"."project_selections" TO "service_role";



GRANT ALL ON TABLE "public"."project_settings" TO "anon";
GRANT ALL ON TABLE "public"."project_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."project_settings" TO "service_role";



GRANT ALL ON TABLE "public"."project_vendors" TO "anon";
GRANT ALL ON TABLE "public"."project_vendors" TO "authenticated";
GRANT ALL ON TABLE "public"."project_vendors" TO "service_role";



GRANT ALL ON TABLE "public"."projects" TO "anon";
GRANT ALL ON TABLE "public"."projects" TO "authenticated";
GRANT ALL ON TABLE "public"."projects" TO "service_role";



GRANT ALL ON TABLE "public"."proposal_lines" TO "anon";
GRANT ALL ON TABLE "public"."proposal_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."proposal_lines" TO "service_role";



GRANT ALL ON TABLE "public"."proposals" TO "anon";
GRANT ALL ON TABLE "public"."proposals" TO "authenticated";
GRANT ALL ON TABLE "public"."proposals" TO "service_role";



GRANT ALL ON TABLE "public"."punch_items" TO "anon";
GRANT ALL ON TABLE "public"."punch_items" TO "authenticated";
GRANT ALL ON TABLE "public"."punch_items" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_connections" TO "anon";
GRANT ALL ON TABLE "public"."qbo_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_connections" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_invoice_reservations" TO "anon";
GRANT ALL ON TABLE "public"."qbo_invoice_reservations" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_invoice_reservations" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_sync_records" TO "anon";
GRANT ALL ON TABLE "public"."qbo_sync_records" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_sync_records" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_webhook_events" TO "anon";
GRANT ALL ON TABLE "public"."qbo_webhook_events" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_webhook_events" TO "service_role";



GRANT ALL ON TABLE "public"."receipts" TO "anon";
GRANT ALL ON TABLE "public"."receipts" TO "authenticated";
GRANT ALL ON TABLE "public"."receipts" TO "service_role";



GRANT ALL ON TABLE "public"."reminder_deliveries" TO "anon";
GRANT ALL ON TABLE "public"."reminder_deliveries" TO "authenticated";
GRANT ALL ON TABLE "public"."reminder_deliveries" TO "service_role";



GRANT ALL ON TABLE "public"."reminders" TO "anon";
GRANT ALL ON TABLE "public"."reminders" TO "authenticated";
GRANT ALL ON TABLE "public"."reminders" TO "service_role";



GRANT ALL ON TABLE "public"."retainage" TO "anon";
GRANT ALL ON TABLE "public"."retainage" TO "authenticated";
GRANT ALL ON TABLE "public"."retainage" TO "service_role";



GRANT ALL ON TABLE "public"."rfi_responses" TO "anon";
GRANT ALL ON TABLE "public"."rfi_responses" TO "authenticated";
GRANT ALL ON TABLE "public"."rfi_responses" TO "service_role";



GRANT ALL ON TABLE "public"."rfis" TO "anon";
GRANT ALL ON TABLE "public"."rfis" TO "authenticated";
GRANT ALL ON TABLE "public"."rfis" TO "service_role";



GRANT ALL ON TABLE "public"."role_permissions" TO "anon";
GRANT ALL ON TABLE "public"."role_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."role_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."roles" TO "anon";
GRANT ALL ON TABLE "public"."roles" TO "authenticated";
GRANT ALL ON TABLE "public"."roles" TO "service_role";



GRANT ALL ON TABLE "public"."schedule_assignments" TO "anon";
GRANT ALL ON TABLE "public"."schedule_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."schedule_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."schedule_baselines" TO "anon";
GRANT ALL ON TABLE "public"."schedule_baselines" TO "authenticated";
GRANT ALL ON TABLE "public"."schedule_baselines" TO "service_role";



GRANT ALL ON TABLE "public"."schedule_dependencies" TO "anon";
GRANT ALL ON TABLE "public"."schedule_dependencies" TO "authenticated";
GRANT ALL ON TABLE "public"."schedule_dependencies" TO "service_role";



GRANT ALL ON TABLE "public"."schedule_items" TO "anon";
GRANT ALL ON TABLE "public"."schedule_items" TO "authenticated";
GRANT ALL ON TABLE "public"."schedule_items" TO "service_role";



GRANT ALL ON TABLE "public"."schedule_templates" TO "anon";
GRANT ALL ON TABLE "public"."schedule_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."schedule_templates" TO "service_role";



GRANT ALL ON TABLE "public"."search_documents" TO "anon";
GRANT ALL ON TABLE "public"."search_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."search_documents" TO "service_role";



GRANT ALL ON TABLE "public"."search_embeddings" TO "anon";
GRANT ALL ON TABLE "public"."search_embeddings" TO "authenticated";
GRANT ALL ON TABLE "public"."search_embeddings" TO "service_role";



GRANT ALL ON TABLE "public"."selection_categories" TO "anon";
GRANT ALL ON TABLE "public"."selection_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."selection_categories" TO "service_role";



GRANT ALL ON TABLE "public"."selection_options" TO "anon";
GRANT ALL ON TABLE "public"."selection_options" TO "authenticated";
GRANT ALL ON TABLE "public"."selection_options" TO "service_role";



GRANT ALL ON TABLE "public"."stripe_connected_accounts" TO "anon";
GRANT ALL ON TABLE "public"."stripe_connected_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."stripe_connected_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."submittal_items" TO "anon";
GRANT ALL ON TABLE "public"."submittal_items" TO "authenticated";
GRANT ALL ON TABLE "public"."submittal_items" TO "service_role";



GRANT ALL ON TABLE "public"."submittals" TO "anon";
GRANT ALL ON TABLE "public"."submittals" TO "authenticated";
GRANT ALL ON TABLE "public"."submittals" TO "service_role";



GRANT ALL ON TABLE "public"."subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."support_contracts" TO "anon";
GRANT ALL ON TABLE "public"."support_contracts" TO "authenticated";
GRANT ALL ON TABLE "public"."support_contracts" TO "service_role";



GRANT ALL ON TABLE "public"."task_assignments" TO "anon";
GRANT ALL ON TABLE "public"."task_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."task_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."tasks" TO "anon";
GRANT ALL ON TABLE "public"."tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."tasks" TO "service_role";



GRANT ALL ON TABLE "public"."time_entries" TO "anon";
GRANT ALL ON TABLE "public"."time_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."time_entries" TO "service_role";



GRANT ALL ON TABLE "public"."user_notification_prefs" TO "anon";
GRANT ALL ON TABLE "public"."user_notification_prefs" TO "authenticated";
GRANT ALL ON TABLE "public"."user_notification_prefs" TO "service_role";



GRANT ALL ON TABLE "public"."variance_alerts" TO "anon";
GRANT ALL ON TABLE "public"."variance_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."variance_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."vendor_bills" TO "anon";
GRANT ALL ON TABLE "public"."vendor_bills" TO "authenticated";
GRANT ALL ON TABLE "public"."vendor_bills" TO "service_role";



GRANT ALL ON TABLE "public"."warranty_requests" TO "anon";
GRANT ALL ON TABLE "public"."warranty_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."warranty_requests" TO "service_role";



GRANT ALL ON TABLE "public"."webhook_events" TO "anon";
GRANT ALL ON TABLE "public"."webhook_events" TO "authenticated";
GRANT ALL ON TABLE "public"."webhook_events" TO "service_role";



GRANT ALL ON TABLE "public"."workflow_runs" TO "anon";
GRANT ALL ON TABLE "public"."workflow_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."workflow_runs" TO "service_role";



GRANT ALL ON TABLE "public"."workflows" TO "anon";
GRANT ALL ON TABLE "public"."workflows" TO "authenticated";
GRANT ALL ON TABLE "public"."workflows" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































