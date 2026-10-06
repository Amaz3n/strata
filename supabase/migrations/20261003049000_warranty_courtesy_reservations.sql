-- Additive foundation; service-only. Application cutover requires QA and approval.
create table public.warranty_courtesy_reservations (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.orgs(id),
 project_id uuid not null references public.projects(id),
 coverage_id uuid not null references public.project_warranty_coverage(id),
 milestone text not null check(milestone in ('day_30','month_11')),
 effective_date date not null,
 due_on date not null,
 request_id uuid not null references public.warranty_requests(id) on delete restrict,
 event_id uuid not null references public.events(id) on delete restrict,
 audit_id bigint not null references public.audit_log(id) on delete restrict,
 actor_id uuid references public.app_users(id),
 origin text not null check(origin in ('system','coordinator')),
 created_at timestamptz not null default now(),
 unique(org_id,project_id,milestone), unique(request_id)
);
alter table public.warranty_courtesy_reservations enable row level security;
revoke all on public.warranty_courtesy_reservations from public,anon,authenticated;
grant select,insert on public.warranty_courtesy_reservations to service_role;
create function public.guard_warranty_courtesy_reservation() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
begin raise exception 'Courtesy reservation evidence is immutable'; end;
$$;
create trigger warranty_courtesy_reservation_immutable before update or delete on public.warranty_courtesy_reservations
 for each row execute function public.guard_warranty_courtesy_reservation();

