-- Private, deduplicated native worker choices. Historical memberships remain
-- available for historical payroll; no profile wage/rate values are returned.
create function public.read_books_payroll_workers(p_org_id uuid,p_after uuid default null,p_search text default '',p_limit integer default 50)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if p_org_id is null or p_limit is null or p_limit not between 1 and 50 or p_search is null or length(p_search)>200 then raise exception 'Invalid payroll worker directory request';end if;
 with native as (
  select u.id,coalesce(nullif(u.full_name,''),u.email::text) as name,u.email::text as email,
   array_agg(distinct m.status::text order by m.status::text) as statuses
  from public.memberships m join public.app_users u on u.id=m.user_id
  where m.org_id=p_org_id and (p_after is null or u.id>p_after)
   and (p_search='' or strpos(lower(coalesce(u.full_name,'')||' '||u.email::text),lower(p_search))>0)
  group by u.id,u.full_name,u.email order by u.id limit p_limit+1
 ), page as (select * from native order by id limit p_limit)
 select jsonb_build_object('workers',coalesce((select jsonb_agg(to_jsonb(page) order by id) from page),'[]'::jsonb),
  'nextCursor',case when (select count(*) from native)>p_limit then (select id from page order by id desc limit 1) else null end)
 into result;
 return result;
end;
$$;
revoke all on function public.read_books_payroll_workers(uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.read_books_payroll_workers(uuid,uuid,text,integer) to service_role;
