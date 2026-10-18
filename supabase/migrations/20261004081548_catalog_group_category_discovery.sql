-- STAGED / UNAPPLIED. Requires current catalog actor authorization foundations.
-- Public category discovery is independent of the capped catalog bootstrap.
create index catalog_group_category_scope_seek_idx on public.selection_categories(org_id,community_id,id);
create function public.discover_catalog_group_categories(p_org_id uuid,p_actor_id uuid,p_community_id uuid,p_query text default '',p_before uuid default null,p_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare items jsonb; continuation uuid; needle text:=lower(btrim(coalesce(p_query,''))); pattern text;
begin
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id);
 if length(needle)>200 or p_ids is not null and (cardinality(p_ids)>100 or array_ndims(p_ids)>1
  or exists(select 1 from unnest(p_ids) x where x is null)
  or cardinality(p_ids)<>(select count(distinct x) from unnest(p_ids) x)
  or p_before is not null or needle<>'') then raise exception 'Bounded category discovery required';end if;
 pattern:='%'||replace(replace(replace(needle,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%';
 with candidates as not materialized (
  select c.id,to_jsonb(c)->>'name' name,c.id category_id,coalesce(c.parent_category_id,c.id) category_key,
   coalesce(to_jsonb(parent)->>'name',to_jsonb(c)->>'name') category_name,
   not c.is_archived and (c.parent_category_id is null or c.community_id is not null and parent.id is not null and not parent.is_archived) available
  from public.selection_categories c
  left join public.selection_categories parent on parent.org_id=p_org_id and parent.id=c.parent_category_id and parent.community_id is null and parent.parent_category_id is null
  where c.org_id=p_org_id and (c.community_id is null or c.community_id=p_community_id)
   and (p_ids is null or c.id=any(p_ids)) and (p_before is null or c.id>p_before)
 ), result_rows as (
  select * from candidates c where p_ids is null and c.available and (needle='' or lower(c.name) like pattern or lower(c.category_name) like pattern or c.id::text like pattern)
  order by c.id limit 21
 ), selected_rows as (
  select x.id,c.name,c.category_id,c.category_key,c.category_name,coalesce(c.available,false) available
  from unnest(p_ids) x(id) left join candidates c on c.id=x.id
 ), numbered as (
  select *,row_number() over(order by id) position from (select * from result_rows union all select * from selected_rows) combined
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',left(name,200),'categoryId',category_id,'categoryKey',category_key,'categoryName',left(category_name,200),'available',available) order by id)
  filter(where p_ids is not null or position<=20),'[]'::jsonb),
  case when p_ids is null and max(position)=21 then (array_agg(id order by id))[20] else null end
 into items,continuation from numbered;
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'communityId',p_community_id,'query',needle,'selectedIds',to_jsonb(p_ids),'items',items,'nextCursor',continuation);
end $$;
revoke all on function public.discover_catalog_group_categories(uuid,uuid,uuid,text,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.discover_catalog_group_categories(uuid,uuid,uuid,text,uuid,uuid[]) to service_role;

-- The visible rule register needs names for its own references, not all headers.
create function public.read_catalog_group_category_labels(p_org_id uuid,p_actor_id uuid,p_community_id uuid,p_group_ids uuid[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare labels jsonb;
begin
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id,'selections.read');
 if p_group_ids is null or cardinality(p_group_ids)>25 or array_ndims(p_group_ids)>1
  or exists(select 1 from unnest(p_group_ids) x where x is null)
  or cardinality(p_group_ids)<>(select count(distinct x) from unnest(p_group_ids) x) then raise exception 'Visible bounded rule references required';end if;
 if exists(select 1 from public.selection_group_categories m join public.selection_groups g on g.org_id=m.org_id and g.id=m.group_id
  where g.org_id=p_org_id and g.id=any(p_group_ids) and not g.is_archived and (g.community_id is null or g.community_id=p_community_id)
  group by g.id having count(*)>100) then raise exception 'Rule assignment review bound exceeded';end if;
 with references_set as (
  select distinct m.category_id from public.selection_group_categories m join public.selection_groups g on g.org_id=m.org_id and g.id=m.group_id
  where g.org_id=p_org_id and g.id=any(p_group_ids) and not g.is_archived and (g.community_id is null or g.community_id=p_community_id)
 ) select coalesce(jsonb_agg(jsonb_build_object('id',r.category_id,'name',left(case when c.is_archived or coalesce(override.is_archived,false) then null else coalesce(to_jsonb(override)->>'name',to_jsonb(c)->>'name') end,200)) order by r.category_id),'[]') into labels
 from references_set r
 left join public.selection_categories c on c.org_id=p_org_id and c.id=r.category_id and (c.community_id is null or c.community_id=p_community_id)
 left join lateral (select k.* from public.selection_categories k where k.org_id=p_org_id and k.community_id=p_community_id and k.parent_category_id=c.id order by k.id limit 1) override on true;
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'communityId',p_community_id,'labels',labels);
end $$;
revoke all on function public.read_catalog_group_category_labels(uuid,uuid,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.read_catalog_group_category_labels(uuid,uuid,uuid,uuid[]) to service_role;