create function public.reserve_warranty_courtesy_inspection(p_org_id uuid,p_coverage_id uuid,p_milestone text,p_as_of date,p_actor_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare
 c public.project_warranty_coverage; r public.warranty_courtesy_reservations;
 req public.warranty_requests; e public.events; target public.warranty_sla_targets;
 v_due date; v_severity text; v_title text; v_event uuid; v_audit bigint;
 v_existing integer; v_number integer; v_attempt integer; v_adopted boolean:=false;
 v_now timestamptz:=clock_timestamp();
begin
 if p_org_id is null or p_coverage_id is null or p_as_of is null or p_milestone is null or p_milestone not in ('day_30','month_11') then
  raise exception 'Courtesy inspection scope and milestone are required';
 end if;
 if p_actor_id is not null then
  perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active' order by id for update;
  if not found then raise exception 'Courtesy coordinator is no longer an active organization member' using errcode='42501'; end if;
 end if;
 select * into c from public.project_warranty_coverage where id=p_coverage_id and org_id=p_org_id for share;
 if not found then raise exception 'Warranty coverage not found in organization'; end if;
 perform 1 from public.projects where id=c.project_id and org_id=p_org_id for share;
 if not found then raise exception 'Warranty home scope is invalid'; end if;
 -- All milestone/number reservations for this home share a transaction lock.
 perform pg_advisory_xact_lock(hashtextextended('warranty-courtesy:'||p_org_id||':'||c.project_id,0));
 v_due:=case when p_milestone='day_30' then c.effective_date+30 else (c.effective_date+interval '11 months')::date end;
 select * into r from public.warranty_courtesy_reservations where org_id=p_org_id and project_id=c.project_id and milestone=p_milestone;
 if found then
  if r.coverage_id<>c.id or r.effective_date<>c.effective_date or r.due_on<>v_due then raise exception 'Courtesy coverage evidence changed; reconcile original reservation'; end if;
  select * into req from public.warranty_requests where id=r.request_id and org_id=p_org_id and project_id=c.project_id;
  if not found or req.metadata->>'courtesy_milestone' is distinct from p_milestone or req.metadata->>'courtesy_due_on' is distinct from v_due::text then
   raise exception 'Reserved courtesy request evidence changed';
  end if;
  select * into e from public.events where id=r.event_id and org_id=p_org_id and entity_type='warranty_request' and entity_id=req.id and event_type='warranty_courtesy_inspection_created';
  if not found or e.payload->>'project_id' is distinct from c.project_id::text or e.payload->>'milestone' is distinct from p_milestone or e.payload->>'due_on' is distinct from v_due::text then raise exception 'Reserved courtesy event evidence changed'; end if;
  perform 1 from public.audit_log where id=r.audit_id and org_id=p_org_id and entity_type='warranty_request' and entity_id=req.id
    and actor_user_id is not distinct from r.actor_id and source='warranty_courtesy_reservation'
    and after_data->>'coverage_id'=c.id::text and after_data->>'courtesy_milestone'=p_milestone and after_data->>'due_on'=v_due::text;
  if not found then raise exception 'Reserved courtesy audit evidence changed'; end if;
  return jsonb_build_object('reservation_id',r.id,'request_id',r.request_id,'status','existing','due_on',r.due_on);
 end if;
 if v_due<p_as_of-60 or v_due>p_as_of+14 then return jsonb_build_object('status','not_due'); end if;
 v_severity:=case when p_milestone='day_30' then 'routine_30' else 'routine_60' end;
 v_title:=case when p_milestone='day_30' then '30-day courtesy inspection' else '11-month courtesy inspection' end;
 select count(*) into v_existing from public.warranty_requests where org_id=p_org_id and project_id=c.project_id and metadata->>'courtesy_milestone'=p_milestone;
 if v_existing>1 then raise exception 'Historical courtesy requests are ambiguous; reconcile duplicates'; end if;
 if v_existing=1 then
  select * into req from public.warranty_requests where org_id=p_org_id and project_id=c.project_id and metadata->>'courtesy_milestone'=p_milestone for share;
  if req.metadata->>'courtesy_due_on' is distinct from v_due::text then raise exception 'Historical courtesy due date does not match coverage'; end if;
  v_adopted:=true;
 else
  select * into target from public.warranty_sla_targets where org_id=p_org_id and severity=v_severity;
  if found and (target.first_response_hours is null or target.first_response_hours<=0 or target.resolution_days is null or target.resolution_days<=0) then raise exception 'Invalid warranty SLA target'; end if;
  -- Non-courtesy writers still use the project number unique constraint.
  for v_attempt in 1..5 loop
   select coalesce(max(request_number),0)+1 into v_number from public.warranty_requests where project_id=c.project_id;
   begin
    insert into public.warranty_requests(org_id,project_id,request_number,title,description,status,priority,severity,category,coverage_status,source,cost_dump_flag,scheduled_date,first_response_due_at,resolution_due_at,metadata)
    values(p_org_id,c.project_id,v_number,v_title,'Scheduled courtesy inspection due '||v_due||'.','open','normal',v_severity,'Courtesy inspection','in_warranty','office',false,v_due,
      v_now+make_interval(hours=>coalesce(target.first_response_hours,case when v_severity='routine_30' then 72 else 120 end)),
      v_now+make_interval(days=>coalesce(target.resolution_days,case when v_severity='routine_30' then 30 else 60 end)),
      jsonb_build_object('courtesy_milestone',p_milestone,'courtesy_due_on',v_due)) returning * into req;
    exit;
   exception when unique_violation then
    if v_attempt=5 then raise; end if;
   end;
  end loop;
 end if;
 select count(*) into v_existing from public.events where org_id=p_org_id and entity_type='warranty_request' and entity_id=req.id and event_type='warranty_courtesy_inspection_created';
 if v_existing>1 then raise exception 'Historical courtesy events are ambiguous'; end if;
 if v_existing=1 then
  select * into e from public.events where org_id=p_org_id and entity_type='warranty_request' and entity_id=req.id and event_type='warranty_courtesy_inspection_created';
  if e.payload->>'project_id' is distinct from c.project_id::text or e.payload->>'milestone' is distinct from p_milestone or e.payload->>'due_on' is distinct from v_due::text then raise exception 'Historical courtesy event evidence differs'; end if;
  v_event:=e.id;
 else
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
  values(p_org_id,'warranty_courtesy_inspection_created','warranty_request',req.id,jsonb_build_object('project_id',c.project_id,'milestone',p_milestone,'due_on',v_due)||jsonb_strip_nulls(jsonb_build_object('actor_id',p_actor_id)),'activity') returning id into v_event;
 end if;
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source)
 values(p_org_id,p_actor_id,case when v_adopted then 'update' else 'insert' end,'warranty_request',req.id,
  jsonb_build_object('coverage_id',c.id,'courtesy_milestone',p_milestone,'due_on',v_due,'adopted',v_adopted),'warranty_courtesy_reservation') returning id into v_audit;
 insert into public.warranty_courtesy_reservations(org_id,project_id,coverage_id,milestone,effective_date,due_on,request_id,event_id,audit_id,actor_id,origin)
 values(p_org_id,c.project_id,c.id,p_milestone,c.effective_date,v_due,req.id,v_event,v_audit,p_actor_id,case when p_actor_id is null then 'system' else 'coordinator' end) returning * into r;
 return jsonb_build_object('reservation_id',r.id,'request_id',r.request_id,'status',case when v_adopted then 'adopted' else 'created' end,'due_on',r.due_on);
end;
$$;
revoke all on function public.reserve_warranty_courtesy_inspection(uuid,uuid,text,date,uuid) from public,anon,authenticated;
grant execute on function public.reserve_warranty_courtesy_inspection(uuid,uuid,text,date,uuid) to service_role;
-- Supports legacy adoption and scoped milestone reconciliation.
create index warranty_requests_courtesy_source_idx on public.warranty_requests(org_id,project_id,(metadata->>'courtesy_milestone'))
 where metadata->>'courtesy_milestone' is not null;

create index project_warranty_coverage_courtesy_cursor_idx on public.project_warranty_coverage(org_id,id) include(project_id,effective_date);
