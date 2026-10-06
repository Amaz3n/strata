begin;
-- The reviewed chart head is independent of a paged UUID list. Profile choices
-- retain their original revision/effective dates, including older identities.
create function public.read_books_entity_chart_editor_context(p_org uuid,p_entity uuid,p_actor uuid,p_before integer default null,p_limit integer default 50)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare revisions integer[];more boolean;head uuid;effective date;
begin
 if not public.books_entity_has_access(p_org,p_entity,p_actor,'read') then raise exception 'Entity chart read access is required';end if;
 if p_limit is null or p_limit<1 or p_limit>50 or (p_before is not null and p_before<1) then raise exception 'Invalid reviewed profile page';end if;
 select c.id,c.effective_on into head,effective from public.books_entity_chart_versions c join public.books_entity_chart_reviews r on r.org_id=c.org_id and r.legal_entity_id=c.legal_entity_id and r.chart_id=c.id where c.org_id=p_org and c.legal_entity_id=p_entity order by c.effective_on desc,c.id desc limit 1;
 select array_agg(revision order by revision desc) into revisions from (select p.revision from public.books_legal_entity_profiles p join public.books_legal_entity_profile_reviews r on r.org_id=p.org_id and r.legal_entity_id=p.legal_entity_id and r.profile_id=p.id where p.org_id=p_org and p.legal_entity_id=p_entity and (p_before is null or p.revision<p_before) order by p.revision desc limit p_limit+1)x;
 more:=coalesce(cardinality(revisions),0)>p_limit;revisions:=revisions[1:p_limit];
 return jsonb_build_object('orgId',p_org,'entityId',p_entity,'latestReviewedChartId',head,'latestReviewedEffectiveOn',effective,'profiles',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'revision',p.revision,'effective_on',p.effective_on,'legal_name',p.legal_name) order by p.revision desc),'[]') from public.books_legal_entity_profiles p where p.org_id=p_org and p.legal_entity_id=p_entity and p.revision=any(revisions)),'nextProfileCursor',case when more then revisions[cardinality(revisions)] else null end,'ledgerActivated',false);
end $$;
revoke all on function public.read_books_entity_chart_editor_context(uuid,uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.read_books_entity_chart_editor_context(uuid,uuid,uuid,integer,integer) to service_role;
commit;
