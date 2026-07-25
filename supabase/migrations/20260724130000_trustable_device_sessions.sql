-- Make the Devices list trustable.
--
-- auth.sessions rows never expire on their own (no time-box/inactivity timeout is
-- configured), so every sign-in ever performed kept showing up as a live "device".
-- A session that has not refreshed a token in 30 days cannot be honestly presented
-- as a signed-in device: access tokens live 1 hour, so any device actually in use
-- refreshes constantly. Prune the caller's idle sessions before listing — deleting
-- the row cascades to its refresh tokens, which is exactly the "signed out after
-- 30 days of inactivity" semantic the list now claims.

CREATE OR REPLACE FUNCTION "public"."get_user_sessions"()
    RETURNS TABLE("id" "uuid", "created_at" timestamp with time zone, "updated_at" timestamp with time zone, "last_active_at" timestamp with time zone, "user_agent" "text", "ip_address" "text", "is_current" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'auth', 'public', 'pg_temp'
    AS $$
DECLARE
    v_current_session_id uuid;
BEGIN
    v_current_session_id := (current_setting('request.jwt.claims', true)::jsonb ->> 'sid')::uuid;

    -- Lazy expiry: drop the caller's sessions idle for 30+ days. Never the current one.
    DELETE FROM auth.sessions s
    WHERE s.user_id = auth.uid()
      AND s.id IS DISTINCT FROM v_current_session_id
      AND COALESCE(s.refreshed_at AT TIME ZONE 'UTC', s.updated_at) < now() - interval '30 days';

    RETURN QUERY
    SELECT
        s.id,
        s.created_at,
        s.updated_at,
        COALESCE(s.refreshed_at AT TIME ZONE 'UTC', s.updated_at) as last_active_at,
        s.user_agent,
        host(s.ip) as ip_address,
        (s.id = v_current_session_id) as is_current
    FROM auth.sessions s
    WHERE s.user_id = auth.uid()
    ORDER BY COALESCE(s.refreshed_at AT TIME ZONE 'UTC', s.updated_at) DESC;
END;
$$;

COMMENT ON FUNCTION "public"."get_user_sessions"() IS 'Active sessions for the current user; prunes sessions idle 30+ days. (v2.0.0)';

-- These functions act on the caller's own auth state; anon has no business calling them.
REVOKE ALL ON FUNCTION "public"."get_user_sessions"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."revoke_user_session"("uuid") FROM "anon";
