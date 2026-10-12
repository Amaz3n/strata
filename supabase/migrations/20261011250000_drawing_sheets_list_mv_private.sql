-- drawing_sheets_list_mv is a materialized view: row-level security does not
-- apply to it, yet it was readable by anon and authenticated (recreating it in
-- 20260610210000/20260610220000 picked up the schema's default grants). It holds
-- every organization's sheet titles, numbers and preview URLs, so anyone with the
-- public anon key could list them through the Data API.
--
-- Nothing in the application reads it; it is only refreshed, through
-- refresh_drawing_sheets_list(), which runs as the view's owner. Only the
-- service role keeps access.

revoke all on public.drawing_sheets_list_mv from public, anon, authenticated;
grant select on public.drawing_sheets_list_mv to service_role;
