-- EP06 selection review fixes, round 2.
--
-- 1. The reminder sweep pages through the candidate groups instead of silently
--    stopping at a fixed limit: the function takes an offset over a stable order.
-- 2. A change order's metadata is merged into by patch, in the database, so a
--    completion stamp written from an earlier read cannot erase what an outbox
--    job stamped in between.

drop function if exists public.selection_cutoff_reminder_groups(integer[], integer);

create or replace function public.selection_cutoff_reminder_groups(p_days integer[], p_limit integer, p_offset integer default 0)
returns table (
  id uuid, org_id uuid, project_id uuid, group_id uuid, cutoff_date date, metadata jsonb,
  days_remaining integer, group_name text, project_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, g.org_id, g.project_id, g.group_id, g.cutoff_date, g.metadata,
    (g.cutoff_date - public.project_selection_today(g.org_id, g.project_id))::integer,
    sg.name, p.name
  from public.project_selection_groups g
  join public.selection_groups sg on sg.id = g.group_id
  join public.projects p on p.id = g.project_id and p.org_id = g.org_id
  where g.status = 'open'
    -- No zone is more than a day from UTC, so this bounds the candidates.
    and g.cutoff_date between (now() at time zone 'UTC')::date - 1 and (now() at time zone 'UTC')::date + (select coalesce(max(d), 0) from unnest(p_days) d) + 1
    and (g.cutoff_date - public.project_selection_today(g.org_id, g.project_id))::integer = any(p_days)
  order by g.cutoff_date, g.id
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.selection_cutoff_reminder_groups(integer[], integer, integer) from public, anon, authenticated;
grant execute on function public.selection_cutoff_reminder_groups(integer[], integer, integer) to service_role;

create or replace function public.merge_change_order_metadata(p_org_id uuid, p_change_order_id uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.change_orders
    set metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb)
    where org_id = p_org_id and id = p_change_order_id;
  if not found then
    raise exception 'Change order not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.merge_change_order_metadata(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.merge_change_order_metadata(uuid, uuid, jsonb) to service_role;
