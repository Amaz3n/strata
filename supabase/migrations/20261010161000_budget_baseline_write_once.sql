-- A house's original margin is the number every later variance is measured
-- against, so the budget baseline is write-once. lockBudgetBaseline used to
-- overwrite `baseline_lines` on every press of "Re-baseline", which let the
-- original margin of a production home be rewritten after the fact. A revised
-- baseline is a new budget version, which starts without one.
--
-- `baseline_locked_by` is excluded: its foreign key to auth.users sets it null
-- when the locking user is deleted, and that is not a rewrite of the baseline.

create or replace function public.tg_budgets_baseline_write_once()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if old.baseline_locked_at is not null
     and (new.baseline_lines is distinct from old.baseline_lines
          or new.baseline_locked_at is distinct from old.baseline_locked_at) then
    raise exception 'A locked budget baseline cannot be changed. Create a new budget version to set a revised baseline.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists budgets_baseline_write_once on public.budgets;
create trigger budgets_baseline_write_once
  before update of baseline_lines, baseline_locked_at on public.budgets
  for each row execute function public.tg_budgets_baseline_write_once();

revoke all on function public.tg_budgets_baseline_write_once() from public, anon, authenticated;
