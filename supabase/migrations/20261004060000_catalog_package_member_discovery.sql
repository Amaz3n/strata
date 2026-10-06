-- STAGED / UNAPPLIED. Read foundation; UI cutover and scale plans remain gated.
create index catalog_member_option_scope_idx on public.selection_options(org_id,community_id,id);
create index catalog_member_option_override_idx on public.selection_options(org_id,community_id,parent_option_id) where parent_option_id is not null;
create index catalog_member_category_override_idx on public.selection_categories(org_id,community_id,parent_category_id) where parent_category_id is not null;
create function public.discover_catalog_package_members(p_org_id uuid,p_actor_id uuid,p_community_id uuid,p_query text default '',p_before uuid default null,p_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare items jsonb; continuation uuid; needle text:=lower(btrim(coalesce(p_query,''))); pattern text;
begin
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id);
 if length(needle)>200 or p_ids is not null and (cardinality(p_ids)>100 or cardinality(p_ids)<>(select count(distinct x) from unnest(p_ids) x) or p_before is not null or needle<>'') then raise exception 'Bounded catalog member discovery required';end if;
 pattern:='%'||replace(replace(replace(needle,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%';
 with candidates as not materialized (
  select o.id,o.name,c.id source_category_id,c.parent_category_id,c.name source_category_name,
   coalesce(override.id,c.id) category_id,coalesce(override.parent_category_id,c.parent_category_id,c.id) category_key,
   coalesce(override.name,c.name) category_name,
   not o.is_archived and o.is_available and c.id is not null and not c.is_archived and not coalesce(override.is_archived,false) and (override.id is null or c.community_id is null)
    and (o.parent_option_id is null or o.community_id is not null and exists(select 1 from public.selection_options parent where parent.org_id=p_org_id and parent.id=o.parent_option_id and parent.community_id is null and parent.category_id=coalesce(c.parent_category_id,c.id)))
    and not exists(select 1 from public.selection_options other where other.org_id=p_org_id and other.community_id=p_community_id and other.parent_option_id=o.id)
    and (c.parent_category_id is null or exists(select 1 from public.selection_categories base where base.org_id=p_org_id and base.id=c.parent_category_id and base.community_id is null and c.community_id is not null)) available
  from public.selection_options o
  left join public.selection_categories c on c.org_id=p_org_id and c.id=o.category_id and (c.community_id is null or c.community_id=p_community_id)
  left join lateral (select k.* from public.selection_categories k where k.org_id=p_org_id and k.community_id=p_community_id and k.parent_category_id=c.id order by k.id limit 1) override on true
  where o.org_id=p_org_id and (o.community_id is null or o.community_id=p_community_id)
   and (p_ids is null or o.id=any(p_ids)) and (p_before is null or o.id>p_before)
 ), result_rows as (
  select c.id,c.name,c.category_id,c.category_key,c.category_name,c.available
  from candidates c where p_ids is null and c.available and (needle='' or lower(c.name) like pattern or lower(c.category_name) like pattern or c.id::text like pattern)
  order by c.id limit 21
 ), selected_rows as (
  select x.id,c.name,c.category_id,c.category_key,c.category_name,coalesce(c.available,false) available from unnest(p_ids) x(id) left join candidates c on c.id=x.id
 ), numbered as (
  select *,row_number() over(order by id) position from (select * from result_rows union all select * from selected_rows) combined
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',left(name,200),'categoryId',category_id,'categoryKey',category_key,'categoryName',left(category_name,200),'available',available) order by id) filter(where p_ids is not null or position<=20),'[]'::jsonb),
  case when p_ids is null and max(position)=21 then (array_agg(id order by id))[20] else null end
 into items,continuation from numbered;
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'communityId',p_community_id,'query',needle,'selectedIds',to_jsonb(p_ids),'items',items,'nextCursor',continuation);
end $$;
revoke all on function public.discover_catalog_package_members(uuid,uuid,uuid,text,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.discover_catalog_package_members(uuid,uuid,uuid,text,uuid,uuid[]) to service_role;
