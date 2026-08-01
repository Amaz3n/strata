-- invoice_lines was missed by 20260616140000_budget_line_actuals_linkage.sql.
--
-- Every other line table that feeds the job-cost engine (bill_lines,
-- commitment_lines, change_order_lines, commitment_change_order_lines,
-- job_cost_entries, time_entries, project_expense_lines) carries
-- budget_line_id so that projects with cost codes disabled can bucket by
-- budget line instead. getBudgetWithActualsInternal already selects the
-- column on invoice_lines, so the budget summary throws for every project.
--
-- Additive and nullable; cost-code projects are unaffected.

alter table public.invoice_lines
  add column if not exists budget_line_id uuid references public.budget_lines(id) on delete set null;

create index if not exists invoice_lines_budget_line_idx
  on public.invoice_lines (budget_line_id)
  where budget_line_id is not null;
