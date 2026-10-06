-- Bounded accountant review readers. No source/ledger ownership is assigned.
create function public.list_books_legacy_entity_proposals(p_org uuid,p_entity uuid,p_actor uuid,p_after uuid default null,p_limit integer default 25)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_rows jsonb;v_next uuid;v_latest uuid;v_level text;
begin
 perform public.assert_books_legacy_entity_operation(p_org,p_entity,p_actor,'read');
 if p_limit is null or p_limit not between 1 and 25 then raise exception 'Invalid ownership review page size';end if;
 select access_level into v_level from public.books_legal_entity_members where org_id=p_org and legal_entity_id=p_entity and user_id=p_actor;
 select p.id into v_latest from public.books_legacy_entity_proposals p join public.books_legacy_entity_reviews r on r.proposal_id=p.id where p.org_id=p_org and p.legal_entity_id=p_entity order by r.reviewed_at desc,r.id desc limit 1;
 with page as (
  select p.id,p.org_id,p.legal_entity_id,p.accounting_cutoff,p.prepared_at,p.prepared_by,
  coalesce(u.full_name,u.email::text,'Former organization member') prepared_by_name,
  r.reviewed_at,r.reviewed_by,
  coalesce(ru.full_name,ru.email::text,'Former organization member') reviewed_by_name
  from public.books_legacy_entity_proposals p left join public.app_users u on u.id=p.prepared_by
  left join public.books_legacy_entity_reviews r on r.proposal_id=p.id
  left join public.app_users ru on ru.id=r.reviewed_by
  where p.org_id=p_org and p.legal_entity_id=p_entity and (p_after is null or p.id>p_after)
  order by p.id limit p_limit+1
 ) select coalesce(jsonb_agg(to_jsonb(page) order by id),'[]') into v_rows from page;
 if jsonb_array_length(v_rows)>p_limit then v_rows:=v_rows-p_limit;v_next:=(v_rows->(p_limit-1)->>'id')::uuid;end if;
 return jsonb_build_object('orgId',p_org,'entityId',p_entity,'actorId',p_actor,'accessLevel',v_level,'proposals',v_rows,'nextCursor',v_next,'latestReviewedProposalId',v_latest);
end $$;

create function public.list_books_entity_review_options(p_org uuid,p_entity uuid,p_actor uuid,p_kind text,p_search text default '',p_after uuid default null,p_limit integer default 25)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_rows jsonb;v_next uuid;
begin
 if p_search is null or length(p_search)>100 or p_limit is null or p_limit not between 1 and 25 then raise exception 'Invalid entity option search';end if;
 if p_kind='people' then
  if not public.books_entity_has_access(p_org,p_entity,p_actor,'manage') then raise exception 'Entity manager access is required';end if;
  with page as (
   select u.id,coalesce(nullif(u.full_name,''),u.email::text) label,u.email::text detail
   from public.app_users u where exists(select 1 from public.memberships m where m.org_id=p_org and m.user_id=u.id and m.status='active')
   and (p_after is null or u.id>p_after) and (p_search='' or position(lower(p_search) in lower(coalesce(u.full_name,'')||' '||u.email::text))>0)
   order by u.id limit p_limit+1
  ) select coalesce(jsonb_agg(to_jsonb(page) order by id),'[]') into v_rows from page;
 elsif p_kind='documents' then
  perform public.assert_books_legacy_entity_operation(p_org,p_entity,p_actor,'read');
  with page as (
   select d.id,d.file_name label,'Version '||d.version_number::text||' · '||to_char(d.created_at,'YYYY-MM-DD') detail
   from public.doc_versions d join public.files f on f.id=d.file_id and f.org_id=d.org_id
   where d.org_id=p_org and d.storage_path like p_org::text||'/%' and d.checksum ~ '^[a-f0-9]{64}$' and d.size_bytes>=0
   and (p_after is null or d.id>p_after) and (p_search='' or position(lower(p_search) in lower(coalesce(d.file_name,'')))>0)
   order by d.id limit p_limit+1
  ) select coalesce(jsonb_agg(to_jsonb(page) order by id),'[]') into v_rows from page;
 else raise exception 'Unknown entity review option kind';end if;
 if jsonb_array_length(v_rows)>p_limit then v_rows:=v_rows-p_limit;v_next:=(v_rows->(p_limit-1)->>'id')::uuid;end if;
 return jsonb_build_object('orgId',p_org,'entityId',p_entity,'kind',p_kind,'options',v_rows,'nextCursor',v_next);
end $$;
revoke all on function public.list_books_legacy_entity_proposals(uuid,uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.list_books_entity_review_options(uuid,uuid,uuid,text,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.list_books_legacy_entity_proposals(uuid,uuid,uuid,uuid,integer) to service_role;
grant execute on function public.list_books_entity_review_options(uuid,uuid,uuid,text,text,uuid,integer) to service_role;
create function public.read_books_entity_setup_access(p_org uuid,p_entity uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
begin
 if not public.books_entity_has_access(p_org,p_entity,p_actor,'read') then raise exception 'Entity read access is required';end if;
 return jsonb_build_object('orgId',p_org,'entityId',p_entity,'actorId',p_actor,'prepare',public.books_entity_has_access(p_org,p_entity,p_actor,'prepare'),'review',public.books_entity_has_access(p_org,p_entity,p_actor,'review'),'manage',public.books_entity_has_access(p_org,p_entity,p_actor,'manage'));
end $$;
revoke all on function public.read_books_entity_setup_access(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.read_books_entity_setup_access(uuid,uuid,uuid) to service_role;
