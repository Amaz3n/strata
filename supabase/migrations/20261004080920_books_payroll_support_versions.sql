-- Retained private supporting versions; ordinary project document queries do
-- not participate. Caller applies whole-org accounting and project authorization.
create index books_payroll_support_version_page_idx on public.doc_versions(org_id,id);
create function public.read_books_payroll_support_versions(p_org_id uuid,p_after uuid default null,p_search text default '',p_limit integer default 50)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_rows jsonb;v_more boolean;v_next uuid;
begin
 if p_org_id is null or p_search is null or length(p_search)>200 or p_limit is null or p_limit not between 1 and 50 then raise exception 'Invalid private payroll supporting-version page';end if;
 with page as (
 select v.id,v.org_id,v.file_id,v.file_name,v.mime_type,v.size_bytes,v.checksum
 from public.doc_versions v join public.files f on f.org_id=v.org_id and f.id=v.file_id
 where v.org_id=p_org_id and f.metadata->>'books_private_kind'='payroll_register'
 and v.size_bytes>0 and v.checksum ~ '^[a-f0-9]{64}$' and (p_after is null or v.id>p_after)
 and strpos(lower(v.file_name),lower(trim(p_search)))>0 order by v.id limit p_limit+1
 ) select coalesce(jsonb_agg(to_jsonb(page) order by id),'[]') into v_rows from page;
 v_more:=jsonb_array_length(v_rows)>p_limit;
 if v_more then v_rows:=v_rows-p_limit;v_next:=(v_rows->(p_limit-1)->>'id')::uuid;end if;
 return jsonb_build_object('orgId',p_org_id,'versions',v_rows,'nextCursor',v_next);
end $$;
revoke all on function public.read_books_payroll_support_versions(uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.read_books_payroll_support_versions(uuid,uuid,text,integer) to service_role;
