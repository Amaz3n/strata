-- Budget baseline lock:
-- a project can "lock" its budget to freeze a baseline (the original amount per
-- line at lock time). The Detailed budget view then shows Original (baseline) vs
-- Revised so drift is visible, and re-baselining overwrites the snapshot.
--
-- Stored on the budgets row (not budget_lines) because replaceBudgetLines
-- recreates line rows on every edit; the budget row itself is stable. All
-- columns are nullable and additive — existing budgets keep their current
-- behavior (Original falls back to the live base amount when no baseline is set).

alter table public.budgets
  add column if not exists baseline_locked_at timestamptz,
  add column if not exists baseline_locked_by uuid references auth.users(id) on delete set null,
  add column if not exists baseline_lines jsonb;

comment on column public.budgets.baseline_lines is
  'Frozen snapshot of budget lines at lock time: array of { cost_code_id, description, amount_cents }.';
