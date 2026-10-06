-- STAGED, UNAPPLIED. Supports bounded starts price-book existence probes.
-- Review production index deployment/lock budget before applying.
create index vendor_price_agreements_active_readiness_scope_idx
 on public.vendor_price_agreements(org_id,community_id,division_id)
 where status='active';
