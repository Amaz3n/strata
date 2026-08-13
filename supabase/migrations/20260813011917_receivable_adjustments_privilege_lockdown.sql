begin;

-- Broad default table grants include TRUNCATE, which is not governed by RLS.
-- Builder sessions only read posted adjustments; every mutation stays behind
-- the service-role atomic RPCs.
revoke all privileges on table public.receivable_adjustments from anon, authenticated;
grant select on table public.receivable_adjustments to authenticated;

commit;
