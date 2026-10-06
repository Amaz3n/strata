begin;
create function public.read_books_project_owner_workspace(p_org uuid,p_project uuid,p_actor uuid,p_entity uuid default null,p_after_entity uuid default null,p_after_proposal uuid default null,p_limit integer default 25)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare entities jsonb;proposals jsonb:='[]';owner jsonb;assigned boolean;entity_cursor uuid;proposal_cursor uuid;project_name text;
begin
 if p_limit is null or p_limit not between 1 and 25 then raise exception 'Invalid project ownership page size';end if;
 if not exists(select 1 from public.memberships where org_id=p_org and user_id=p_actor and status='active') then raise exception 'Active organization membership is required';end if;
 select name into project_name from public.projects where org_id=p_org and id=p_project;
 if not found then raise exception 'Project is unavailable in organization';end if;
 if p_entity is not null and not public.books_entity_has_access(p_org,p_entity,p_actor,'read') then raise exception 'Project entity read access is required';end if;
 if p_entity is null and p_after_proposal is not null then raise exception 'Proposal cursor requires an entity';end if;
 with page as (
 select e.id,e.org_id,e.code,profile.id profile_id,profile.legal_name,profile.effective_on,
 public.books_entity_has_access(p_org,e.id,p_actor,'prepare') can_prepare,
 public.books_entity_has_access(p_org,e.id,p_actor,'review') can_review
 from public.books_legal_entities e
 left join lateral(select p.id,p.legal_name,p.effective_on from public.books_legal_entity_profiles p join public.books_legal_entity_profile_reviews r on r.org_id=p.org_id and r.legal_entity_id=p.legal_entity_id and r.profile_id=p.id where p.org_id=e.org_id and p.legal_entity_id=e.id order by p.revision desc limit 1) profile on true
 where e.org_id=p_org and public.books_entity_has_access(p_org,e.id,p_actor,'read') and(p_after_entity is null or e.id>p_after_entity)
 order by e.id limit p_limit+1
 )select coalesce(jsonb_agg(to_jsonb(page) order by id),'[]') into entities from page;
 if jsonb_array_length(entities)>p_limit then entities:=entities-p_limit;entity_cursor:=(entities->(p_limit-1)->>'id')::uuid;end if;
 select exists(select 1 from public.books_project_entity_reviews where org_id=p_org and project_id=p_project) into assigned;
 select jsonb_build_object('proposal',to_jsonb(p),'review',to_jsonb(r)) into owner from public.books_project_entity_reviews r join public.books_project_entity_proposals p on p.org_id=r.org_id and p.legal_entity_id=r.legal_entity_id and p.project_id=r.project_id and p.id=r.proposal_id where r.org_id=p_org and r.project_id=p_project and public.books_entity_has_access(p_org,r.legal_entity_id,p_actor,'read');
 if p_entity is not null then
 with page as (
 select p.id,p.org_id,p.legal_entity_id,p.project_id,p.profile_id,p.effective_on,p.project_name,p.prepared_by,p.prepared_at,r.reviewed_by,r.reviewed_at
 from public.books_project_entity_proposals p left join public.books_project_entity_reviews r on r.org_id=p.org_id and r.legal_entity_id=p.legal_entity_id and r.project_id=p.project_id and r.proposal_id=p.id
 where p.org_id=p_org and p.project_id=p_project and p.legal_entity_id=p_entity and(p_after_proposal is null or p.id>p_after_proposal)
 order by p.id limit p_limit+1
 )select coalesce(jsonb_agg(to_jsonb(page) order by id),'[]') into proposals from page;
 if jsonb_array_length(proposals)>p_limit then proposals:=proposals-p_limit;proposal_cursor:=(proposals->(p_limit-1)->>'id')::uuid;end if;
 end if;
 return jsonb_build_object('orgId',p_org,'projectId',p_project,'actorId',p_actor,'entityId',p_entity,'projectName',project_name,'entities',entities,'nextEntityCursor',entity_cursor,'proposals',proposals,'nextProposalCursor',proposal_cursor,'hasReviewedOwner',assigned,'owner',owner,'canPrepare',case when p_entity is null then false else public.books_entity_has_access(p_org,p_entity,p_actor,'prepare') end,'canReview',case when p_entity is null then false else public.books_entity_has_access(p_org,p_entity,p_actor,'review') end,'ledgerActivated',false);
end $$;
revoke all on function public.read_books_project_owner_workspace(uuid,uuid,uuid,uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_books_project_owner_workspace(uuid,uuid,uuid,uuid,uuid,uuid,integer) to service_role;
commit;
