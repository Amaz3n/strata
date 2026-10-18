-- STAGED / UNAPPLIED. Requires server/client cutover, legacy completion reconciliation,
-- full-schema/current-JWT and independently concurrent PostgreSQL acceptance.
create table public.inspection_obligations (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id),
 project_id uuid not null references public.projects(id), source_inspection_id uuid not null references public.inspections(id),
 title text not null check(length(btrim(title)) between 1 and 200), required_for_closing boolean not null default true,
 accepted_inspection_id uuid references public.inspections(id), created_by uuid not null references public.app_users(id),
 created_at timestamptz not null default now(), unique(org_id,source_inspection_id), unique(org_id,id)
);
create table public.inspection_attempts (
 inspection_id uuid primary key references public.inspections(id), org_id uuid not null,
 obligation_id uuid not null, attempt_number integer not null check(attempt_number>0),
 prior_inspection_id uuid references public.inspections(id), created_by uuid not null references public.app_users(id),
 correction_evidence jsonb not null default '[]', created_at timestamptz not null default now(),
 foreign key(org_id,obligation_id) references public.inspection_obligations(org_id,id),
 unique(obligation_id,attempt_number)
);
create table public.inspection_completion_receipts (
 inspection_id uuid primary key references public.inspections(id),org_id uuid not null references public.orgs(id),
 project_id uuid not null references public.projects(id),actor_id uuid not null references public.app_users(id),
 source jsonb not null,result text not null check(result in('pass','fail','partial')),
 event_id uuid not null references public.events(id),audit_id bigint not null references public.audit_log(id),created_at timestamptz not null default now()
);
create table public.inspection_lifecycle_receipts (
 id uuid primary key,org_id uuid not null references public.orgs(id),project_id uuid not null references public.projects(id),
 actor_id uuid not null references public.app_users(id),request jsonb not null,response jsonb not null,
 event_id uuid not null references public.events(id),audit_id bigint not null references public.audit_log(id),created_at timestamptz not null default now()
);
create index inspection_obligations_home on public.inspection_obligations(org_id,project_id,id);
create index inspection_attempts_obligation on public.inspection_attempts(org_id,obligation_id,inspection_id);
create index inspection_attempts_prior on public.inspection_attempts(prior_inspection_id);
create index inspection_obligations_accepted on public.inspection_obligations(accepted_inspection_id);
create index inspection_obligations_actor on public.inspection_obligations(created_by);
create index inspection_attempts_actor on public.inspection_attempts(created_by);
create index inspection_completion_home on public.inspection_completion_receipts(org_id,project_id,inspection_id);
create index inspection_completion_actor on public.inspection_completion_receipts(actor_id);
create index inspection_completion_event on public.inspection_completion_receipts(event_id);
create index inspection_completion_audit on public.inspection_completion_receipts(audit_id);
create index inspection_lifecycle_home on public.inspection_lifecycle_receipts(org_id,project_id,id);
create index inspection_lifecycle_actor on public.inspection_lifecycle_receipts(actor_id);
create index inspection_lifecycle_event on public.inspection_lifecycle_receipts(event_id);
create index inspection_lifecycle_audit on public.inspection_lifecycle_receipts(audit_id);
create function public.guard_inspection_history() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Inspection lifecycle history is immutable'; end $$;
create trigger inspection_attempt_history before update or delete on public.inspection_attempts for each row execute function public.guard_inspection_history();
create trigger inspection_completion_history before update or delete on public.inspection_completion_receipts for each row execute function public.guard_inspection_history();
create trigger inspection_lifecycle_history before update or delete on public.inspection_lifecycle_receipts for each row execute function public.guard_inspection_history();
do $$declare t text;begin foreach t in array array['inspection_obligations','inspection_attempts','inspection_completion_receipts','inspection_lifecycle_receipts'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 execute format('grant select on public.%I to service_role',t);
end loop;end $$;
insert into public.permissions(key,description) values('inspection.review','Review passing inspection attempts and accept required obligations') on conflict(key) do nothing;
insert into public.role_permissions(role_id,permission_key) select id,'inspection.review' from public.roles where key in('org_owner','org_admin','org_project_lead','pm') on conflict do nothing;

create function public.assert_inspection_lifecycle_actor(p_org_id uuid,p_project_id uuid,p_actor_id uuid,p_permission text)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare
 members uuid[]; org_roles uuid[]; project_roles uuid[]; platform_roles uuid[]; all_roles uuid[];
 base_permissions text[]; org_permissions text[]; project_permissions text[]; platform_permissions text[];
 grants text[]; denies text[]; effective text[]; org_effective text[];
 assigned_only boolean; division_assigned boolean; project_member boolean; home_division uuid; divisions uuid[];
begin
 if auth.uid() is distinct from p_actor_id and (auth.uid() is not null or current_setting('role',true)<>'service_role') then raise exception 'Inspection actor identity differs from authenticated session' using errcode='42501';end if;
 if p_permission not in('inspection.write','inspection.review','project.read','closing.manage') then raise exception 'Invalid inspection operation permission';end if;
 if p_org_id is null or p_project_id is null or p_actor_id is null then raise exception 'Inspection lifecycle authorization identity is required' using errcode='42501'; end if;
 -- Parent locks also fence FK-backed new memberships, project grants and role
 -- permission/override inserts. Validate actual FK/lock order in full-schema QA.
 perform 1 from public.app_users where id=p_actor_id for update;
 if not found then raise exception 'Inspection lifecycle actor not found' using errcode='42501'; end if;
 perform 1 from public.permissions where key=p_permission for share;
 if not found then raise exception 'Inspection lifecycle write permission is not registered' using errcode='42501'; end if;
 select division_id into home_division from public.projects where id=p_project_id and org_id=p_org_id for update;
 if not found then raise exception 'Inspection lifecycle authorization home belongs to another organization or is unavailable' using errcode='42501'; end if;
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id order by id for update;
 perform 1 from public.project_members where org_id=p_org_id and project_id=p_project_id and user_id=p_actor_id order by id for update;
 perform 1 from public.platform_memberships where user_id=p_actor_id order by id for update;
 select coalesce(array_agg(id),'{}'),coalesce(array_agg(distinct role_id),'{}'),coalesce(bool_or(project_scope='assigned'),false),coalesce(bool_or(division_scope='assigned'),false)
 into members,org_roles,assigned_only,division_assigned from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active';
 select coalesce(array_agg(distinct role_id),'{}'),count(*)>0 into project_roles,project_member from public.project_members where org_id=p_org_id and project_id=p_project_id and user_id=p_actor_id and status='active';
 select coalesce(array_agg(distinct role_id),'{}') into platform_roles from public.platform_memberships where user_id=p_actor_id and status='active';
 all_roles:=org_roles||project_roles||platform_roles;
 -- Permission removals are fenced by their existing-row SHARE locks. Adding
 -- another role grant cannot revoke an already-proven allow; SHARE here avoids
 -- serializing all signing work for every actor using the same role.
 perform 1 from public.roles where id=any(all_roles) order by id for share;
 perform 1 from public.role_permissions where role_id=any(all_roles) order by role_id,permission_key for share;
 perform 1 from public.membership_permission_overrides where membership_id=any(members) order by membership_id,permission_key for share;
 select coalesce(array_agg(distinct permission_key),'{}') into base_permissions from public.role_permissions where role_id=any(org_roles);
 select coalesce(array_agg(distinct permission_key),'{}') into project_permissions from public.role_permissions where role_id=any(project_roles);
 -- Evaluate expiry after waits for all locked permission facts.
 select coalesce(array_agg(distinct rp.permission_key),'{}') into platform_permissions from public.platform_memberships pm join public.role_permissions rp on rp.role_id=pm.role_id
 where pm.user_id=p_actor_id and pm.status='active' and (pm.expires_at is null or pm.expires_at>clock_timestamp());
 if '*'=any(platform_permissions) or 'platform.org.access'=any(platform_permissions) then return; end if;
 if cardinality(members)=0 then raise exception 'Inspection actor has no active organization membership' using errcode='42501';end if;
 select coalesce(array_agg(permission_key) filter(where effect='grant'),'{}'),coalesce(array_agg(permission_key) filter(where effect='deny'),'{}') into grants,denies
 from public.membership_permission_overrides where membership_id=any(members);
 org_permissions:=base_permissions||grants;
 select coalesce(array_agg(distinct x),'{}') into org_effective from unnest(org_permissions||platform_permissions) x where not(x=any(denies));
 if p_permission=any(denies) or (p_permission<>'project.read' and not(p_permission=any(org_effective) or '*'=any(org_effective))) then raise exception 'Inspection lifecycle actor lacks organization write permission' using errcode='42501'; end if;
 if not project_member and not('*'=any(org_permissions) or 'org.admin'=any(org_permissions) or (not assigned_only and ('project.read'=any(org_permissions) or 'project.manage'=any(org_permissions)))) then
  raise exception 'Inspection lifecycle home is outside actor assigned project access' using errcode='42501';
 end if;
 select coalesce(array_agg(distinct x),'{}') into effective from unnest(org_permissions||project_permissions||platform_permissions) x where not(x=any(denies));
 if not(p_permission=any(effective) or '*'=any(effective)) then raise exception 'Inspection lifecycle actor lacks home write permission' using errcode='42501'; end if;
 if division_assigned and not('org.admin'=any(effective)) then
  perform 1 from public.membership_divisions where membership_id=any(members) order by membership_id,division_id for share;
  select coalesce(array_agg(distinct division_id),'{}') into divisions from public.membership_divisions where membership_id=any(members);
  if home_division is null or not(home_division=any(divisions)) then raise exception 'Inspection lifecycle home is outside actor division access' using errcode='42501'; end if;
 end if;
end $$;
revoke all on function public.assert_inspection_lifecycle_actor(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;

-- The reviewed source excludes outcome fields and downstream corrective links;
-- completion must preserve all original checklist answers and attachment identities.
create function public.inspection_review_source(p_org uuid,p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',i.id,'project_id',i.project_id,'title',i.title,'kind',i.kind,'template_id',i.template_id,
 'location_id',i.location_id,'company_id',i.company_id,'schedule_item_id',i.schedule_item_id,'notes',i.notes,
 'location',i.location,'inspector_name',i.inspector_name,'inspection_number',i.inspection_number,'metadata',i.metadata,
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'inspection_id',c.inspection_id,'section',c.section,'prompt',c.prompt,
 'response_type',c.response_type,'response',c.response,'is_deficient',c.is_deficient,'note',c.note,'photo_file_id',c.photo_file_id,'sort_order',c.sort_order) order by c.id)
 from public.inspection_items c where c.org_id=p_org and c.inspection_id=i.id),'[]'))
 from public.inspections i where i.org_id=p_org and i.id=p_id;
