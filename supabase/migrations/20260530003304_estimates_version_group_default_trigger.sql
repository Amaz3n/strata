-- Ensure every estimate belongs to a version family head by default.
-- A BEFORE INSERT trigger defaults version_group_id to the row's own id when not set,
-- so all insert paths (create, duplicate, template) get a stable family key.
create or replace function public.set_estimate_version_group()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.version_group_id is null then
    new.version_group_id := new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_estimate_version_group on public.estimates;
create trigger trg_set_estimate_version_group
  before insert on public.estimates
  for each row
  execute function public.set_estimate_version_group();
