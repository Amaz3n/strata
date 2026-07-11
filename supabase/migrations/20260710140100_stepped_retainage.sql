-- Workstream 02: stepped retainage schedule on prime contracts.
-- JSON schedule, steps ordered by until_percent_complete ascending:
--   [{"until_percent_complete": 50, "retainage_percent": 10},
--    {"until_percent_complete": 100, "retainage_percent": 5}]
-- Null schedule falls back to contracts.retainage_percent (flat rate).

alter table public.contracts
  add column if not exists retainage_schedule jsonb,
  add column if not exists stored_materials_retainage_percent numeric(5,2);

alter table public.contracts
  drop constraint if exists contracts_stored_materials_retainage_percent_check,
  add constraint contracts_stored_materials_retainage_percent_check
    check (
      stored_materials_retainage_percent is null
      or (stored_materials_retainage_percent >= 0 and stored_materials_retainage_percent <= 100)
    );
