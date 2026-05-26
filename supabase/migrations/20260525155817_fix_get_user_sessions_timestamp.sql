-- Fix get_user_sessions(): auth.sessions.refreshed_at is `timestamp without time zone`,
-- but the function declares column 4 (last_active_at) as `timestamp with time zone`.
-- This mismatch made every call fail with:
--   "structure of query does not match function result type"
-- so the Active Sessions UI never worked. Cast refreshed_at to timestamptz (UTC) and
-- fall back to updated_at when it is null.

CREATE OR REPLACE FUNCTION "public"."get_user_sessions"()
    RETURNS TABLE("id" "uuid", "created_at" timestamp with time zone, "updated_at" timestamp with time zone, "last_active_at" timestamp with time zone, "user_agent" "text", "ip_address" "text", "is_current" boolean)
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
        COALESCE(s.refreshed_at AT TIME ZONE 'UTC', s.updated_at) as last_active_at,
        s.user_agent,
        s.ip::text as ip_address,
        (s.id = v_current_session_id) as is_current
    FROM auth.sessions s
    WHERE s.user_id = auth.uid()
    ORDER BY s.updated_at DESC;
END;
$$;

COMMENT ON FUNCTION "public"."get_user_sessions"() IS 'Returns active sessions for the current user. (v1.0.2 - cast refreshed_at to timestamptz)';
