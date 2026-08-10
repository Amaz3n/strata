-- Arc Books C1 — correctness core.
--
-- Applied to the linked Supabase project on 2026-08-07 with explicit human
-- authorization, after verifying that every existing gl_accounts.subtype and
-- job_cost_entries.source_type value satisfies the new constraints. Additive
-- only and safe for an organization that has already initialized Arc Books.
--
-- 1. Constrains gl_accounts.subtype to the closed set the statements branch on.
--    Free text let a typo silently orphan an account from the balance sheet.
-- 2. Seeds the two accounts C1 introduced (work in progress, early payment
--    discounts) for organizations whose chart was seeded before them.
-- 3. Widens job_cost_entries.source_type to cover project_expense_line, which
--    the cost services already write.

begin;

-- ---------------------------------------------------------------------------
-- 1. Closed subtype vocabulary
-- ---------------------------------------------------------------------------

alter table public.gl_accounts
  drop constraint if exists gl_accounts_subtype_check;

alter table public.gl_accounts
  add constraint gl_accounts_subtype_check check (subtype in (
    'cash',
    'undeposited_funds',
    'accounts_receivable',
    'retainage_receivable',
    'costs_in_excess',
    'work_in_progress',
    'prepaid_expenses',
    'fixed_assets',
    'accumulated_depreciation',
    'other_asset',
    'accounts_payable',
    'retainage_payable',
    'credit_card',
    'payroll_clearing',
    'sales_use_tax',
    'customer_deposits',
    'billings_in_excess',
    'current_debt',
    'long_term_debt',
    'other_liability',
    'owner_equity',
    'owner_contributions',
    'owner_distributions',
    'retained_earnings',
    'construction_revenue',
    'other_revenue',
    'early_pay_discount',
    'job_costs',
    'subcontractor_costs',
    'material_costs',
    'direct_labor',
    'equipment_costs',
    'warranty_costs',
    'rent',
    'insurance',
    'software',
    'professional_fees',
    'utilities',
    'bank_fees',
    'interest',
    'payroll',
    'depreciation',
    'other_expense'
  ));

-- ---------------------------------------------------------------------------
-- 2. Backfill the accounts C1 added, for charts seeded before them
-- ---------------------------------------------------------------------------

insert into public.gl_accounts (org_id, code, name, account_type, subtype, normal_balance, cash_flow_category, is_system, active)
select settings.org_id, seed.code, seed.name, seed.account_type, seed.subtype, seed.normal_balance, seed.cash_flow_category, true, true
from public.books_settings settings
cross join (values
  ('1160', 'Construction in progress', 'asset', 'work_in_progress', 'debit', 'operating'),
  ('4910', 'Early payment discounts', 'income', 'early_pay_discount', 'credit', 'operating')
) as seed(code, name, account_type, subtype, normal_balance, cash_flow_category)
on conflict (org_id, code) do nothing;

-- ---------------------------------------------------------------------------
-- 3. job_cost_entries source types the cost services already write
-- ---------------------------------------------------------------------------

alter table public.job_cost_entries
  drop constraint if exists job_cost_entries_source_type_check;

alter table public.job_cost_entries
  add constraint job_cost_entries_source_type_check check (source_type in (
    'vendor_bill_line',
    'project_expense',
    'project_expense_line',
    'time_entry',
    'manual_adjustment'
  ));

-- Books' projector reads the subledger by source type and org; the existing
-- indexes are project-first, so this supports the projection sweep directly.
create index if not exists job_cost_entries_org_source_type_idx
  on public.job_cost_entries (org_id, source_type, status, updated_at);

commit;
