-- EP06 review round 3 (selections).
--  * A member cannot re-point a selection to another category: group_id is
--    derived from the category, so moving one leaves the row judged against the
--    wrong deadline group.
--  * An applied selection change order cannot be voided by any caller; the
--    void RPC runs as definer for members, so the refusal sits on the row.
--  * project_selection_group_is_open answers a signed-in caller only for an org
--    they belong to; service and definer paths are unchanged.

create or replace function public.tg_project_selections_category_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and new.category_id is distinct from old.category_id then
    raise exception 'A selection stays in its category; withdraw it and open a new one' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_project_selections_category_guard() from public, anon, authenticated;

drop trigger if exists project_selections_category_guard on public.project_selections;
create trigger project_selections_category_guard
  before update of category_id on public.project_selections
  for each row execute function public.tg_project_selections_category_guard();

create or replace function public.tg_change_order_applied_selection_void_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.lifecycle = 'approved'
     and new.lifecycle = 'void'
     and coalesce(old.metadata, '{}'::jsonb) ? 'selection_change' then
    raise exception 'An applied selection change order cannot be voided; reverse it with a new change order' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_change_order_applied_selection_void_guard() from public, anon, authenticated;

drop trigger if exists change_orders_applied_selection_void_guard on public.change_orders;
create trigger change_orders_applied_selection_void_guard
  before update of lifecycle on public.change_orders
  for each row execute function public.tg_change_order_applied_selection_void_guard();

create or replace function public.project_selection_group_is_open(p_org_id uuid, p_project_id uuid, p_group_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- A definer function runs as its owner, so a signed-in caller is told by the
  -- session's user, not current_user; service and job paths carry none.
  if (select auth.uid()) is not null and not public.is_org_member(p_org_id) then
    return false;
  end if;
  return coalesce((
    select g.status = 'open' and (g.cutoff_date is null or g.cutoff_date >= public.project_selection_today(p_org_id, p_project_id))
    from public.project_selection_groups g
    where g.org_id = p_org_id and g.project_id = p_project_id and g.group_id = p_group_id
  ), true);
end;
$$;

revoke all on function public.project_selection_group_is_open(uuid, uuid, uuid) from public, anon;
grant execute on function public.project_selection_group_is_open(uuid, uuid, uuid) to authenticated, service_role;
