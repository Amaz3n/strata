-- Keep a worksheet's scope, issued request, history and pricing choice in one transaction.
create or replace function public.revise_precon_pricing_scope(
  p_org_id uuid, p_prospect_id uuid, p_package_id uuid, p_user_id uuid,
  p_expected_version integer, p_signature text, p_reason text
) returns jsonb language plpgsql set search_path = public as $$
declare
  w public.precon_workspaces; p public.bid_packages; lead public.prospects; job public.projects;
  worksheet jsonb; request jsonb; row_data jsonb; new_requests jsonb;
  notice_id uuid; next_number integer; scope_text text; position_index integer := 0;
begin
  select * into lead from public.prospects where org_id=p_org_id and id=p_prospect_id for update;
  if not found or lead.status::text in ('lost','won') then raise exception 'Only an open deal can revise pricing.'; end if;
  select * into job from public.projects where org_id=p_org_id and prospect_id=p_prospect_id for update;
  if job.phase::text='delivery' then raise exception 'Continue pricing in the active project.'; end if;
  select * into w from public.precon_workspaces where org_id=p_org_id and prospect_id=p_prospect_id for update;
  if not found or w.version<>p_expected_version then raise exception 'Pricing changed in another session. Review the latest pricing before revising scope.'; end if;
  select * into p from public.bid_packages where org_id=p_org_id and id=p_package_id for update;
  if not found or (p.prospect_id=p_prospect_id or (job.id is not null and p.project_id=job.id)) is not true then raise exception 'Request does not belong to this deal.'; end if;
  if p.status::text in ('closed','awarded','cancelled') then raise exception 'This request is closed to scope changes.'; end if;
  if length(trim(p_reason))=0 then raise exception 'Describe the scope revision.'; end if;
  worksheet := w.brief->'pricing_worksheet';
  select value into request from jsonb_array_elements(worksheet->'requests') where value->>'package_id'=p_package_id::text;
  if request is null then raise exception 'Link the request before revising scope.'; end if;
  if request->>'scope_signature'=p_signature then raise exception 'The requested scope already matches the worksheet.'; end if;
  select string_agg(value->>'description' || case when coalesce(value->>'notes','')<>'' then E'\n'||(value->>'notes') else '' end,E'\n\n') into scope_text
    from jsonb_array_elements(worksheet->'rows') where request->'row_ids' ? (value->>'id');
  if scope_text is null then raise exception 'No worksheet scope was found.'; end if;
  select coalesce(max(number),0)+1 into next_number from public.bid_addenda where org_id=p_org_id and bid_package_id=p.id;
  -- The existing addendum trigger snapshots the old scope and retires selected pricing.
  insert into public.bid_addenda(org_id,bid_package_id,number,title,message,created_by)
    values(p_org_id,p.id,next_number,'Scope revised from pricing',p_reason || E'\n\nRevised scope:\n' || scope_text || E'\n\nPlease submit a quote for the current scope revision.',p_user_id) returning id into notice_id;
  update public.bid_packages set status='draft' where id=p.id;
  delete from public.bid_scope_items where org_id=p_org_id and bid_package_id=p.id;
  for row_data in select value from jsonb_array_elements(worksheet->'rows') where request->'row_ids' ? (value->>'id') loop
    insert into public.bid_scope_items(org_id,bid_package_id,position,item_type,description,details,quantity,unit,cost_code_id,created_by)
      values(p_org_id,p.id,position_index,'base',row_data->>'description',nullif(row_data->>'notes',''),(row_data->>'quantity')::numeric,row_data->>'unit',nullif(row_data->>'cost_code_id','')::uuid,p_user_id);
    position_index := position_index+1;
  end loop;
  update public.bid_packages set scope=scope_text,updated_at=now() where id=p.id;
  update public.bid_packages set status='open' where id=p.id;
  select jsonb_agg(case when value->>'package_id'=p.id::text then value || jsonb_build_object('scope_signature',p_signature,'quote',null) else value end) into new_requests from jsonb_array_elements(worksheet->'requests');
  worksheet := jsonb_set(worksheet,'{requests}',new_requests);
  update public.precon_workspaces set brief=jsonb_set(brief,'{pricing_worksheet}',worksheet),version=version+1,updated_by=p_user_id where id=w.id;
  return jsonb_build_object('worksheet',worksheet,'version',w.version+1,'addendumId',notice_id);
end $$;
revoke all on function public.revise_precon_pricing_scope(uuid,uuid,uuid,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.revise_precon_pricing_scope(uuid,uuid,uuid,uuid,integer,text,text) to service_role;
