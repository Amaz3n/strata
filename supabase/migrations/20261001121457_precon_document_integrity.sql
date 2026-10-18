-- Review links are independent capabilities: copying/resending never revokes a previous link.
create table public.estimate_review_links (
  token_hash text primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  estimate_id uuid not null references public.estimates(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index estimate_review_links_estimate_idx on public.estimate_review_links(org_id,estimate_id);
alter table public.estimate_review_links enable row level security;
revoke all on public.estimate_review_links from public,anon,authenticated;
grant all on public.estimate_review_links to service_role;

create function public.issue_estimate_review_link(
  p_org_id uuid, p_estimate_id uuid, p_token_hash text, p_expected_updated_at timestamptz, p_revoke_existing boolean default false
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare e public.estimates%rowtype; w public.precon_workspaces%rowtype;
begin
  select * into e from public.estimates where org_id=p_org_id and id=p_estimate_id for update;
  if not found then raise exception 'Estimate not found'; end if;
  if e.status not in ('draft','sent','changes_requested','rejected') or e.is_current_version=false or e.client_signed_at is not null or e.executed_at is not null then
    raise exception 'Only current unsigned documents can be issued';
  end if;
  if e.updated_at is distinct from p_expected_updated_at then raise exception 'This document changed. Review it before issuing'; end if;
  if e.prospect_id is not null and exists(select 1 from public.prospects where id=e.prospect_id and org_id=p_org_id and status in ('lost','won')) then
    raise exception 'Reopen this deal before issuing documents';
  end if;
  if e.prospect_id is not null and exists(select 1 from public.projects where prospect_id=e.prospect_id and org_id=p_org_id and phase='delivery') then
    raise exception 'This deal is in delivery. Open the project to make changes';
  end if;
  -- Bind first publication to the brief checked by the server, including edits
  -- committed between its reference check and this transaction.
  if e.sent_at is null and e.prospect_id is not null
    and coalesce(e.metadata->'precon'->>'purpose','construction_agreement')<>'preconstruction_agreement'
    and e.metadata->'precon'->>'brief_version' is not null then
    select * into w from public.precon_workspaces where org_id=p_org_id and prospect_id=e.prospect_id for update;
    if (e.metadata->'precon'->>'brief_version')::integer is distinct from
      coalesce((w.brief->>'pricing_revision')::integer,w.version,0) then
      raise exception 'The pricing basis changed. Review it before issuing';
    end if;
  end if;
  if p_revoke_existing then
    delete from public.estimate_review_links where org_id=p_org_id and estimate_id=p_estimate_id;
    update public.estimates set token_hash=null where id=e.id and org_id=p_org_id;
  end if;
  insert into public.estimate_review_links(org_id,estimate_id,token_hash) values(p_org_id,p_estimate_id,p_token_hash);
  -- A copied review link is publication too: prevent autosave changing client-visible content.
  update public.estimates set status='sent',sent_at=coalesce(sent_at,now()),updated_at=clock_timestamp() where id=e.id and org_id=p_org_id;
  return jsonb_build_object('id',e.id);
end $$;
revoke all on function public.issue_estimate_review_link(uuid,uuid,text,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.issue_estimate_review_link(uuid,uuid,text,timestamptz,boolean) to service_role;

-- Update one unpublished draft atomically; preserve surviving item identities.
create or replace function public.save_estimate_draft(
  p_org_id uuid, p_estimate_id uuid, p_expected_updated_at timestamptz,
  p_document jsonb, p_items jsonb
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  draft public.estimates%rowtype;
  item jsonb;
  item_id uuid;
  kept_ids uuid[] := '{}';
begin
  select * into draft from public.estimates
    where id = p_estimate_id and org_id = p_org_id for update;
  if not found then raise exception 'Estimate not found'; end if;
  if draft.status <> 'draft' or draft.sent_at is not null or draft.is_current_version = false then
    raise exception 'Only the current unpublished draft can be edited';
  end if;
  if coalesce(draft.metadata->'precon'->>'purpose','construction_agreement') is distinct from
    coalesce(p_document->'metadata'->'precon'->>'purpose','construction_agreement') then
    raise exception 'Prepare a separate document to change its type';
  end if;
  if draft.prospect_id is not null then
    perform 1 from public.prospects where id=draft.prospect_id and org_id=p_org_id and status not in ('lost','won') for update;
    if not found then raise exception 'Reopen this deal before changing its documents'; end if;
    if exists(select 1 from public.estimates newer where newer.org_id=p_org_id and newer.prospect_id=draft.prospect_id
      and newer.is_current_version is distinct from false
      and coalesce(newer.metadata->'precon'->>'purpose','construction_agreement')=coalesce(draft.metadata->'precon'->>'purpose','construction_agreement')
      and (newer.created_at,newer.version,newer.id)>(draft.created_at,draft.version,draft.id)) then
      raise exception 'A newer document exists. Reopen the current document';
    end if;
  end if;
  if p_expected_updated_at is null or draft.updated_at is distinct from p_expected_updated_at then
    raise exception 'This draft changed elsewhere. Reopen it to load the latest version.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A draft requires at least one line';
  end if;
  if nullif(p_document->>'recipient_contact_id','') is not null and not exists (
    select 1 from public.contacts where id = (p_document->>'recipient_contact_id')::uuid and org_id = p_org_id
  ) then raise exception 'Client not found in this organization'; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if nullif(item->>'cost_code_id','') is not null and not exists (
      select 1 from public.cost_codes where id = (item->>'cost_code_id')::uuid and org_id = p_org_id
    ) then raise exception 'Cost code not found in this organization'; end if;
    select id into item_id from public.estimate_items
      where estimate_id = p_estimate_id and org_id = p_org_id
      and (metadata->>'editor_line_id' = item->'metadata'->>'editor_line_id'
        or id::text = item->'metadata'->>'editor_line_id')
      limit 1;
    if item_id = any(kept_ids) then raise exception 'Duplicate draft line'; end if;
    if item_id is null then
      insert into public.estimate_items (org_id, estimate_id, description)
        values (p_org_id, p_estimate_id, item->>'description') returning id into item_id;
    end if;
    update public.estimate_items set
      description = item->>'description', item_type = item->>'item_type',
      cost_code_id = nullif(item->>'cost_code_id','')::uuid,
      quantity = (item->>'quantity')::numeric, unit = item->>'unit',
      unit_cost_cents = (item->>'unit_cost_cents')::bigint,
      markup_pct = (item->>'markup_pct')::numeric,
      sort_order = (item->>'sort_order')::integer,
      metadata = item->'metadata'
      where id = item_id and org_id = p_org_id;
    kept_ids := array_append(kept_ids, item_id);
  end loop;
  delete from public.estimate_items where estimate_id = p_estimate_id and org_id = p_org_id and not (id = any(kept_ids));
  update public.estimates set title = p_document->>'title',
    recipient_contact_id = nullif(p_document->>'recipient_contact_id','')::uuid,
    valid_until = nullif(p_document->>'valid_until','')::date,
    subtotal_cents = (p_document->>'subtotal_cents')::bigint,
    tax_cents = (p_document->>'tax_cents')::bigint,
    total_cents = (p_document->>'total_cents')::bigint,
    metadata = coalesce(draft.metadata, '{}'::jsonb) || (p_document->'metadata'),
    updated_at = clock_timestamp()
    where id = p_estimate_id and org_id = p_org_id returning * into draft;
  return to_jsonb(draft);
end;
$$;
-- The server validates organization membership and the complete input first.
revoke all on function public.save_estimate_draft(uuid,uuid,timestamptz,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.save_estimate_draft(uuid,uuid,timestamptz,jsonb,jsonb) to service_role;

-- Replace the previous signature; the optional agreement ID binds review to the actual conversion.
drop function public.start_prospect_project(uuid,uuid,uuid,uuid,public.project_property_type);
-- Deal conversion requires the current construction agreement to be executed.
create or replace function public.start_prospect_project(
  p_org_id uuid, p_prospect_id uuid, p_actor_id uuid,
  p_expected_project_id uuid, p_property_type public.project_property_type, p_expected_agreement_id uuid default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  lead public.prospects%rowtype;
  job public.projects%rowtype;
  person record;
  v_contact_id uuid;
  primary_contact uuid;
  agreement public.estimates%rowtype;
  billing public.contracts%rowtype;
  commercial jsonb; model text; accepted_total bigint; reserve_cents bigint;
begin
  select * into lead from public.prospects where id=p_prospect_id and org_id=p_org_id for update;
  if not found then raise exception 'Prospect not found'; end if;
  if lead.status='lost' then raise exception 'Reopen this prospect before starting the project'; end if;
  select * into job from public.projects where prospect_id=p_prospect_id and org_id=p_org_id for update;
  -- Require a new application authorization if a project was linked concurrently.
  if job.id is distinct from p_expected_project_id then raise exception 'The linked project changed. Reload and try again'; end if;
  if job.phase='delivery' then return jsonb_build_object('projectId',job.id,'alreadyStarted',true); end if;
  select * into agreement from public.estimates
    where org_id=p_org_id and prospect_id=p_prospect_id
      and is_current_version is distinct from false
      and coalesce(metadata->'precon'->>'purpose','construction_agreement')='construction_agreement'
    order by created_at desc,version desc,id desc limit 1 for update;
  if agreement.id is null or agreement.status not in ('executed','converted_to_project') then
    raise exception 'Execute the current construction agreement before converting this deal to an active project';
  end if;
  if p_expected_agreement_id is not null and agreement.id is distinct from p_expected_agreement_id then raise exception 'The agreement changed. Review conversion again'; end if;
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
    update public.projects set phase='delivery',status='active',name=lead.name,location=lead.jobsite_location,description=lead.notes,client_id=coalesce(client_id,primary_contact),updated_at=now()
      where id=job.id and org_id=p_org_id;
  end if;
  -- The signed agreement is the commercial source of truth; budget setup stays optional.
  commercial:=coalesce(agreement.metadata->'precon','{}'::jsonb);
  model:=coalesce(commercial->>'billing_model','fixed_price');
  if model not in ('fixed_price','cost_plus_percent','cost_plus_fixed_fee','cost_plus_gmp','time_and_materials') then
    raise exception 'Unsupported signed billing model';
  end if;
  accepted_total:=coalesce((agreement.metadata->'accepted_options'->>'accepted_total_cents')::bigint,agreement.total_cents,0);
  reserve_cents:=case when coalesce(commercial->>'contingency_treatment','included_in_price')='included_in_price' then 0
    else round(coalesce(agreement.subtotal_cents,0)*coalesce((agreement.metadata->>'contingency_percent')::numeric,0)/100) end;
  select * into billing from public.contracts where org_id=p_org_id and project_id=job.id and status='active'
    order by created_at desc,id desc limit 1 for update;
  if billing.id is not null and billing.snapshot->>'estimate_id' is distinct from agreement.id::text then
    if billing.signed_at is null and coalesce(billing.total_cents,0)=0 and billing.snapshot->>'billing_setup_source'='project_settings'
      and not exists(select 1 from public.invoices where org_id=p_org_id and project_id=job.id) then
      update public.contracts set status='superseded' where org_id=p_org_id and id=billing.id;
      billing:=null;
    else raise exception 'This project already has a different billing contract. Reconcile it before conversion'; end if;
  end if;
  if billing.id is null then
    insert into public.contracts(org_id,project_id,title,status,total_cents,currency,signed_at,effective_date,terms,signature_data,
      contract_type,markup_percent,gmp_cents,fixed_fee_cents,retainage_percent,contingency_cents,snapshot)
    values(p_org_id,job.id,lead.name||' Contract','active',accepted_total,coalesce(agreement.currency,'usd'),
      agreement.executed_at,coalesce(agreement.executed_at::date,current_date),
      concat_ws(E'\n\n',nullif(agreement.metadata->>'terms',''),nullif(commercial->>'payment_terms','')),agreement.signature_data,
      case when model='time_and_materials' then 'time_materials' when model like 'cost_plus%' then 'cost_plus' else 'fixed' end,
      case when model in ('fixed_price','cost_plus_fixed_fee') then null else coalesce((agreement.metadata->>'markup_percent')::numeric,0) end,
      case when model='cost_plus_gmp' then nullif(commercial->>'gmp_cents','0')::bigint end,
      case when model='cost_plus_fixed_fee' then nullif(commercial->>'fixed_fee_cents','0')::bigint end,
      coalesce((commercial->>'retainage_percent')::numeric,0),reserve_cents,
      jsonb_build_object('estimate_id',agreement.id,'base_total_cents',accepted_total,'billing_model',model,'precon',commercial,
        'source','executed_deal_conversion','agreement_metadata',agreement.metadata,
        'inclusions',agreement.metadata->'inclusions','exclusions',agreement.metadata->'exclusions','accepted_options',agreement.metadata->'accepted_options',
        'esign',jsonb_build_object('executed_file_id',agreement.executed_file_id,'envelope_id',agreement.signature_envelope_id,'document_id',agreement.signature_document_id)))
      returning * into billing;
  end if;
  update public.projects set total_contract_value_cents=accepted_total,total_value=round(accepted_total::numeric/100),
    retainage_percent=coalesce((commercial->>'retainage_percent')::numeric,0) where id=job.id and org_id=p_org_id;
  insert into public.project_financial_settings(org_id,project_id,billing_model,open_book_required,metadata)
    values(p_org_id,job.id,model,model<>'fixed_price',jsonb_build_object('source','estimate_execution','source_estimate_id',agreement.id))
    on conflict(org_id,project_id) do update set billing_model=excluded.billing_model,open_book_required=excluded.open_book_required,
      metadata=coalesce(public.project_financial_settings.metadata,'{}'::jsonb)||excluded.metadata,updated_at=now();
  if agreement.executed_file_id is not null then
    if not exists(select 1 from public.files where id=agreement.executed_file_id and org_id=p_org_id) then raise exception 'Executed file unavailable'; end if;
    insert into public.file_links(org_id,file_id,project_id,entity_type,entity_id,link_role)
      select p_org_id,agreement.executed_file_id,job.id,'contract',billing.id,'executed_contract'
      where not exists(select 1 from public.file_links where org_id=p_org_id and file_id=agreement.executed_file_id and entity_type='contract' and entity_id=billing.id);
  end if;
  update public.estimates set project_id=job.id where org_id=p_org_id and prospect_id=p_prospect_id and project_id is null;
  update public.bid_packages set project_id=job.id,prospect_id=null where org_id=p_org_id and prospect_id=p_prospect_id and project_id is null;
  update public.documents set project_id=job.id where org_id=p_org_id and prospect_id=p_prospect_id and project_id is null;
  update public.envelopes set project_id=job.id where org_id=p_org_id and prospect_id=p_prospect_id and project_id is null;
  update public.files set project_id=job.id,
    folder_path=case when folder_path like '/prospects/'||p_prospect_id||'%' then replace(folder_path,'/prospects/'||p_prospect_id,'/projects/'||job.id) else folder_path end
    where org_id=p_org_id and prospect_id=p_prospect_id and project_id is null;
  update public.prospects set status='won',won_at=coalesce(won_at,now()),updated_at=now() where id=p_prospect_id and org_id=p_org_id;
  insert into public.events(org_id,event_type,entity_type,entity_id,payload)
    values(p_org_id,'prospect_project_moved','project',job.id,jsonb_build_object('actor_id',p_actor_id,'prospect_id',p_prospect_id,'method','executed_agreement','agreement_id',agreement.id));
  return jsonb_build_object('projectId',job.id,'alreadyStarted',false);
end $$;
revoke all on function public.start_prospect_project(uuid,uuid,uuid,uuid,public.project_property_type,uuid) from public,anon,authenticated;
grant execute on function public.start_prospect_project(uuid,uuid,uuid,uuid,public.project_property_type,uuid) to service_role;
