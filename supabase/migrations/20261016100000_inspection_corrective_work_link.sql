-- EP09-04: corrective work from a failed inspection item is created AND linked in one
-- transaction, the link cannot be written through the data API, and legacy completed
-- failures are reconciled onto the lifecycle without inventing evidence.

-- 1. One transaction: the punch item, its link on the failed item, the item's photo as
--    "before" evidence, and the event and audit rows. The item, its inspection and the
--    punch item are all in the same org and home by construction (the item is looked up
--    through its inspection in p_home; the punch item is inserted into p_home).
create function public.raise_inspection_corrective_work(p_org uuid, p_home uuid, p_actor uuid, p_item uuid, p_punch jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 it public.inspection_items; insp public.inspections; punch public.punch_items;
 company uuid:=nullif(p_punch->>'assigned_company_id','')::uuid; person uuid:=nullif(p_punch->>'assigned_to','')::uuid;
 place uuid:=nullif(p_punch->>'location_id','')::uuid;
begin
 perform public.assert_inspection_lifecycle_actor(p_org,p_home,p_actor,'inspection.write');
 select * into insp from public.inspections where org_id=p_org and project_id=p_home and id=(select inspection_id from public.inspection_items where org_id=p_org and id=p_item) for update;
 if not found then raise exception 'Inspection item belongs to another home or is unavailable';end if;
 select * into it from public.inspection_items where org_id=p_org and inspection_id=insp.id and id=p_item for update;
 if not (it.is_deficient or (it.response_type='pass_fail' and it.response='fail')) then raise exception 'Corrective punch work requires a deficient inspection item';end if;
 if it.punch_item_id is not null then raise exception 'This item already has a punch item';end if;
 if company is null and person is null then raise exception 'Choose the company or person responsible for this corrective work';end if;
 if company is not null and not exists(select 1 from public.companies where org_id=p_org and id=company) then raise exception 'Assigned company not found';end if;
 if person is not null and not exists(select 1 from public.memberships where org_id=p_org and user_id=person and status='active') then raise exception 'Assignee is not a member of this organization';end if;
 if place is not null and not exists(select 1 from public.project_locations where org_id=p_org and project_id=p_home and id=place and is_active) then raise exception 'Location not found or inactive';end if;
 insert into public.punch_items(org_id,project_id,title,description,status,due_date,severity,location_id,location,assigned_to,assigned_company_id,dispatched_at,verification_required,created_from_inspection,created_by)
 values(p_org,p_home,p_punch->>'title',nullif(p_punch->>'description',''),'open',nullif(p_punch->>'due_date','')::date,nullif(p_punch->>'severity',''),place,nullif(p_punch->>'location',''),person,company,case when company is not null then now() end,true,true,p_actor)
 returning * into punch;
 update public.inspection_items set punch_item_id=punch.id where org_id=p_org and id=it.id;
 if it.photo_file_id is not null then
  insert into public.file_links(org_id,project_id,file_id,entity_type,entity_id,link_role,created_by) values(p_org,p_home,it.photo_file_id,'punch_item',punch.id,'before',p_actor);
 end if;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org,'punch_item_created','punch_item',punch.id,jsonb_build_object('actor_id',p_actor,'project_id',p_home,'title',punch.title,'from_inspection',insp.id,'inspection_item_id',it.id),'activity');
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org,p_actor,'insert','punch_item',punch.id,to_jsonb(punch),'inspection_corrective_work_transaction');
 return jsonb_build_object('punchItemId',punch.id,'inspectionItemId',it.id);
end $$;
revoke all on function public.raise_inspection_corrective_work(uuid,uuid,uuid,uuid,jsonb) from public,anon;
grant execute on function public.raise_inspection_corrective_work(uuid,uuid,uuid,uuid,jsonb) to authenticated,service_role;

