-- Award is commercial; release to delivery requires a reviewed baseline and handoff.
create table public.project_precon_handoffs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null unique references public.projects(id) on delete cascade,
  prospect_id uuid not null references public.prospects(id),
  estimate_id uuid not null references public.estimates(id),
  contract_id uuid not null references public.contracts(id),
  budget_id uuid not null references public.budgets(id),
  status text not null default 'awarded' check (status in ('awarded','baseline_approved','accepted','released')),
  readiness jsonb not null default '{}', baseline_review jsonb not null default '{}',
  baseline_signature text, baseline_approved_at timestamptz, baseline_approved_by uuid references public.app_users(id),
  accepted_at timestamptz, accepted_by uuid references public.app_users(id),
  released_at timestamptz, released_by uuid references public.app_users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index project_precon_handoffs_org_prospect_idx on public.project_precon_handoffs(org_id, prospect_id);
alter table public.project_precon_handoffs enable row level security;
-- Writes only through server-authorized, service-role RPCs. No public mutation policy.
revoke all on public.project_precon_handoffs from public, anon, authenticated;
grant all on public.project_precon_handoffs to service_role;
-- Reads also pass through project-scoped application authorization.

create function public.convert_executed_prospect_handoff(
  p_org_id uuid, p_prospect_id uuid, p_estimate_id uuid, p_actor_id uuid,
  p_expected_updated_at timestamptz, p_project jsonb, p_commercial jsonb, p_lines jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  prospect public.prospects%rowtype; estimate public.estimates%rowtype; project public.projects%rowtype;
  handoff public.project_precon_handoffs%rowtype; contract public.contracts%rowtype; budget public.budgets%rowtype;
  person record; v_contact_id uuid; primary_contact uuid; line jsonb; total bigint; model text;
begin
  select * into prospect from public.prospects where id=p_prospect_id and org_id=p_org_id for update;
  if not found then raise exception 'Prospect not found'; end if;
  select * into estimate from public.estimates where id=p_estimate_id and org_id=p_org_id and prospect_id=p_prospect_id for update;
  if not found then raise exception 'Estimate does not belong to this prospect'; end if;
  select * into handoff from public.project_precon_handoffs where org_id=p_org_id and prospect_id=p_prospect_id;
  if found then
    if handoff.estimate_id<>p_estimate_id then raise exception 'This prospect already has a contracted baseline; use a change order'; end if;
    return jsonb_build_object('projectId',handoff.project_id,'contractId',handoff.contract_id,'budgetId',handoff.budget_id,'handoffId',handoff.id,'alreadyConverted',true);
  end if;
  if estimate.status not in ('executed','converted_to_project') then raise exception 'Execute the construction agreement first'; end if;
  if estimate.status='executed' and estimate.is_current_version=false then raise exception 'Use the current executed agreement version'; end if;
  if coalesce(estimate.metadata->'precon'->>'purpose','construction_agreement')<>'construction_agreement' then raise exception 'Budget approval cannot authorize construction'; end if;
  if estimate.updated_at is distinct from p_expected_updated_at then raise exception 'The executed version changed. Reload before preparing handoff'; end if;
  if prospect.status='lost' then raise exception 'Reopen this lost prospect before handoff'; end if;
  if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'Cost scope is required'; end if;
  select coalesce(sum((x->>'amount_cents')::bigint),0) into total from jsonb_array_elements(p_lines) x;
  if total<0 then raise exception 'Invalid cost baseline'; end if;
  select * into project from public.projects where org_id=p_org_id and prospect_id=p_prospect_id for update;
  if project.id is not null then
    select * into contract from public.contracts where org_id=p_org_id and project_id=project.id and status='active' order by created_at desc limit 1 for update;
    if contract.id is not null and contract.snapshot->>'estimate_id' is distinct from p_estimate_id::text then
      if project.phase='precon' and contract.signed_at is null and coalesce(contract.total_cents,0)=0
        and contract.snapshot->>'billing_setup_source'='project_settings'
        and not exists(select 1 from public.invoices where project_id=project.id and org_id=p_org_id) then
        update public.contracts set status='superseded' where id=contract.id;
        contract:=null;
      else
        raise exception 'Existing active contract has a different source. Reconcile it before handoff';
      end if;
    end if;
    select * into budget from public.budgets where org_id=p_org_id and project_id=project.id and metadata->>'source_estimate_id'=p_estimate_id::text order by created_at desc limit 1 for update;
    -- Completed historical conversions keep their delivery state. Interrupted
    -- conversions continue below and are repaired within this transaction.
    if estimate.status='converted_to_project' and project.phase='delivery' and contract.id is not null and budget.id is not null
      and exists(select 1 from public.budget_lines where budget_id=budget.id) then
      return jsonb_build_object('projectId',project.id,'contractId',contract.id,'budgetId',budget.id,'handoffId',null,'alreadyConverted',true);
    end if;
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
  if project.id is null then
    insert into public.projects(org_id,prospect_id,name,status,phase,location,created_by)
      values(p_org_id,p_prospect_id,p_project->>'name','planning','precon',prospect.jobsite_location,p_actor_id) returning * into project;
  end if;
  update public.projects set name=p_project->>'name',phase='precon',status='planning',
    start_date=nullif(p_project->>'start_date','')::date,end_date=nullif(p_project->>'end_date','')::date,
    property_type=coalesce(nullif(p_project->>'property_type','')::public.project_property_type,property_type),
    project_type=coalesce(nullif(p_project->>'project_type','')::public.project_work_type,project_type),
    client_id=coalesce(client_id,primary_contact),description=coalesce(p_project->>'description',description,prospect.notes),
    total_value=round((p_commercial->>'total_cents')::numeric/100),total_contract_value_cents=(p_commercial->>'total_cents')::integer,
    retainage_percent=coalesce((p_commercial->>'retainage_percent')::numeric,0),updated_at=now()
    where id=project.id and org_id=p_org_id;
  update public.estimates set project_id=project.id where prospect_id=p_prospect_id and org_id=p_org_id;
  update public.bid_packages set project_id=project.id where prospect_id=p_prospect_id and org_id=p_org_id;
  update public.documents set project_id=project.id where prospect_id=p_prospect_id and org_id=p_org_id;
  update public.envelopes set project_id=project.id where prospect_id=p_prospect_id and org_id=p_org_id;
  update public.files set project_id=project.id,
    folder_path=case when folder_path like '/prospects/'||p_prospect_id||'%' then replace(folder_path,'/prospects/'||p_prospect_id,'/projects/'||project.id) else folder_path end
    where prospect_id=p_prospect_id and org_id=p_org_id;
  model:=p_commercial->>'billing_model';
  if contract.id is null then
    insert into public.contracts(org_id,project_id,title,status,total_cents,currency,signed_at,effective_date,terms,signature_data,
      contract_type,markup_percent,gmp_cents,fixed_fee_cents,retainage_percent,contingency_cents,snapshot)
    values(p_org_id,project.id,(p_project->>'name')||' Contract','active',(p_commercial->>'total_cents')::integer,coalesce(estimate.currency,'usd'),
      estimate.executed_at,coalesce(estimate.executed_at::date,current_date),p_commercial->>'terms',estimate.signature_data,
      case when model='time_and_materials' then 'time_materials' when model like 'cost_plus%' then 'cost_plus' else 'fixed' end,
      nullif(estimate.metadata->>'markup_percent','')::numeric,nullif(p_commercial->>'gmp_cents','0')::integer,
      nullif(p_commercial->>'fixed_fee_cents','0')::integer,coalesce((p_commercial->>'retainage_percent')::numeric,0),
      (p_commercial->>'contingency_cents')::integer,
      jsonb_build_object('estimate_id',estimate.id,'billing_model',model,'precon',p_commercial,'inclusions',estimate.metadata->'inclusions',
        'exclusions',estimate.metadata->'exclusions','accepted_options',estimate.metadata->'accepted_options',
        'contingency_cents',p_commercial->'contingency_cents','esign',jsonb_build_object('executed_file_id',estimate.executed_file_id,
        'envelope_id',estimate.signature_envelope_id,'document_id',estimate.signature_document_id))) returning * into contract;
  end if;
  if estimate.executed_file_id is not null then
    if not exists(select 1 from public.files where id=estimate.executed_file_id and org_id=p_org_id) then raise exception 'Executed file is not available in this organization'; end if;
    insert into public.file_links(org_id,file_id,project_id,entity_type,entity_id,link_role)
      select p_org_id,estimate.executed_file_id,project.id,'contract',contract.id,'executed_contract'
      where not exists(select 1 from public.file_links where org_id=p_org_id and file_id=estimate.executed_file_id and entity_type='contract' and entity_id=contract.id);
  end if;
  if budget.id is null then
    insert into public.budgets(org_id,project_id,version,status,total_cents,currency,metadata)
      values(p_org_id,project.id,(select coalesce(max(version),0)+1 from public.budgets where project_id=project.id),'draft',total,coalesce(estimate.currency,'usd'),
        jsonb_build_object('source','estimate_execution','source_estimate_id',estimate.id,'source_contract_id',contract.id,'contract_total_cents',p_commercial->'total_cents')) returning * into budget;
  elsif exists(select 1 from public.budget_lines where budget_id=budget.id) and budget.status in ('approved','locked') then
    raise exception 'Existing approved baseline needs explicit reconciliation before repairing handoff';
  else
    delete from public.budget_lines where budget_id=budget.id and org_id=p_org_id;
    update public.budgets set status='draft',total_cents=total where id=budget.id;
  end if;
  for line in select * from jsonb_array_elements(p_lines) loop
    if (line->>'amount_cents')::integer<0 and not
      (coalesce(line->'metadata'->>'accepted_optional','false')='true' and coalesce(line->'metadata'->>'alternate_kind','') in ('deduct','replacement')) then raise exception 'Negative baseline cost requires an accepted deduct alternate'; end if;
    if nullif(line->>'cost_code_id','') is not null and not exists(select 1 from public.cost_codes where id=(line->>'cost_code_id')::uuid and org_id=p_org_id) then raise exception 'Cost code belongs to a different organization'; end if;
    insert into public.budget_lines(org_id,budget_id,cost_code_id,description,amount_cents,sort_order,metadata)
      values(p_org_id,budget.id,nullif(line->>'cost_code_id','')::uuid,line->>'description',(line->>'amount_cents')::integer,(line->>'sort_order')::integer,line->'metadata');
    if line->'metadata'->>'is_allowance'='true' then
      insert into public.allowances(org_id,project_id,contract_id,name,budget_cents,metadata)
        select p_org_id,project.id,contract.id,line->>'description',(line->>'amount_cents')::integer,line->'metadata'
        where not exists(select 1 from public.allowances where org_id=p_org_id and project_id=project.id and metadata->>'source_estimate_item_id'=line->'metadata'->>'source_estimate_item_id');
    end if;
  end loop;
  insert into public.project_financial_settings(org_id,project_id,billing_model,open_book_required,metadata)
    values(p_org_id,project.id,model,model like 'cost_plus%',jsonb_build_object('source','estimate_execution','source_estimate_id',estimate.id))
    on conflict(org_id,project_id) do update set billing_model=excluded.billing_model,open_book_required=excluded.open_book_required,updated_at=now();
  insert into public.project_precon_handoffs(org_id,project_id,prospect_id,estimate_id,contract_id,budget_id)
    values(p_org_id,project.id,p_prospect_id,estimate.id,contract.id,budget.id) returning * into handoff;
  update public.prospects set status='won',won_at=coalesce(won_at,now()),updated_at=now() where id=p_prospect_id and org_id=p_org_id;
  update public.estimates set status='converted_to_project',updated_at=now() where id=estimate.id and org_id=p_org_id;
  insert into public.events(org_id,event_type,entity_type,entity_id,payload)
    values(p_org_id,'precon_handoff_prepared','project',project.id,jsonb_build_object('actor_id',p_actor_id,'handoff_id',handoff.id,'estimate_id',estimate.id,'contract_id',contract.id,'budget_id',budget.id));
  return jsonb_build_object('projectId',project.id,'contractId',contract.id,'budgetId',budget.id,'handoffId',handoff.id,'alreadyConverted',false);
end $$;
revoke all on function public.convert_executed_prospect_handoff(uuid,uuid,uuid,uuid,timestamptz,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.convert_executed_prospect_handoff(uuid,uuid,uuid,uuid,timestamptz,jsonb,jsonb,jsonb) to service_role;

-- Content fingerprint, not a timestamp: any financial/scope revision requires
-- the human to approve the exact current baseline again.
create function public.precon_baseline_signature(p_org_id uuid,p_project_id uuid)
returns text language sql stable security invoker set search_path='' as $$
 select md5(jsonb_build_object(
   'contract',to_jsonb(c)-'updated_at',
   'estimate',jsonb_build_object('id',e.id,'metadata',e.metadata,'total_cents',e.total_cents,'executed_at',e.executed_at),
   'items',(select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]') from public.estimate_items i where i.estimate_id=e.id),
   'budget',jsonb_build_object('total_cents',b.total_cents,'metadata',b.metadata),
   'lines',(select coalesce(jsonb_agg(to_jsonb(l)-'updated_at' order by l.id),'[]') from public.budget_lines l where l.budget_id=b.id)
 )::text)
 from public.project_precon_handoffs h join public.contracts c on c.id=h.contract_id
 join public.estimates e on e.id=h.estimate_id join public.budgets b on b.id=h.budget_id
 where h.org_id=p_org_id and h.project_id=p_project_id
$$;
revoke all on function public.precon_baseline_signature(uuid,uuid) from public,anon,authenticated;
grant execute on function public.precon_baseline_signature(uuid,uuid) to service_role;

create function public.transition_precon_handoff(p_org_id uuid,p_project_id uuid,p_actor_id uuid,p_action text,p_review jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 h public.project_precon_handoffs%rowtype; signature text; check_key text; entry jsonb;
 line_total bigint; header_total bigint; uncoded integer; edited_line public.budget_lines%rowtype;
begin
 select * into h from public.project_precon_handoffs where org_id=p_org_id and project_id=p_project_id for update;
 if not found then raise exception 'Prepare the executed agreement handoff first'; end if;
 if not exists(select 1 from public.contracts where id=h.contract_id and org_id=p_org_id and project_id=p_project_id and status='active') then
   raise exception 'The signed contract is no longer active. Reconcile the handoff with the current agreement';
 end if;
 if h.status='released' then
   if p_action='release' then return to_jsonb(h); end if;
   raise exception 'This project is already released; use the delivery change process';
 end if;
 select public.precon_baseline_signature(p_org_id,p_project_id) into signature;
 if p_action='edit_baseline' then
   if h.status<>'awarded' then raise exception 'Only a baseline awaiting approval can be edited'; end if;
   if signature is distinct from p_review->>'expected_revision' then raise exception 'The baseline changed. Reload before editing'; end if;
   if length(btrim(coalesce(p_review->>'reason','')))<3 or nullif(btrim(p_review->>'description'),'') is null then raise exception 'Describe the cost scope and reason for changing it'; end if;
   select * into edited_line from public.budget_lines where id=(p_review->>'line_id')::uuid and budget_id=h.budget_id and org_id=p_org_id for update;
   if not found then raise exception 'Budget line not found in this baseline'; end if;
   if (p_review->>'amount_cents')::integer<0 and not
      (coalesce(edited_line.metadata->>'accepted_optional','false')='true' and coalesce(edited_line.metadata->>'alternate_kind','') in ('deduct','replacement')) then raise exception 'Negative costs require an accepted deduct alternate'; end if;
   if nullif(p_review->>'cost_code_id','') is not null and not exists(select 1 from public.cost_codes where id=(p_review->>'cost_code_id')::uuid and org_id=p_org_id) then raise exception 'Cost code is not available in this organization'; end if;
   update public.budget_lines set description=p_review->>'description',amount_cents=(p_review->>'amount_cents')::integer,
     cost_code_id=nullif(p_review->>'cost_code_id','')::uuid,
     metadata=metadata||jsonb_build_object('baseline_adjustment_reason',p_review->>'reason','baseline_adjusted_by',p_actor_id,
       'original_estimate_cost_cents',coalesce(metadata->'original_estimate_cost_cents',to_jsonb(amount_cents))) where id=edited_line.id;
   select sum(amount_cents) into line_total from public.budget_lines where budget_id=h.budget_id and org_id=p_org_id;
   if line_total<0 then raise exception 'Baseline total cannot be negative'; end if;
   update public.budgets set total_cents=line_total,status='draft',updated_at=now() where id=h.budget_id and org_id=p_org_id;
   select * into h from public.project_precon_handoffs where id=h.id;
 elsif p_action='approve_baseline' then
   if coalesce(p_review->>'scope_reviewed','false')<>'true' then raise exception 'Review signed scope, exclusions, allowances and unresolved decisions before approving the baseline'; end if;
   select sum(amount_cents),count(*) filter(where cost_code_id is null and not (metadata ? 'reserve_treatment')) into line_total,uncoded from public.budget_lines where budget_id=h.budget_id;
   select total_cents into header_total from public.budgets where id=h.budget_id and org_id=p_org_id for update;
   if line_total is null or line_total is distinct from header_total then raise exception 'Budget lines must reconcile to the baseline total'; end if;
   if uncoded>0 and nullif(btrim(p_review->>'coding_exception'),'') is null then raise exception 'Map uncoded costs or record why this baseline does not require cost codes'; end if;
   update public.budgets set status='approved',updated_at=now() where id=h.budget_id and org_id=p_org_id;
   update public.project_precon_handoffs set status='baseline_approved',baseline_signature=signature,
     baseline_review=p_review,baseline_approved_at=now(),baseline_approved_by=p_actor_id,
     accepted_at=null,accepted_by=null,readiness='{}',updated_at=now() where id=h.id returning * into h;
 elsif p_action in ('accept','release') then
   if h.baseline_signature is null or h.baseline_signature is distinct from signature then raise exception 'The source or cost baseline changed. Review and approve it again'; end if;
   if p_action='accept' then
     if h.status not in ('baseline_approved','accepted') then raise exception 'Approve the cost baseline first'; end if;
     if nullif(btrim(p_review->>'delivery_lead'),'') is null then raise exception 'Name the accountable delivery lead'; end if;
     foreach check_key in array array['scope','documents','procurement','permits','start_authorization'] loop
       entry:=p_review->'checks'->check_key;
       if coalesce(entry->>'confirmed','false')<>'true' and nullif(btrim(entry->>'exception'),'') is null then
         raise exception 'Confirm readiness or document an exception for %',check_key;
       end if;
     end loop;
     update public.project_precon_handoffs set status='accepted',readiness=p_review,accepted_at=now(),accepted_by=p_actor_id,updated_at=now() where id=h.id returning * into h;
   else
     if h.status<>'accepted' then raise exception 'Delivery must accept the handoff before start authorization'; end if;
     if exists(select 1 from public.precon_decisions where org_id=p_org_id and prospect_id=h.prospect_id and status='open' and blocks_start) then raise exception 'Resolve or explicitly waive the open start blockers first'; end if;
     update public.projects set phase='delivery',status='active',updated_at=now() where id=p_project_id and org_id=p_org_id;
     update public.project_precon_handoffs set status='released',released_at=now(),released_by=p_actor_id,updated_at=now() where id=h.id returning * into h;
   end if;
 else raise exception 'Unknown handoff action';
 end if;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload)
 values(p_org_id,'precon_handoff_'||p_action,'project',p_project_id,jsonb_build_object('actor_id',p_actor_id,'handoff_id',h.id,'status',h.status,'review',p_review));
 return to_jsonb(h);
end $$;
revoke all on function public.transition_precon_handoff(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.transition_precon_handoff(uuid,uuid,uuid,text,jsonb) to service_role;

-- Serialize cost edits with acceptance/release and visibly invalidate prior
-- reviews. Released projects continue to use the normal budget change process.
create function public.invalidate_precon_budget_review() returns trigger language plpgsql security definer set search_path='' as $$
declare target_budget uuid;
begin
 if tg_table_name='budgets' then target_budget:=new.id;
 else target_budget:=coalesce(new.budget_id,old.budget_id); end if;
 update public.project_precon_handoffs set status='awarded',baseline_signature=null,
   baseline_approved_at=null,baseline_approved_by=null,accepted_at=null,accepted_by=null,updated_at=now()
   where budget_id=target_budget and status<>'released';
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
revoke all on function public.invalidate_precon_budget_review() from public,anon,authenticated;
create trigger precon_budget_lines_invalidate after insert or update or delete on public.budget_lines for each row execute function public.invalidate_precon_budget_review();
create trigger precon_budget_header_invalidate after update of total_cents,metadata on public.budgets for each row execute function public.invalidate_precon_budget_review();

create function public.invalidate_precon_scope_review() returns trigger language plpgsql security definer set search_path='' as $$
declare source_id uuid;
begin
 if tg_table_name='estimate_items' then source_id:=coalesce(new.estimate_id,old.estimate_id);
 else source_id:=new.id; end if;
 update public.project_precon_handoffs set status='awarded',baseline_signature=null,
   baseline_approved_at=null,baseline_approved_by=null,accepted_at=null,accepted_by=null,updated_at=now()
   where status<>'released' and
   ((tg_table_name='contracts' and contract_id=source_id) or (tg_table_name<>'contracts' and estimate_id=source_id));
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
revoke all on function public.invalidate_precon_scope_review() from public,anon,authenticated;
create trigger precon_contract_invalidate after update on public.contracts for each row execute function public.invalidate_precon_scope_review();
create trigger precon_estimate_scope_invalidate after update of metadata,total_cents on public.estimates for each row execute function public.invalidate_precon_scope_review();
create trigger precon_estimate_items_invalidate after insert or update or delete on public.estimate_items for each row execute function public.invalidate_precon_scope_review();
