-- No-cost-code budget tracking:
-- when a project disables cost codes, budget lines themselves become the cost
-- bucket. To keep the existing job-cost / WIP engine working we let costs and
-- commitments tag a specific budget_line directly (parallel to cost_code_id).
--
-- All columns are nullable and additive; cost-code projects are unaffected.

alter table public.job_cost_entries
  add column if not exists budget_line_id uuid references public.budget_lines(id) on delete set null;

alter table public.bill_lines
  add column if not exists budget_line_id uuid references public.budget_lines(id) on delete set null;

alter table public.project_expenses
  add column if not exists budget_line_id uuid references public.budget_lines(id) on delete set null;

alter table public.project_expense_lines
  add column if not exists budget_line_id uuid references public.budget_lines(id) on delete set null;

alter table public.time_entries
  add column if not exists budget_line_id uuid references public.budget_lines(id) on delete set null;

alter table public.commitment_lines
  add column if not exists budget_line_id uuid references public.budget_lines(id) on delete set null;

-- Lookups when grouping actuals/commitments by budget line.
create index if not exists job_cost_entries_org_project_budget_line_idx
  on public.job_cost_entries (org_id, project_id, budget_line_id)
  where budget_line_id is not null;

create index if not exists bill_lines_budget_line_idx
  on public.bill_lines (budget_line_id)
  where budget_line_id is not null;

create index if not exists project_expenses_budget_line_idx
  on public.project_expenses (budget_line_id)
  where budget_line_id is not null;

create index if not exists project_expense_lines_budget_line_idx
  on public.project_expense_lines (budget_line_id)
  where budget_line_id is not null;

create index if not exists time_entries_budget_line_idx
  on public.time_entries (budget_line_id)
  where budget_line_id is not null;

create index if not exists commitment_lines_budget_line_idx
  on public.commitment_lines (budget_line_id)
  where budget_line_id is not null;