-- 2. Member-write guard: the link from a failed item to its corrective work is written only
--    by the function above (it runs as its owner). A member's own write through the data API
--    can neither forge a link nor re-point or clear one. Invoker function, so current_user is
--    the role that issued the statement.
create function public.guard_inspection_corrective_link() returns trigger language plpgsql set search_path='' as $$
begin
 if current_user in ('anon','authenticated') and new.punch_item_id is distinct from (case when tg_op='UPDATE' then old.punch_item_id end) then
  raise exception 'Corrective work links are written only when the work is raised' using errcode='42501';
 end if;
 return new;
end $$;
create trigger inspection_item_corrective_link before insert or update of punch_item_id on public.inspection_items for each row execute function public.guard_inspection_corrective_link();

-- 3. Reinspecting a reconciled legacy failure (see 4). It never had a completion receipt, so
--    it can be reinspected against its current evidence but never reviewed or accepted.
create or replace function public.mutate_inspection_obligation(p_org uuid,p_home uuid,p_actor uuid,p_key uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare op text:=p_request->>'operation';o public.inspection_obligations;i public.inspections;
 previous public.inspection_attempts;receipt public.inspection_lifecycle_receipts;completion public.inspection_completion_receipts;
 answer jsonb;corrections jsonb;new_id uuid;eid uuid;aid bigint;seq integer;prior_source jsonb;has_receipt boolean;
begin
 if p_key is null or op not in('create','reinspect','accept','reject') or jsonb_typeof(p_request) is distinct from 'object' then raise exception 'Invalid inspection lifecycle request';end if;
 perform public.assert_inspection_lifecycle_actor(p_org,p_home,p_actor,case when op in('accept','reject') then 'inspection.review' else 'inspection.write' end);
 -- Project serialization fences newly inserted obligations against final closing.
 perform 1 from public.projects where org_id=p_org and id=p_home for update;
 perform pg_advisory_xact_lock(hashtextextended('inspection-request:'||p_key::text,0));
 select * into receipt from public.inspection_lifecycle_receipts where id=p_key;
 if found then
  if receipt.org_id<>p_org or receipt.project_id<>p_home or receipt.actor_id<>p_actor or receipt.request is distinct from p_request then raise exception 'Inspection request key belongs to a different original request';end if;
  return receipt.response;
 end if;
 if exists(select 1 from public.closings where org_id=p_org and project_id=p_home and status in('closed','cancelled')) then raise exception 'Closed or cancelled home inspection obligations are immutable';end if;
 if op='create' then
  select * into i from public.inspections where org_id=p_org and project_id=p_home and id=(p_request->>'inspectionId')::uuid for update;
  if not found then raise exception 'Initial inspection belongs to another home or is unavailable';end if;
  perform 1 from public.inspection_items where org_id=p_org and inspection_id=i.id order by id for update;
  if p_request->'source' is distinct from public.inspection_review_source(p_org,i.id) then raise exception 'Initial obligation inspection evidence changed';end if;
  if exists(select 1 from public.inspection_attempts where inspection_id=i.id) then raise exception 'Inspection already belongs to an obligation';end if;
  if i.status='completed' and not exists(select 1 from public.inspection_completion_receipts where inspection_id=i.id and org_id=p_org) then raise exception 'Legacy completed attempt needs governed reconciliation';end if;
  insert into public.inspection_obligations(org_id,project_id,source_inspection_id,title,created_by) values(p_org,p_home,i.id,i.title,p_actor) returning * into o;
  insert into public.inspection_attempts(org_id,obligation_id,inspection_id,attempt_number,created_by) values(p_org,o.id,i.id,1,p_actor);
  -- A previously completed unbound pass cannot be retroactively trusted as an
  -- obligation without its receipt and the same independent review below.
  answer:=jsonb_build_object('obligationId',o.id,'inspectionId',i.id,'attemptNumber',1);
 else
  select * into o from public.inspection_obligations where org_id=p_org and project_id=p_home and id=(p_request->>'obligationId')::uuid for update;
  if not found then raise exception 'Inspection obligation belongs to another home or is unavailable';end if;
  select * into previous from public.inspection_attempts where org_id=p_org and obligation_id=o.id order by attempt_number desc limit 1;
  if previous.inspection_id is distinct from (p_request->>'inspectionId')::uuid then raise exception 'Inspection obligation has a newer attempt';end if;
  select * into i from public.inspections where org_id=p_org and project_id=p_home and id=previous.inspection_id for update;
  select * into completion from public.inspection_completion_receipts where org_id=p_org and project_id=p_home and inspection_id=i.id;
  has_receipt:=found;
  -- A completed attempt with no receipt is a reconciled legacy failure: it can be reinspected
  -- (its current evidence must still match the reviewed source) but never reviewed or accepted.
  if i.status<>'completed' or (has_receipt and (completion.source is distinct from p_request->'source' or completion.source is distinct from public.inspection_review_source(p_org,i.id) or completion.result is distinct from i.result))
   or (not has_receipt and (i.result is distinct from 'fail' or op<>'reinspect' or p_request->'source' is distinct from public.inspection_review_source(p_org,i.id))) then raise exception 'Current inspection completion evidence is missing or changed';end if;
  if o.accepted_inspection_id is not null then raise exception 'Accepted inspection obligation is immutable';end if;
  if op='reinspect' then
   if i.result='pass' and not exists(select 1 from public.inspection_lifecycle_receipts l where l.org_id=p_org and l.project_id=p_home and l.request->>'operation'='reject' and l.response->>'obligationId'=o.id::text and l.response->>'inspectionId'=i.id::text) then raise exception 'Passing attempt awaits review; do not replace it';end if;
   perform 1 from public.inspection_items where org_id=p_org and inspection_id=i.id order by id for update;
   select coalesce(jsonb_agg(jsonb_build_object('failedItemId',c.id,'punchId',c.punch_item_id) order by c.id),'[]') into corrections from public.inspection_items c where c.org_id=p_org and c.inspection_id=i.id and (c.is_deficient or (c.response_type='pass_fail' and c.response='fail'));
   if p_request->'correctionLinks' is distinct from corrections then raise exception 'Reviewed corrective work links changed; review the current assignments';end if;
   perform 1 from public.punch_items where org_id=p_org and project_id=p_home and id in(select punch_item_id from public.inspection_items where org_id=p_org and inspection_id=i.id and (is_deficient or (response_type='pass_fail' and response='fail'))) order by id for share;
   if exists(select 1 from public.inspection_items c where c.org_id=p_org and c.inspection_id=i.id and (c.is_deficient or (c.response_type='pass_fail' and c.response='fail')) and not exists(select 1 from public.punch_items p where p.org_id=p_org and p.project_id=p_home and p.id=c.punch_item_id and p.status in('closed','resolved'))) then raise exception 'Resolve the linked corrective punch work before reinspection';end if;
   if length(btrim(coalesce(p_request->>'correctionNote','')))<10 then raise exception 'Document corrective evidence before reinspection';end if;
   select coalesce(jsonb_agg(jsonb_build_object('failedItemId',c.id,'punchId',p.id,'punchEvidence',to_jsonb(p)) order by c.id),'[]') into corrections
   from public.inspection_items c join public.punch_items p on p.id=c.punch_item_id and p.org_id=c.org_id and p.project_id=p_home where c.org_id=p_org and c.inspection_id=i.id and (c.is_deficient or (c.response_type='pass_fail' and c.response='fail'));
   corrections:=jsonb_build_object('note',p_request->>'correctionNote','items',corrections,'priorCompletion',case when has_receipt then to_jsonb(completion) else null end);
   new_id:=gen_random_uuid();seq:=previous.attempt_number+1;
   insert into public.inspections(id,org_id,project_id,inspection_number,template_id,kind,title,status,location,location_id,company_id,schedule_item_id,metadata)
   values(new_id,p_org,p_home,public.next_inspection_number(p_home),i.template_id,i.kind,i.title,'draft',i.location,i.location_id,i.company_id,i.schedule_item_id,jsonb_build_object('prior_inspection_id',i.id,'obligation_id',o.id));
   insert into public.inspection_items(org_id,inspection_id,section,prompt,response_type,sort_order)
   select p_org,new_id,section,prompt,response_type,sort_order from public.inspection_items where org_id=p_org and inspection_id=i.id order by sort_order,id;
   insert into public.inspection_attempts(org_id,obligation_id,inspection_id,attempt_number,prior_inspection_id,created_by,correction_evidence) values(p_org,o.id,new_id,seq,i.id,p_actor,corrections);
   answer:=jsonb_build_object('obligationId',o.id,'inspectionId',new_id,'attemptNumber',seq);
  else
   if completion.result<>'pass' then raise exception 'Only a passing current attempt can be reviewed';end if;
   if completion.actor_id=p_actor then raise exception 'An independent reviewer must review the completed attempt';end if;
   if length(btrim(coalesce(p_request->>'reviewNote','')))<10 then raise exception 'Document the inspection review decision';end if;
   if op='accept' then
    update public.inspection_obligations set accepted_inspection_id=i.id where org_id=p_org and id=o.id;
    if i.schedule_item_id is not null then
     update public.schedule_items set status='completed',progress=100 where org_id=p_org and project_id=p_home and id=i.schedule_item_id and status<>'cancelled';
     if not found then raise exception 'Accepted inspection scheduled work changed or was cancelled';end if;
    end if;
   end if;
   answer:=jsonb_build_object('obligationId',o.id,'inspectionId',i.id,'decision',op);
  end if;
 end if;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org,'inspection_obligation_'||op,'inspection',i.id,jsonb_build_object('actor_id',p_actor,'project_id',p_home,'response',answer),'activity') returning id into eid;
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org,p_actor,'update','inspection',i.id,jsonb_build_object('request',p_request,'response',answer),'inspection_obligation_transaction') returning id into aid;
 insert into public.inspection_lifecycle_receipts(id,org_id,project_id,actor_id,request,response,event_id,audit_id) values(p_key,p_org,p_home,p_actor,p_request,answer,eid,aid);
 return answer;
