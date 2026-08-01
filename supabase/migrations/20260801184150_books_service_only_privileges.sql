-- Supabase projects with legacy default privileges grant public-schema tables
-- to API roles at creation time. These three tables contain provider/vault
-- references and raw feed metadata, so RLS is defense in depth rather than the
-- only boundary: ordinary API roles receive no table privileges at all.

revoke all privileges on table public.bank_feed_connections from anon, authenticated;
revoke all privileges on table public.bank_feed_events from anon, authenticated;
revoke all privileges on table public.tax_identity_refs from anon, authenticated;

grant all privileges on table public.bank_feed_connections to service_role;
grant all privileges on table public.bank_feed_events to service_role;
grant all privileges on table public.tax_identity_refs to service_role;
