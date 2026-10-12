-- Drop lot_takedowns.deposit_cents.
--
-- GATED, DESTRUCTIVE: this deletes a column. It lives in pending-migrations and
-- must not be applied, moved into migrations/, or swept in by a blanket db push
-- until a human approves it, after 20261012090000_land_contracts.sql is applied
-- and the application that no longer reads the column is deployed.
--
-- A takedown carried one deposit figure with no due date, refundability or
-- receipt. Deposits are now a land contract's schedule (land_contract_deposits),
-- credited against the takedown they are tied to when it closes, and no code
-- reads or writes this column. Production held no takedown with a deposit when
-- the schedule shipped, so nothing is carried over.
--
-- Precondition, checked here so the drop cannot discard a figure someone typed
-- in after the check above was made.

do $$
begin
  if exists (select 1 from public.lot_takedowns where deposit_cents > 0) then
    raise exception 'A takedown still records a deposit; move it onto its land contract''s deposit schedule first';
  end if;
end
$$;

alter table public.lot_takedowns drop column if exists deposit_cents;