$$;
create function public.guard_inspection_attempt_evidence() returns trigger
language plpgsql security definer set search_path='' as $$
declare parent public.inspections; tenant uuid;home uuid;key uuid;
begin
 if tg_table_name='inspections' then
  if tg_op='DELETE' then parent:=old;else parent:=new;end if;
  if tg_op='UPDATE' and (new.id,new.org_id,new.project_id) is distinct from(old.id,old.org_id,old.project_id) then raise exception 'Inspection identity cannot change';end if;
  if tg_op<>'INSERT' and old.status='completed' then
   if tg_op='DELETE' or (to_jsonb(new)-array['pdf_file_id','updated_at']) is distinct from(to_jsonb(old)-array['pdf_file_id','updated_at']) then raise exception 'Completed inspection attempt evidence is immutable';end if;
  end if;
  if tg_op<>'DELETE' and new.status='completed' and (tg_op='INSERT' or old.status is distinct from 'completed') then
   if not exists(select 1 from public.inspection_completion_receipts r where r.org_id=new.org_id and r.inspection_id=new.id and r.project_id=new.project_id and r.result=new.result and r.source=public.inspection_review_source(new.org_id,new.id)) then raise exception 'Inspection completion requires its original atomic receipt';end if;
  end if;
 else
  if tg_op='DELETE' then tenant:=old.org_id;key:=old.inspection_id;else tenant:=new.org_id;key:=new.inspection_id;end if;
  if tg_op='UPDATE' and (new.id,new.org_id,new.inspection_id) is distinct from(old.id,old.org_id,old.inspection_id) then raise exception 'Inspection item identity cannot change';end if;
  select * into parent from public.inspections where org_id=tenant and id=key for update;
  if not found then raise exception 'Inspection item parent is unavailable';end if;
  if parent.status='completed' and (tg_op<>'UPDATE' or (to_jsonb(new)-array['punch_item_id','observation_id']) is distinct from(to_jsonb(old)-array['punch_item_id','observation_id'])) then raise exception 'Completed inspection checklist evidence is immutable';end if;
  if tg_op<>'DELETE' and new.photo_file_id is not null and not exists(select 1 from public.files where org_id=tenant and project_id=parent.project_id and id=new.photo_file_id and archived_at is null) then raise exception 'Inspection photo belongs to another home or is unavailable';end if;
  if tg_op<>'DELETE' and new.punch_item_id is not null and not exists(select 1 from public.punch_items where org_id=tenant and project_id=parent.project_id and id=new.punch_item_id) then raise exception 'Corrective punch work belongs to another home';end if;
 end if;
 if auth.uid() is not null then perform public.assert_inspection_lifecycle_actor(parent.org_id,parent.project_id,auth.uid(),'inspection.write');end if;
 if tg_op='DELETE' then return old;else return new;end if;
