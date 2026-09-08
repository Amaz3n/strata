-- WS-A3 — close the anon-executable payment RPC.
--
-- `20260804090000_payment_run_scheduling.sql` replaced the five-argument
-- `submit_payment_run_atomic` with a six-argument form that takes a scheduled
-- release date, and revoked execute `from public` only. Supabase grants EXECUTE
-- to `anon` and `authenticated` explicitly, not through `public`, so revoking
-- from `public` left both client roles able to call it — verified in production
-- on 2026-09-01, where it was the only payment RPC with client grants.
--
-- The function is SECURITY INVOKER and `payment_runs` carries no write policy
-- for `authenticated`, so the inner UPDATEs affect zero rows. The exposure is
-- that it still returns a fabricated `{status: 'pending_approval'}` payload to
-- an unauthenticated caller, which is a free description of the run state
-- machine and an invitation to probe for a signature that does write.
--
-- Every other payment RPC already carries the foundation migration's form
-- (`from public, anon, authenticated`); `tests/fintech-payment-guards.test.js`
-- now enforces that form for every new payment function so this cannot recur.

revoke all on function public.submit_payment_run_atomic(uuid, uuid, uuid, text, timestamptz, date)
  from public, anon, authenticated;

grant execute on function public.submit_payment_run_atomic(uuid, uuid, uuid, text, timestamptz, date)
  to service_role;
