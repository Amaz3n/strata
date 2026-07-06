-- Inspect and repair legacy billing model mismatches after Phase 1.
-- Run manually after reviewing the SELECT output; project_financial_settings
-- is authoritative for the model, so this only removes stale snapshot values.

with mismatches as (
  select
    c.id as contract_id,
    c.org_id,
    c.project_id,
    c.snapshot->>'billing_model' as snapshot_billing_model,
    pfs.billing_model as settings_billing_model
  from public.contracts c
  join public.project_financial_settings pfs
    on pfs.org_id = c.org_id
   and pfs.project_id = c.project_id
  where c.snapshot ? 'billing_model'
    and c.snapshot->>'billing_model' is distinct from pfs.billing_model
)
select *
from mismatches
order by org_id, project_id;

-- Uncomment after the mismatches above have been reviewed.
--
-- with mismatches as (
--   select c.id as contract_id
--   from public.contracts c
--   join public.project_financial_settings pfs
--     on pfs.org_id = c.org_id
--    and pfs.project_id = c.project_id
--   where c.snapshot ? 'billing_model'
--     and c.snapshot->>'billing_model' is distinct from pfs.billing_model
-- )
-- update public.contracts c
-- set snapshot = c.snapshot - 'billing_model'
-- from mismatches m
-- where c.id = m.contract_id;