end $$;
create trigger inspection_attempt_evidence before insert or update or delete on public.inspections for each row execute function public.guard_inspection_attempt_evidence();
create trigger inspection_item_attempt_evidence before insert or update or delete on public.inspection_items for each row execute function public.guard_inspection_attempt_evidence();

create function public.complete_inspection_attempt(p_org uuid,p_home uuid,p_id uuid,p_actor uuid,p_source jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i public.inspections; r public.inspection_completion_receipts;outcome text;eid uuid;aid bigint;bound uuid;
begin
 perform public.assert_inspection_lifecycle_actor(p_org,p_home,p_actor,'inspection.write');
 select obligation_id into bound from public.inspection_attempts where org_id=p_org and inspection_id=p_id;
 if bound is not null then perform 1 from public.inspection_obligations where org_id=p_org and id=bound and project_id=p_home for update;if not found then raise exception 'Inspection obligation home changed';end if;end if;
 select * into i from public.inspections where org_id=p_org and project_id=p_home and id=p_id for update;
 if not found then raise exception 'Inspection attempt is unavailable';end if;
 perform 1 from public.inspection_items where org_id=p_org and inspection_id=p_id order by id for update;
 if p_source is distinct from public.inspection_review_source(p_org,p_id) then raise exception 'Inspection source changed; review current evidence';end if;
 select * into r from public.inspection_completion_receipts where org_id=p_org and inspection_id=p_id;
 if found then
  if r.source is distinct from p_source or r.project_id<>p_home or r.result is distinct from i.result or i.status<>'completed' then raise exception 'Inspection retry differs from recorded receipt';end if;
  return jsonb_build_object('inspectionId',p_id,'result',r.result,'existing',true,'awaitingReview',bound is not null);
 end if;
 if i.status='completed' then raise exception 'Legacy completed inspection needs governed reconciliation before acceptance';end if;
 select case when exists(select 1 from public.inspection_items where org_id=p_org and inspection_id=p_id and (is_deficient or (response_type='pass_fail' and response='fail'))) then 'fail'
 when not exists(select 1 from public.inspection_items where org_id=p_org and inspection_id=p_id) or exists(select 1 from public.inspection_items where org_id=p_org and inspection_id=p_id and (response is null or btrim(response) in('','n/a') or (response_type='pass_fail' and response not in('pass','fail')) or (response_type='yes_no' and response not in('yes','no')))) then 'partial' else 'pass' end into outcome;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org,'inspection_completed','inspection',p_id,jsonb_build_object('actor_id',p_actor,'project_id',p_home,'result',outcome,'obligation_id',bound),'activity') returning id into eid;
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org,p_actor,'update','inspection',p_id,jsonb_build_object('source',p_source,'result',outcome),'inspection_completion_transaction') returning id into aid;
 insert into public.inspection_completion_receipts(inspection_id,org_id,project_id,actor_id,source,result,event_id,audit_id) values(p_id,p_org,p_home,p_actor,p_source,outcome,eid,aid);
 update public.inspections set status='completed',result=outcome,inspected_at=coalesce(inspected_at,now()),inspector_user_id=p_actor where org_id=p_org and project_id=p_home and id=p_id;
 if bound is null and outcome='pass' and i.schedule_item_id is not null then
  update public.schedule_items set status='completed',progress=100 where org_id=p_org and project_id=p_home and id=i.schedule_item_id and status<>'cancelled';
  if not found then raise exception 'Inspection scheduled work changed or was cancelled';end if;
 end if;
 return jsonb_build_object('inspectionId',p_id,'result',outcome,'existing',false,'awaitingReview',bound is not null);
