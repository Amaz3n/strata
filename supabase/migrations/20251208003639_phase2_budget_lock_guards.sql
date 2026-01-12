-- Budget lock guards
create or replace function budget_lock_guard()
returns trigger as $$
begin
  if old.status = 'locked' then
    if new.status <> 'locked'
      or new.total_cents is distinct from old.total_cents
      or new.project_id is distinct from old.project_id
      or new.metadata is distinct from old.metadata then
      raise exception 'Budget is locked and cannot be edited';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_budget_lock_guard on budgets;
create trigger trg_budget_lock_guard
  before update on budgets
  for each row execute procedure budget_lock_guard();

create or replace function budget_line_lock_guard()
returns trigger as $$
declare
  status text;
begin
  select status into status from budgets where id = coalesce(new.budget_id, old.budget_id) limit 1;
  if status = 'locked' then
    raise exception 'Budget is locked and lines cannot be modified';
  end if;
  return coalesce(new, old);
end;
$$ language plpgsql;

drop trigger if exists trg_budget_line_lock_guard on budget_lines;
create trigger trg_budget_line_lock_guard
  before insert or update or delete on budget_lines
  for each row execute procedure budget_line_lock_guard();
;
