-- STAGED / UNAPPLIED. Requires the complete catalog intent/history chain.
-- This is a live own-actor queue, not an immutable historical snapshot. Refresh
-- newest after changes; absence never proves an in-flight publication failed.
create index catalog_intent_actor_pending_order_idx on public.catalog_publication_intents(org_id,actor_id,created_at desc,id desc);

create function public.can_review_catalog_publication_scope(p_org_id uuid,p_actor_id uuid,p_community_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id);
 return true;
exception when insufficient_privilege then return false;
end $$;
revoke all on function public.can_review_catalog_publication_scope(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.list_pending_catalog_publications(p_org_id uuid,p_actor_id uuid,p_before uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare boundary public.catalog_publication_intents; candidate record; rows jsonb:='[]'::jsonb; continuation uuid; last_visible uuid; community_name text;
begin
 if p_org_id is null or p_actor_id is null then raise exception 'Publication queue context required' using errcode='42501';end if;
 if p_before is not null then
  select * into boundary from public.catalog_publication_intents where org_id=p_org_id and actor_id=p_actor_id and id=p_before;
  if not found or not public.can_review_catalog_publication_scope(p_org_id,p_actor_id,(boundary.request->>'communityId')::uuid) then raise exception 'Queue continuation is unavailable; refresh newest requests' using errcode='42501';end if;
 end if;
 -- Sort the bounded-by-active-claims source before calling authorization.
 -- A WHERE authorization predicate before an ORDER BY could check every claim
 -- even when the first 26 sorted requests are already accessible.
 for candidate in
  with active_claims as materialized (
   select * from public.catalog_publication_claims where org_id=p_org_id and actor_id=p_actor_id
  )
  select i.id,i.request_key,i.kind,i.created_at,(i.request->>'communityId')::uuid community_id,
   case when i.kind='package' then 1 else jsonb_array_length(i.request->'items') end item_count
  from active_claims claim
  join public.catalog_publication_intents i on claim.org_id=i.org_id and claim.actor_id=i.actor_id and claim.intent_id=i.id and claim.kind=i.kind and claim.scope_key=coalesce((i.request->>'communityId')::uuid::text,'org')
  where i.org_id=p_org_id and i.actor_id=p_actor_id and (p_before is null or (i.created_at,i.id)<(boundary.created_at,boundary.id))
  order by i.created_at desc,i.id desc
 loop
  if not public.can_review_catalog_publication_scope(p_org_id,p_actor_id,candidate.community_id) then continue;end if;
  if jsonb_array_length(rows)=25 then continuation:=last_visible;exit;end if;
  select left(to_jsonb(c)->>'name',200) into community_name from public.communities c where c.org_id=p_org_id and c.id=candidate.community_id;
  rows:=rows||jsonb_build_array(jsonb_build_object('id',candidate.id,'requestKey',candidate.request_key,'kind',candidate.kind,'communityId',candidate.community_id,'communityName',community_name,'occurredAt',to_char(candidate.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'itemCount',candidate.item_count));
  last_visible:=candidate.id;
 end loop;
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'entries',rows,'nextCursor',continuation);
end $$;
revoke all on function public.list_pending_catalog_publications(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_pending_catalog_publications(uuid,uuid,uuid) to service_role;
