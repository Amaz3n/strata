begin;
-- Statement-snapshot reader for exact request recovery. Project authorization is
-- also required by the server service before invoking this private RPC.
create function public.read_books_project_entity_proposal(p_org uuid,p_entity uuid,p_project uuid,p_proposal uuid,p_actor uuid,p_operation text default 'read')
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare p public.books_project_entity_proposals;r jsonb;
begin
 if p_operation not in('read','prepare','review') or p_operation is null or not public.books_entity_has_access(p_org,p_entity,p_actor,p_operation) then raise exception 'Current project entity operation access is required';end if;
 if not exists(select 1 from public.projects where org_id=p_org and id=p_project) then raise exception 'Project is unavailable in organization';end if;
 select * into p from public.books_project_entity_proposals where org_id=p_org and legal_entity_id=p_entity and project_id=p_project and id=p_proposal;
 if not found then return jsonb_build_object('orgId',p_org,'entityId',p_entity,'projectId',p_project,'proposalId',p_proposal,'actorId',p_actor,'proposal',null,'review',null,'ledgerActivated',false);end if;
 select to_jsonb(x) into r from public.books_project_entity_reviews x where org_id=p_org and legal_entity_id=p_entity and project_id=p_project and proposal_id=p.id;
 return jsonb_build_object('orgId',p_org,'entityId',p_entity,'projectId',p_project,'proposalId',p_proposal,'actorId',p_actor,'proposal',to_jsonb(p),'review',r,'ledgerActivated',false);
end $$;
revoke all on function public.read_books_project_entity_proposal(uuid,uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.read_books_project_entity_proposal(uuid,uuid,uuid,uuid,uuid,text) to service_role;
commit;
