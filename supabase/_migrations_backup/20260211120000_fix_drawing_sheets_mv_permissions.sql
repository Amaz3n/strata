-- Ensure optimized drawings sheets list can be queried by service role.
-- This supports server-side reads against the denormalized MV.

GRANT SELECT ON TABLE public.drawing_sheets_list_mv TO service_role;
GRANT SELECT ON TABLE public.drawing_sheets_list TO authenticated;
