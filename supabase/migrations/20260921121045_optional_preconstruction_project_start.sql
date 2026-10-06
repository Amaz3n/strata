-- Starting a project is a builder choice, independent of optional estimating,
-- e-signing, and delivery review. No commercial approval is inferred here.
create function public.start_prospect_project(
  p_org_id uuid, p_prospect_id uuid, p_actor_id uuid,
  p_expected_project_id uuid, p_property_type public.project_property_type
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  lead public.prospects%rowtype;
  job public.projects%rowtype;
  person record;
  v_contact_id uuid;
  primary_contact uuid;
begin
  select * into lead from public.prospects where id=p_prospect_id and org_id=p_org_id for update;
  if not found then raise exception 'Prospect not found'; end if;
  if lead.status='lost' then raise exception 'Reopen this prospect before starting the project'; end if;
  select * into job from public.projects where prospect_id=p_prospect_id and org_id=p_org_id for update;
  -- Require a new application authorization if a project was linked concurrently.
  if job.id is distinct from p_expected_project_id then raise exception 'The linked project changed. Reload and try again'; end if;
  if job.phase='delivery' then return jsonb_build_object('projectId',job.id,'alreadyStarted',true); end if;
  -- Only conditions explicitly marked by the builder are start requirements.
  if exists(select 1 from public.precon_decisions where org_id=p_org_id and prospect_id=p_prospect_id and status='open' and blocks_start) then
    raise exception 'Resolve the conditions you marked as blocking project start';
  end if;
  for person in select * from public.prospect_contacts where org_id=p_org_id and prospect_id=p_prospect_id order by is_primary desc,created_at,id for update loop
    v_contact_id:=null;
    select id into v_contact_id from public.contacts where org_id=p_org_id and id=coalesce(person.promoted_contact_id,person.contact_id);
    if v_contact_id is null and person.email is not null then
      select id into v_contact_id from public.contacts where org_id=p_org_id and email=person.email order by created_at,id limit 1;
    end if;
    if v_contact_id is null then
      insert into public.contacts(org_id,full_name,email,phone,role,contact_type)
        values(p_org_id,person.full_name,person.email,person.phone,person.role,'client') returning id into v_contact_id;
    end if;
    update public.prospect_contacts set promoted_contact_id=v_contact_id,updated_at=now() where id=person.id and org_id=p_org_id;
    if primary_contact is null then primary_contact:=v_contact_id; end if;
  end loop;
  if job.id is null then
    insert into public.projects(org_id,prospect_id,name,status,phase,location,description,property_type,project_type,created_by,client_id)
      values(p_org_id,p_prospect_id,lead.name,'active','delivery',lead.jobsite_location,lead.notes,p_property_type,case when to_jsonb(lead)->>'project_type' in ('new_construction','remodel','addition','renovation','repair') then (to_jsonb(lead)->>'project_type')::public.project_work_type else null end,p_actor_id,primary_contact) returning * into job;
  else
    update public.projects set phase='delivery',status='active',client_id=coalesce(client_id,primary_contact),updated_at=now()
      where id=job.id and org_id=p_org_id;
  end if;
  update public.estimates set project_id=job.id where org_id=p_org_id and prospect_id=p_prospect_id and project_id is null;
  update public.bid_packages set project_id=job.id where org_id=p_org_id and prospect_id=p_prospect_id and project_id is null;
  update public.documents set project_id=job.id where org_id=p_org_id and prospect_id=p_prospect_id and project_id is null;
  update public.envelopes set project_id=job.id where org_id=p_org_id and prospect_id=p_prospect_id and project_id is null;
  update public.files set project_id=job.id,
    folder_path=case when folder_path like '/prospects/'||p_prospect_id||'%' then replace(folder_path,'/prospects/'||p_prospect_id,'/projects/'||job.id) else folder_path end
    where org_id=p_org_id and prospect_id=p_prospect_id and project_id is null;
  update public.prospects set status='won',won_at=coalesce(won_at,now()),updated_at=now() where id=p_prospect_id and org_id=p_org_id;
  insert into public.events(org_id,event_type,entity_type,entity_id,payload)
    values(p_org_id,'prospect_project_started','project',job.id,jsonb_build_object('actor_id',p_actor_id,'prospect_id',p_prospect_id,'method','builder_directed'));
  return jsonb_build_object('projectId',job.id,'alreadyStarted',false);
end $$;
revoke all on function public.start_prospect_project(uuid,uuid,uuid,uuid,public.project_property_type) from public,anon,authenticated;
grant execute on function public.start_prospect_project(uuid,uuid,uuid,uuid,public.project_property_type) to service_role;