end $$;

-- 4. Reconciliation of legacy completed inspections (one-time, idempotent: a row is only
--    reconciled while it has neither a completion receipt nor an attempt).
--    Completed FAIL with a recorded inspector -> a non-gating obligation (required_for_closing
--    false, so a closing that was clear yesterday is not retroactively blocked) and attempt 1,
--    created by that inspector. The attempt carries no receipt, event or audit row: none was
--    recorded then and none is invented now. It can be reinspected once its failed items have
--    resolved corrective work. Completed PASS / partial inspections, and failures with no
--    recorded inspector, are left as history and get no obligation.
with legacy as (
 select i.id, i.org_id, i.project_id, i.title, i.inspector_user_id from public.inspections i
 where i.status='completed' and i.result='fail' and i.inspector_user_id is not null
 and exists(select 1 from public.app_users u where u.id=i.inspector_user_id)
 and not exists(select 1 from public.inspection_completion_receipts r where r.inspection_id=i.id)
 and not exists(select 1 from public.inspection_attempts a where a.inspection_id=i.id)
), made as (
 insert into public.inspection_obligations(org_id,project_id,source_inspection_id,title,required_for_closing,created_by)
 select org_id,project_id,id,left(title,200),false,inspector_user_id from legacy where length(btrim(title))>0
 on conflict(org_id,source_inspection_id) do nothing
 returning id,org_id,source_inspection_id,created_by
)
insert into public.inspection_attempts(org_id,obligation_id,inspection_id,attempt_number,created_by)
select org_id,id,source_inspection_id,1,created_by from made;
