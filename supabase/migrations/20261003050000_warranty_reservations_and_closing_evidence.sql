-- Warranty courtesy-visit reservations and the evidence guards on home closings.
--
-- Consolidated before deploy (2026-10-09) from 2 unapplied migrations, in their
-- original order; each section is marked with the file it came from.

-- ==== 20261003049000_warranty_courtesy_reservations ====
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

-- ==== 20261003050000_closing_evidence_guards ====
-- Staged/unapplied. Preserve settled evidence and serialize checklist edits
-- through their parent closing. Full permission and monetary commit fencing
-- remains a separate cutover requirement.
create function public.guard_closing_checklist_evidence() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
declare parent public.closings; item public.closing_checklist_items;
begin
 if tg_op='UPDATE' and (new.id,new.org_id,new.closing_id) is distinct from (old.id,old.org_id,old.closing_id) then
  raise exception 'Closing checklist identity cannot change';
 end if;
 if tg_op='DELETE' then item:=old; else item:=new; end if;
 select * into parent from public.closings where id=item.closing_id and org_id=item.org_id for update;
 if not found then
  -- An allowed deletion of an unfinished parent cascades after the parent row
  -- is gone. A recorded parent is already protected by its own DELETE guard.
  if tg_op='DELETE' and pg_trigger_depth()>1 and not exists(select 1 from public.closings where id=item.closing_id) then return old; end if;
  raise exception 'Closing checklist parent scope is invalid';
 end if;
 if parent.status in ('closed','cancelled') then raise exception 'Closed or cancelled checklist evidence is immutable'; end if;
 if tg_op='DELETE' then return old; end if;
 if item.status<>'open' and (item.completed_by is null or item.completed_at is null) then raise exception 'Closing completion attribution is required'; end if;
 if item.status='waived' and length(btrim(coalesce(item.notes,'')))<10 then raise exception 'Closing waiver reason must be documented'; end if;
 if item.file_id is not null then
  perform 1 from public.files where id=item.file_id and org_id=item.org_id and project_id=parent.project_id and archived_at is null for share;
  if not found then raise exception 'Closing evidence file is unavailable or belongs to another home'; end if;
 end if;
 return new;
end $$;
create trigger closing_checklist_evidence_guard before insert or update or delete on public.closing_checklist_items
 for each row execute function public.guard_closing_checklist_evidence();

create function public.guard_closing_settlement_evidence() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
declare gates integer;
begin
 if tg_op='DELETE' then
  if old.status in ('closed','cancelled') then raise exception 'Recorded closing history cannot be deleted'; end if;
  return old;
 end if;
 if tg_op='UPDATE' then
  if (new.id,new.org_id,new.project_id,new.lot_id,new.community_id) is distinct from (old.id,old.org_id,old.project_id,old.lot_id,old.community_id) then raise exception 'Closing home identity cannot change'; end if;
  if old.status in ('closed','cancelled') and
   (new.status,new.scheduled_date,new.actual_date,new.settlement,new.closing_invoice_id,new.cancel_reason,new.metadata->'adjustments') is distinct from
   (old.status,old.scheduled_date,old.actual_date,old.settlement,old.closing_invoice_id,old.cancel_reason,old.metadata->'adjustments') then
   raise exception 'Recorded closing settlement evidence is immutable';
  end if;
 end if;
 if new.status='closed' and (tg_op='INSERT' or old.status<>'closed') then
  if new.closing_invoice_id is null then raise exception 'Closing invoice evidence is required'; end if;
  if jsonb_typeof(new.settlement->'finalPriceCents') is distinct from 'number' or coalesce(new.settlement->>'finalPriceCents','')!~'^[0-9]+$' then raise exception 'Recorded final price cents are invalid'; end if;
  if (new.settlement->>'finalPriceCents')::numeric>9007199254740991 then raise exception 'Recorded final price exceeds safe integer cents'; end if;
  perform 1 from public.invoices where id=new.closing_invoice_id and org_id=new.org_id and project_id=new.project_id and total_cents=(new.settlement->>'finalPriceCents')::numeric for share;
  if not found then raise exception 'Closing invoice belongs to another home, is unavailable or differs from the settlement'; end if;
  perform 1 from public.files f where exists(select 1 from public.closing_checklist_items i
    where i.closing_id=new.id and i.org_id=new.org_id and i.is_gate and i.file_id=f.id) order by f.id for share;
  select count(*) into gates from public.closing_checklist_items where closing_id=new.id and org_id=new.org_id and is_gate;
  if gates=0 then raise exception 'Closing readiness gates are missing'; end if;
  -- No child row locks: checklist writers take the parent lock and either
  -- commit before this read or fail after the parent becomes closed.
  if exists(select 1 from public.closing_checklist_items i where i.closing_id=new.id and i.org_id=new.org_id and i.is_gate and
   (i.status='open' or i.completed_by is null or i.completed_at is null or (i.status='waived' and length(btrim(coalesce(i.notes,'')))<10) or
    (i.file_id is not null and not exists(select 1 from public.files f where f.id=i.file_id and f.org_id=new.org_id and f.project_id=new.project_id and f.archived_at is null)))) then
   raise exception 'Closing readiness gate evidence is incomplete';
  end if;
 end if;
 return new;
end $$;
create trigger closing_settlement_evidence_guard before insert or update or delete on public.closings
 for each row execute function public.guard_closing_settlement_evidence();

-- Preserve source home identity after the closing is recorded. Plain parent
-- reads avoid inverting the closing->file/invoice lock order.
create function public.guard_recorded_closing_sources() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
declare protected boolean;
begin
 if tg_table_name='files' then
  select exists(select 1 from public.closing_checklist_items i join public.closings c on c.id=i.closing_id and c.org_id=i.org_id
    where i.file_id=old.id and c.status in ('closed','cancelled')) into protected;
 else
  select exists(select 1 from public.closings c where c.closing_invoice_id=old.id and c.status in ('closed','cancelled')) into protected;
 end if;
 if protected then
  if tg_op='DELETE' then raise exception 'Recorded closing source cannot be deleted'; end if;
  if (new.id,new.org_id,new.project_id) is distinct from (old.id,old.org_id,old.project_id) then raise exception 'Recorded closing source home cannot change'; end if;
  if tg_table_name='files' and (to_jsonb(new)->'archived_at') is distinct from (to_jsonb(old)->'archived_at') then raise exception 'Recorded closing evidence cannot be archived'; end if;
  if tg_table_name='invoices' and (to_jsonb(new)->'total_cents') is distinct from (to_jsonb(old)->'total_cents') then raise exception 'Recorded closing invoice amount cannot change'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger recorded_closing_file_guard before update or delete on public.files for each row execute function public.guard_recorded_closing_sources();
create trigger recorded_closing_invoice_guard before update or delete on public.invoices for each row execute function public.guard_recorded_closing_sources();
