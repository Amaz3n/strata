-- Keep billing period foreign-key checks efficient.
-- The app query indexes lead with org/project; these lead with the FK columns
-- so Postgres can cheaply validate period updates/deletes.

create index if not exists invoices_billing_period_fk_idx
  on public.invoices (billing_period_id)
  where billing_period_id is not null;

create index if not exists billable_costs_billing_period_fk_idx
  on public.billable_costs (billing_period_id)
  where billing_period_id is not null;

create index if not exists billable_costs_late_to_billing_period_fk_idx
  on public.billable_costs (late_to_billing_period_id)
  where late_to_billing_period_id is not null;
