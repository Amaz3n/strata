-- Defence in depth on the answer cache.
--
-- Applied 2026-08-08, immediately after the table was created.
--
-- This project's default privileges grant every client role full access to new
-- public tables, and RLS is what actually enforces anything — `payment_runs`,
-- `ai_usage_events` and the rest all look the same way.
-- `ai_search_answer_cache` was created with RLS on and NO policy, so
-- `authenticated` and `anon` are already denied.
--
-- But that safety rests entirely on the ABSENCE of a policy. This is the one
-- table in the schema whose row visibility is defined by whose PERMISSIONS
-- computed the row rather than by org membership, so the next person to add
-- "just a read policy" would be handing one member answers computed under
-- another member's clearance. Revoking the grants makes the denial structural.
--
-- Nothing legitimate loses access: only the service role touches this table, and
-- it bypasses RLS regardless. Deliberately NOT applied to
-- `ai_standing_questions`, where members are supposed to manage their own org's
-- questions through the org-member policy.

begin;

revoke all on table public.ai_search_answer_cache from authenticated;
revoke all on table public.ai_search_answer_cache from anon;

commit;
