-- The refresh RPC was gated to service_role, but every app call site invokes it
-- through the user's (authenticated) client, so the refresh silently failed and
-- the sheets list MV went stale (deleted sheets lingered => "Drawing sheet not
-- found" on re-delete). The function is SECURITY DEFINER so it can refresh the MV
-- regardless of caller role; just allow authenticated callers too.
CREATE OR REPLACE FUNCTION public.refresh_drawing_sheets_list()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.role() NOT IN ('authenticated', 'service_role') THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  REFRESH MATERIALIZED VIEW public.drawing_sheets_list_mv;
END;
$function$;
