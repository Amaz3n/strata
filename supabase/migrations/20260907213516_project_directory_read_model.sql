-- Internal read models: application services authorize the actor and supply scope.
-- No browser role may call these functions, even with forged scope arguments.
create or replace function public.get_project_directory_schedule_summaries(
  p_org_id uuid, p_project_ids uuid[] default null
) returns table(project_id uuid, percent integer, total bigint, completed bigint, in_progress bigint, upcoming bigint)
language sql stable security invoker set search_path = '' as $$
  select s.project_id,
    round(sum(greatest(1, coalesce(s.end_date - s.start_date, 1))::numeric *
      case when s.status = 'completed' then 100 else least(100, greatest(0, coalesce(s.progress, 0))) end)
      / nullif(sum(greatest(1, coalesce(s.end_date - s.start_date, 1))), 0))::integer,
    count(*), count(*) filter (where s.status = 'completed'),
    count(*) filter (where s.status in ('in_progress', 'at_risk', 'blocked')),
    count(*) filter (where coalesce(s.status, 'planned') = 'planned')
  from public.schedule_items s
  where s.org_id = p_org_id and s.project_id is not null
    and (p_project_ids is null or s.project_id = any(p_project_ids))
    and s.status is distinct from 'cancelled'
  group by s.project_id
$$;

create or replace function public.get_project_directory_page(
  p_org_id uuid, p_user_id uuid, p_all_projects boolean, p_division_ids uuid[],
  p_community_id uuid default null, p_division_id uuid default null,
  p_exclude_reporting boolean default false, p_search text default '',
  p_status text default 'all', p_sort text default 'name', p_direction text default 'asc',
  p_cursor jsonb default null, p_limit integer default 51
) returns table(
  id uuid, name text, status text, address text, client_name text, value_cents bigint,
  summary jsonb, sort_text text, sort_number numeric
)
language sql stable security invoker set search_path = '' as $$
  with candidates as (
    select p.id, p.name, p.status::text as status,
      coalesce(p.location->>'address', p.location->>'formatted', '') as address,
      coalesce(c.full_name, '') as client_name,
      coalesce(contract.total_cents, p.total_value::bigint * 100) as value_cents,
      case when p_sort = 'progress' and schedule.total > 0 then to_jsonb(schedule) - 'project_id' end as summary,
      case p_sort when 'client' then coalesce(c.full_name, '')
        when 'status' then p.status::text when 'name' then p.name else '' end as sort_text,
      case p_sort when 'value' then coalesce(contract.total_cents, p.total_value::bigint * 100, -1)::numeric
        when 'progress' then coalesce(schedule.percent, -1)::numeric else 0::numeric end as sort_number
    from public.projects p
    left join public.contacts c on c.id = p.client_id and c.org_id = p.org_id
    left join lateral (
      select ct.total_cents from public.contracts ct
      where ct.org_id = p.org_id and ct.project_id = p.id
      order by (ct.status = 'active') desc, ct.created_at desc, ct.id desc limit 1
    ) contract on true
    left join lateral (
      select * from public.get_project_directory_schedule_summaries(p.org_id, array[p.id])
      where p_sort = 'progress'
    ) schedule on true
    where p.org_id = p_org_id and p.phase = 'delivery'
      and (p_division_ids is null or p.division_id = any(p_division_ids))
      and (p_all_projects or exists (
        select 1 from public.project_members pm where pm.org_id = p.org_id
          and pm.project_id = p.id and pm.user_id = p_user_id and pm.status = 'active'
      ))
      and (p_division_id is null or p.division_id = p_division_id)
      and (p_community_id is null or exists (
        select 1 from public.lots l where l.org_id = p.org_id
          and l.project_id = p.id and l.community_id = p_community_id
      ))
      and (not p_exclude_reporting or not coalesce(p.excluded_from_reporting, false))
      and (p_status = 'all' or p.status::text = p_status)
      -- Literal substring semantics, including % and _, match the previous client search.
      and (p_search = '' or strpos(lower(p.name), lower(p_search)) > 0
        or strpos(lower(coalesce(p.location->>'address', p.location->>'formatted', '')), lower(p_search)) > 0)
  )
  select * from candidates d
  where p_cursor is null or case when p_direction = 'desc' then
    (d.sort_text, d.sort_number, d.name, d.id) <
      (p_cursor->>'text', (p_cursor->>'number')::numeric, p_cursor->>'name', (p_cursor->>'id')::uuid)
    else (d.sort_text, d.sort_number, d.name, d.id) >
      (p_cursor->>'text', (p_cursor->>'number')::numeric, p_cursor->>'name', (p_cursor->>'id')::uuid) end
  order by
    case when p_direction = 'asc' then d.sort_text end asc,
    case when p_direction = 'asc' then d.sort_number end asc,
    case when p_direction = 'asc' then d.name end asc,
    case when p_direction = 'asc' then d.id end asc,
    case when p_direction = 'desc' then d.sort_text end desc,
    case when p_direction = 'desc' then d.sort_number end desc,
    case when p_direction = 'desc' then d.name end desc,
    case when p_direction = 'desc' then d.id end desc
  limit least(101, greatest(1, p_limit))
$$;

revoke all on function public.get_project_directory_page(uuid,uuid,boolean,uuid[],uuid,uuid,boolean,text,text,text,text,jsonb,integer) from public, anon, authenticated;
grant execute on function public.get_project_directory_page(uuid,uuid,boolean,uuid[],uuid,uuid,boolean,text,text,text,text,jsonb,integer) to service_role;
revoke all on function public.get_project_directory_schedule_summaries(uuid,uuid[]) from public, anon, authenticated;
grant execute on function public.get_project_directory_schedule_summaries(uuid,uuid[]) to service_role;

create index if not exists projects_directory_name_idx on public.projects (org_id, name, id) where phase = 'delivery';
create index if not exists schedule_items_directory_summary_idx on public.schedule_items (org_id, project_id)
  include (status, start_date, end_date, progress) where status is distinct from 'cancelled';
