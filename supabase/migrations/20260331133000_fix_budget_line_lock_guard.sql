create or replace function public.budget_line_lock_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  v_budget_status text;
begin
  select b.status
  into v_budget_status
  from public.budgets b
  where b.id = coalesce(new.budget_id, old.budget_id)
  limit 1;

  if v_budget_status = 'locked' then
    raise exception 'Budget is locked and lines cannot be modified';
  end if;

  return coalesce(new, old);
end;
$function$;
