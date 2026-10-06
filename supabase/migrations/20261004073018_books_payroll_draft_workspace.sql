-- Unposted payroll review in project workflows. Organization overhead is shared
-- across projects only after whole-organization accounting authorization.
create index books_payroll_draft_page_idx on public.books_payroll_imports(org_id,prepared_at desc,id desc);
create function public.read_books_project_payroll_drafts(
 p_org_id uuid,p_project_id uuid,p_import_id uuid default null,
 p_before_time timestamptz default null,p_before_id uuid default null,p_limit integer default 50
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_project jsonb;v_rows jsonb;v_more boolean;v_next jsonb;v_projects jsonb;v_codes jsonb;
begin
 if p_org_id is null or p_project_id is null or p_limit is null or p_limit not between 1 and 50
 or (p_before_time is null)<>(p_before_id is null) or (p_import_id is not null and p_before_time is not null) then
  raise exception 'Invalid payroll draft scope or pagination';
 end if;
 select to_jsonb(p) into v_project from public.projects p where p.org_id=p_org_id and p.id=p_project_id;
 if v_project is null then raise exception 'Project is unavailable in this organization';end if;
 with page as (
  select i.* from public.books_payroll_imports i
  where i.org_id=p_org_id and (p_import_id is null or i.id=p_import_id)
  and not exists(select 1 from public.books_payroll_postings p where p.org_id=p_org_id and p.payroll_import_id=i.id)
  and (i.run @> jsonb_build_object('employees',jsonb_build_array(jsonb_build_object('allocations',jsonb_build_array(jsonb_build_object('project_id',p_project_id)))))
   or not exists(select 1 from jsonb_array_elements(i.run->'employees') w cross join lateral jsonb_array_elements(w->'allocations') a where a->>'project_id' is not null))
  and (p_before_time is null or (i.prepared_at,i.id)<(p_before_time,p_before_id))
  order by i.prepared_at desc,i.id desc limit p_limit+1
 ) select coalesce(jsonb_agg(to_jsonb(page) order by prepared_at desc,id desc),'[]') into v_rows from page;
 if p_import_id is not null and jsonb_array_length(v_rows)<>1 then raise exception 'Unposted payroll draft is unavailable for this project';end if;
 v_more:=jsonb_array_length(v_rows)>p_limit;
 if v_more then v_rows:=v_rows-p_limit;v_next:=jsonb_build_object('preparedAt',v_rows->(p_limit-1)->'prepared_at','id',v_rows->(p_limit-1)->'id');end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'org_id',p.org_id,'name',coalesce(to_jsonb(p)->>'name','Project')) order by p.id),'[]') into v_projects
 from public.projects p where p.org_id=p_org_id and p.id in(select (a->>'project_id')::uuid from jsonb_array_elements(v_rows) i cross join lateral jsonb_array_elements(i->'run'->'employees') w cross join lateral jsonb_array_elements(w->'allocations') a);
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'org_id',c.org_id,'name',coalesce(to_jsonb(c)->>'name',to_jsonb(c)->>'code','Cost code')) order by c.id),'[]') into v_codes
 from public.cost_codes c where c.org_id=p_org_id and c.id in(select (a->>'cost_code_id')::uuid from jsonb_array_elements(v_rows) i cross join lateral jsonb_array_elements(i->'run'->'employees') w cross join lateral jsonb_array_elements(w->'allocations') a);
 return jsonb_build_object('orgId',p_org_id,'projectId',p_project_id,'projectName',coalesce(v_project->>'name','Project'),'imports',v_rows,'nextCursor',v_next,'projects',v_projects,'costCodes',v_codes);
end $$;
revoke all on function public.read_books_project_payroll_drafts(uuid,uuid,uuid,timestamptz,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_books_project_payroll_drafts(uuid,uuid,uuid,timestamptz,uuid,integer) to service_role;