end $$;
create function public.mutate_inspection_obligation(p_org uuid,p_home uuid,p_actor uuid,p_key uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare op text:=p_request->>'operation';o public.inspection_obligations;i public.inspections;
 previous public.inspection_attempts;receipt public.inspection_lifecycle_receipts;completion public.inspection_completion_receipts;
 answer jsonb;corrections jsonb;new_id uuid;eid uuid;aid bigint;seq integer;prior_source jsonb;
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
  if not found or i.status<>'completed' or completion.source is distinct from p_request->'source' or completion.source is distinct from public.inspection_review_source(p_org,i.id) or completion.result is distinct from i.result then raise exception 'Current inspection completion evidence is missing or changed';end if;
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
   corrections:=jsonb_build_object('note',p_request->>'correctionNote','items',corrections,'priorCompletion',to_jsonb(completion));
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

create function public.assert_inspection_obligations_ready(p_org uuid,p_home uuid,p_schedule uuid default null) returns void
language plpgsql security definer set search_path='' as $$
declare o public.inspection_obligations;r public.inspection_completion_receipts;accepted_attempt public.inspection_attempts;
begin
 perform 1 from public.projects where org_id=p_org and id=p_home for update;
 if not found then raise exception 'Inspection readiness home is unavailable';end if;
 for o in select * from public.inspection_obligations where org_id=p_org and project_id=p_home and required_for_closing and (p_schedule is null or exists(select 1 from public.inspections x where x.id=source_inspection_id and x.org_id=p_org and x.project_id=p_home and x.schedule_item_id=p_schedule)) order by id for share loop
  if o.accepted_inspection_id is null then raise exception 'Required inspection obligation has not been accepted: %',o.title;end if;
  select * into r from public.inspection_completion_receipts where org_id=p_org and project_id=p_home and inspection_id=o.accepted_inspection_id;
  if not found or r.result<>'pass' or r.source is distinct from public.inspection_review_source(p_org,r.inspection_id)
   or not exists(select 1 from public.inspections where id=r.inspection_id and org_id=p_org and project_id=p_home and status='completed' and result='pass')
   or not exists(select 1 from public.inspection_attempts where org_id=p_org and obligation_id=o.id and inspection_id=r.inspection_id)
   or exists(select 1 from public.inspection_attempts a where a.org_id=p_org and a.obligation_id=o.id and a.attempt_number>(select attempt_number from public.inspection_attempts where inspection_id=r.inspection_id))
   or not exists(select 1 from public.inspection_lifecycle_receipts l where l.org_id=p_org and l.project_id=p_home and l.request->>'operation'='accept' and l.request->'source'=r.source and l.request->>'obligationId'=o.id::text and l.response->>'obligationId'=o.id::text and l.response->>'inspectionId'=r.inspection_id::text and l.actor_id<>r.actor_id) then raise exception 'Accepted inspection attempt evidence is missing or changed: %',o.title;end if;
  select * into accepted_attempt from public.inspection_attempts where org_id=p_org and obligation_id=o.id and inspection_id=r.inspection_id;
  if exists(select 1 from jsonb_array_elements(coalesce(accepted_attempt.correction_evidence->'items','[]')) c where not exists(select 1 from public.punch_items p where p.id=(c->>'punchId')::uuid and p.org_id=p_org and p.project_id=p_home and p.status in('closed','resolved'))) then raise exception 'Accepted inspection corrective work is reopened or unavailable';end if;
  if exists(select 1 from jsonb_array_elements(r.source->'items') c where c->>'photo_file_id' is not null and not exists(select 1 from public.files f where f.id=(c->>'photo_file_id')::uuid and f.org_id=p_org and f.project_id=p_home and f.archived_at is null)) then raise exception 'Accepted inspection photo evidence is unavailable';end if;
  if not exists(select 1 from public.events e where e.id=r.event_id and e.org_id=p_org and e.entity_id=r.inspection_id and e.event_type='inspection_completed' and e.payload->>'actor_id'=r.actor_id::text and e.payload->>'result'=r.result)
   or not exists(select 1 from public.audit_log l where l.id=r.audit_id and l.org_id=p_org and l.actor_user_id=r.actor_id and l.entity_id=r.inspection_id and l.after_data=jsonb_build_object('source',r.source,'result',r.result)) then raise exception 'Inspection completion event or audit evidence changed';end if;
 end loop;
end $$;
create function public.guard_closing_inspection_obligations() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status in('cleared_to_close','closed') and (tg_op='INSERT' or new.status is distinct from old.status) then perform public.assert_inspection_obligations_ready(new.org_id,new.project_id);end if;
 return new;
end $$;
create trigger closing_inspection_obligations before insert or update on public.closings for each row execute function public.guard_closing_inspection_obligations();

-- Reads use the same actor/home assertion. No public or generic table access.
create function public.read_inspection_obligations(p_org uuid,p_home uuid,p_actor uuid,p_after uuid default null,p_limit integer default 20,p_inspection uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;begin
 if p_limit<1 or p_limit>50 then raise exception 'Invalid required inspection page size';end if;
 perform public.assert_inspection_lifecycle_actor(p_org,p_home,p_actor,'project.read');
 with candidates as materialized(select * from public.inspection_obligations where org_id=p_org and project_id=p_home and (p_after is null or id>p_after) and (p_inspection is null or exists(select 1 from public.inspection_attempts a where a.org_id=p_org and a.obligation_id=inspection_obligations.id and a.inspection_id=p_inspection)) order by id limit p_limit+1),
 page as(select * from candidates order by id limit p_limit),
 rows as(select to_jsonb(o)||jsonb_build_object('attempt_count',(select count(*) from public.inspection_attempts a where a.org_id=p_org and a.obligation_id=o.id),
 'attempts',coalesce((select jsonb_agg(to_jsonb(recent) order by recent.attempt_number) from (select a.*,i.result,i.status,
 case when o.accepted_inspection_id=i.id then 'accept' when exists(select 1 from public.inspection_lifecycle_receipts l where l.org_id=p_org and l.project_id=p_home and l.request->>'operation'='reject' and l.response->>'inspectionId'=i.id::text and l.response->>'obligationId'=o.id::text) then 'reject' else null end review_decision
 from public.inspection_attempts a join public.inspections i on i.id=a.inspection_id and i.org_id=a.org_id and i.project_id=p_home where a.org_id=p_org and a.obligation_id=o.id order by a.attempt_number desc limit 5) recent),'[]')) body,o.id from page o)
 select jsonb_build_object('rows',coalesce((select jsonb_agg(body order by id) from rows),'[]'),'nextCursor',case when (select count(*) from candidates)>p_limit then (select max(id::text) from page) else null end) into result;
 return result;
end $$;

revoke all on function public.inspection_review_source(uuid,uuid),public.guard_inspection_attempt_evidence(),public.guard_inspection_history(),public.assert_inspection_obligations_ready(uuid,uuid,uuid),public.guard_closing_inspection_obligations() from public,anon,authenticated,service_role;
revoke all on function public.complete_inspection_attempt(uuid,uuid,uuid,uuid,jsonb),public.mutate_inspection_obligation(uuid,uuid,uuid,uuid,jsonb),public.read_inspection_obligations(uuid,uuid,uuid,uuid,integer,uuid) from public,anon;
grant execute on function public.complete_inspection_attempt(uuid,uuid,uuid,uuid,jsonb),public.mutate_inspection_obligation(uuid,uuid,uuid,uuid,jsonb),public.read_inspection_obligations(uuid,uuid,uuid,uuid,integer,uuid) to authenticated,service_role;
-- Deferred proof lets the acceptance transaction append its review receipt
-- before checking the final scheduled state; raw status edits share this guard.
create function public.guard_schedule_inspection_obligations() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='completed' and exists(select 1 from public.inspection_obligations o join public.inspection_attempts a on a.obligation_id=o.id and a.org_id=o.org_id join public.inspections i on i.id=a.inspection_id and i.org_id=a.org_id where o.org_id=new.org_id and o.project_id=new.project_id and i.schedule_item_id=new.id) then
  perform public.assert_inspection_obligations_ready(new.org_id,new.project_id,new.id);
 end if;return new;
end $$;
create constraint trigger schedule_inspection_obligations after update on public.schedule_items deferrable initially deferred for each row execute function public.guard_schedule_inspection_obligations();
revoke all on function public.guard_schedule_inspection_obligations() from public,anon,authenticated,service_role;

create function public.read_inspection_closing_readiness(p_org uuid,p_home uuid,p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.assert_inspection_lifecycle_actor(p_org,p_home,p_actor,'closing.manage');
 perform public.assert_inspection_obligations_ready(p_org,p_home);
 return jsonb_build_object('ready',true);
end $$;
revoke all on function public.read_inspection_closing_readiness(uuid,uuid,uuid) from public,anon;
grant execute on function public.read_inspection_closing_readiness(uuid,uuid,uuid) to authenticated,service_role;
