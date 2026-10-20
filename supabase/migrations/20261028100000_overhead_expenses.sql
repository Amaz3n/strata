-- TR05-01 Overhead and job-optional expenses.
--
-- A trade's fuel, tools and shop supplies are real costs that belong to no job.
-- An expense now either carries a job (job cost, as before) or sits in overhead
-- with a category that decides its operating-expense account in Books. A receipt
-- captured in the field with neither is "unsorted": it can be reviewed and
-- assigned, but never approved, so nothing reaches the ledger without a home.
--
-- 1. project_expenses.project_id becomes optional; overhead_category is added.
-- 2. Guards: a job expense has no overhead category, and an approved or locked
--    expense has a job or a category.
-- 3. Books: operating-expense accounts the overhead categories post to, for
--    existing Books orgs (new orgs get them from CONSTRUCTION_CHART_TEMPLATE in
--    lib/services/books/chart-of-accounts.ts).
--
-- Row security already admits project_id is null (project_expenses_division_scope),
-- and the desk rollup, Books touch and reassignment-guard functions are null-safe.

-- ---------------------------------------------------------------------------
-- 1. Columns.
-- ---------------------------------------------------------------------------

alter table public.project_expenses
  alter column project_id drop not null;

alter table public.project_expenses
  add column if not exists overhead_category text;

-- The category list moves together with OVERHEAD_CATEGORIES (lib/financials/overhead.ts).
alter table public.project_expenses
  add constraint project_expenses_overhead_category_check check (
    overhead_category is null or overhead_category in (
      'fuel_vehicles', 'tools_equipment', 'shop_supplies', 'meals_travel',
      'software', 'insurance', 'rent', 'utilities', 'professional_fees', 'other'
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Guards.
-- ---------------------------------------------------------------------------

alter table public.project_expenses
  add constraint project_expenses_job_or_overhead check (
    project_id is null or overhead_category is null
  );

alter table public.project_expenses
  add constraint project_expenses_posted_has_home check (
    status not in ('approved', 'locked')
    or project_id is not null
    or overhead_category is not null
  );

create index if not exists project_expenses_overhead_idx
  on public.project_expenses (org_id, expense_date desc)
  where project_id is null;

-- ---------------------------------------------------------------------------
-- 3. Books accounts.
-- ---------------------------------------------------------------------------

insert into public.gl_accounts (org_id, code, name, account_type, subtype, normal_balance, cash_flow_category, is_system, active)
select s.org_id, a.code, a.name, 'expense', 'other_expense', 'debit', 'operating', true, true
from public.books_settings s
cross join (values
  ('6200', 'Vehicles and fuel'),
  ('6210', 'Tools and small equipment'),
  ('6220', 'Shop and office supplies'),
  ('6230', 'Meals and travel')
) a(code, name)
on conflict (org_id, code) do nothing;
