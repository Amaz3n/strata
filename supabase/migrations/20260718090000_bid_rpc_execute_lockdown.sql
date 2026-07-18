-- Bid RPCs are SECURITY DEFINER and only ever invoked through the service-role
-- client (conversions.ts, bids.ts, bid-portal.ts). Supabase's default grants
-- leave them executable by anon/authenticated — revoke that surface.

revoke execute on function public.run_bid_award_conversion(uuid, uuid, uuid, text, uuid[]) from anon, authenticated;
revoke execute on function public.rescind_bid_award(uuid, uuid, uuid, text) from anon, authenticated;
revoke execute on function public.create_bid_submission_version(uuid, uuid, jsonb, jsonb, text, uuid) from anon, authenticated;
revoke execute on function public.record_bid_submission_benchmark(uuid, integer, integer) from anon, authenticated;
