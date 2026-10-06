-- STAGED / UNAPPLIED. Requires catalog publication actor/source foundations.
create index catalog_package_archived_scope_idx on public.selection_packages(org_id,community_id,id desc) where is_archived;
create function public.list_archived_catalog_packages(p_org_id uuid,p_actor_id uuid,p_community_id uuid,p_before uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare row public.selection_packages; rows jsonb:='[]'; continuation uuid; last_visible uuid; can_margin boolean:=false; source jsonb;
begin
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id);
 begin perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id,'financials.margin.read');can_margin:=true;exception when insufficient_privilege then can_margin:=false;end;
 for row in select * from public.selection_packages where org_id=p_org_id and community_id is not distinct from p_community_id and is_archived and (p_before is null or id<p_before) order by id desc limit 26 loop
  if jsonb_array_length(rows)=25 then continuation:=last_visible;exit;end if;
  source:=public.catalog_package_source(row);
  rows:=rows||jsonb_build_array(case when can_margin then source else source-'cost_cents' end);last_visible:=row.id;
 end loop;
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'communityId',p_community_id,'packages',rows,'canReadMargin',can_margin,'nextCursor',continuation);
end $$;
revoke all on function public.list_archived_catalog_packages(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_archived_catalog_packages(uuid,uuid,uuid,uuid) to service_role;
