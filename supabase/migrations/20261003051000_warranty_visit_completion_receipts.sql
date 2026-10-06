-- STAGED / UNAPPLIED. Office completion transaction foundation only.
-- Do not cut over callers before permission-policy parity, portal provenance,
-- full-schema RLS and independent-session acceptance are verified.
create table public.warranty_visit_completion_receipts (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.orgs(id),
 project_id uuid not null references public.projects(id),
 request_id uuid not null references public.warranty_requests(id) on delete restrict,
 visit_id uuid not null references public.warranty_service_visits(id) on delete restrict,
 actor_id uuid not null references public.app_users(id),
 input jsonb not null,
 visit_evidence jsonb not null,
 request_evidence jsonb not null,
 event_id uuid not null references public.events(id) on delete restrict,
 audit_id bigint not null references public.audit_log(id) on delete restrict,
 created_at timestamptz not null default now(),
 unique(org_id,visit_id)
);
create index warranty_completion_visit_fk_idx on public.warranty_visit_completion_receipts(visit_id);
create index warranty_completion_request_fk_idx on public.warranty_visit_completion_receipts(request_id);
create index warranty_completion_project_fk_idx on public.warranty_visit_completion_receipts(project_id);
create index warranty_completion_actor_fk_idx on public.warranty_visit_completion_receipts(actor_id);
create index warranty_completion_request_idx on public.warranty_visit_completion_receipts(org_id,request_id);
create index warranty_completion_project_idx on public.warranty_visit_completion_receipts(org_id,project_id);
create index warranty_completion_event_idx on public.warranty_visit_completion_receipts(event_id);
create index warranty_completion_audit_idx on public.warranty_visit_completion_receipts(audit_id);
alter table public.warranty_visit_completion_receipts enable row level security;
revoke all on public.warranty_visit_completion_receipts from public,anon,authenticated;
grant select,insert on public.warranty_visit_completion_receipts to service_role;
create function public.guard_warranty_visit_completion_receipt() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
begin raise exception 'Warranty completion receipt is immutable'; end $$;
create trigger warranty_completion_receipt_immutable before update or delete on public.warranty_visit_completion_receipts
 for each row execute function public.guard_warranty_visit_completion_receipt();

-- Internal assertion for the two gates used by the office workbench:
-- organization warranty.write, followed by warranty.write for the actual home.
-- Environment-only SUPERADMIN_IDS/EMAILS cannot be asserted by SQL. Such actors
-- need a current DB platform grant; do not pass an unchecked bypass flag.
create function public.assert_warranty_completion_actor(p_org_id uuid,p_project_id uuid,p_actor_id uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare
 members uuid[]; org_roles uuid[]; project_roles uuid[]; platform_roles uuid[]; all_roles uuid[];
 base_permissions text[]; org_permissions text[]; project_permissions text[]; platform_permissions text[];
 grants text[]; denies text[]; effective text[]; org_effective text[];
 assigned_only boolean; division_assigned boolean; project_member boolean; home_division uuid; divisions uuid[];
begin
 if p_org_id is null or p_project_id is null or p_actor_id is null then raise exception 'Warranty authorization identity is required' using errcode='42501'; end if;
 -- Parent locks also fence FK-backed new memberships, project grants and role
 -- permission/override inserts. Validate actual FK/lock order in full-schema QA.
 perform 1 from public.app_users where id=p_actor_id for update;
 if not found then raise exception 'Warranty actor not found' using errcode='42501'; end if;
 perform 1 from public.permissions where key='warranty.write' for share;
 if not found then raise exception 'Warranty write permission is not registered' using errcode='42501'; end if;
 select division_id into home_division from public.projects where id=p_project_id and org_id=p_org_id for share;
 if not found then raise exception 'Warranty authorization home belongs to another organization or is unavailable' using errcode='42501'; end if;
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id order by id for update;
 perform 1 from public.project_members where org_id=p_org_id and project_id=p_project_id and user_id=p_actor_id order by id for update;
 perform 1 from public.platform_memberships where user_id=p_actor_id order by id for update;
 select coalesce(array_agg(id),'{}'),coalesce(array_agg(distinct role_id),'{}'),coalesce(bool_or(project_scope='assigned'),false),coalesce(bool_or(division_scope='assigned'),false)
 into members,org_roles,assigned_only,division_assigned from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active';
 select coalesce(array_agg(distinct role_id),'{}'),count(*)>0 into project_roles,project_member from public.project_members where org_id=p_org_id and project_id=p_project_id and user_id=p_actor_id and status='active';
 select coalesce(array_agg(distinct role_id),'{}') into platform_roles from public.platform_memberships where user_id=p_actor_id and status='active';
 all_roles:=org_roles||project_roles||platform_roles;
 perform 1 from public.roles where id=any(all_roles) order by id for update;
 perform 1 from public.role_permissions where role_id=any(all_roles) order by role_id,permission_key for share;
 perform 1 from public.membership_permission_overrides where membership_id=any(members) order by membership_id,permission_key for share;
 select coalesce(array_agg(distinct permission_key),'{}') into base_permissions from public.role_permissions where role_id=any(org_roles);
 select coalesce(array_agg(distinct permission_key),'{}') into project_permissions from public.role_permissions where role_id=any(project_roles);
 -- Evaluate expiry after waits for all locked permission facts.
 select coalesce(array_agg(distinct rp.permission_key),'{}') into platform_permissions from public.platform_memberships pm join public.role_permissions rp on rp.role_id=pm.role_id
 where pm.user_id=p_actor_id and pm.status='active' and (pm.expires_at is null or pm.expires_at>clock_timestamp());
 if '*'=any(platform_permissions) or 'platform.org.access'=any(platform_permissions) then return; end if;
 select coalesce(array_agg(permission_key) filter(where effect='grant'),'{}'),coalesce(array_agg(permission_key) filter(where effect='deny'),'{}') into grants,denies
 from public.membership_permission_overrides where membership_id=any(members);
 org_permissions:=base_permissions||grants;
 select coalesce(array_agg(distinct x),'{}') into org_effective from unnest(org_permissions||platform_permissions) x where not(x=any(denies));
 if 'warranty.write'=any(denies) or not('warranty.write'=any(org_effective) or '*'=any(org_effective)) then raise exception 'Warranty actor lacks organization write permission' using errcode='42501'; end if;
 if not project_member and not('*'=any(org_permissions) or 'org.admin'=any(org_permissions) or (not assigned_only and ('project.read'=any(org_permissions) or 'project.manage'=any(org_permissions)))) then
  raise exception 'Warranty home is outside actor assigned project access' using errcode='42501';
 end if;
 select coalesce(array_agg(distinct x),'{}') into effective from unnest(org_permissions||project_permissions||platform_permissions) x where not(x=any(denies));
 if not('warranty.write'=any(effective) or '*'=any(effective)) then raise exception 'Warranty actor lacks home write permission' using errcode='42501'; end if;
 if division_assigned and not('org.admin'=any(base_permissions)) then
  perform 1 from public.membership_divisions where membership_id=any(members) order by membership_id,division_id for share;
  select coalesce(array_agg(distinct division_id),'{}') into divisions from public.membership_divisions where membership_id=any(members);
  if home_division is null or not(home_division=any(divisions)) then raise exception 'Warranty home is outside actor division access' using errcode='42501'; end if;
 end if;
end $$;
revoke all on function public.assert_warranty_completion_actor(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.complete_warranty_visit_atomic(
 p_org_id uuid,p_visit_id uuid,p_actor_id uuid,p_expected_visit_at timestamptz,p_expected_request_at timestamptz,p_input jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare
 v public.warranty_service_visits; req public.warranty_requests; receipt public.warranty_visit_completion_receipts;
 parent_id uuid; home_id uuid; normalized jsonb; photos uuid[]; signature uuid; hours numeric; rate numeric; material numeric; labor bigint;
 outcome_value text; note_value text; signoff text; now_at timestamptz:=clock_timestamp(); evidence jsonb;
 event_id_value uuid; audit_id_value bigint; prior jsonb;
begin
 if p_org_id is null or p_visit_id is null or p_actor_id is null or jsonb_typeof(p_input) is distinct from 'object' then raise exception 'Warranty completion identity and input are required'; end if;
 outcome_value:=p_input->>'outcome'; note_value:=p_input->>'outcome_note'; signoff:=p_input->>'buyer_signoff_name';
 if outcome_value is null or outcome_value not in ('resolved','needs_followup','needs_parts','not_warrantable') then raise exception 'Warranty completion outcome is invalid'; end if;
 if exists(select 1 from unnest(array['outcome_note','buyer_signoff_name']) k where p_input ? k and p_input->k<>'null'::jsonb and jsonb_typeof(p_input->k)<>'string') then raise exception 'Warranty completion text must be strings'; end if;
 if length(coalesce(note_value,''))>4000 or length(coalesce(signoff,''))>200 then raise exception 'Warranty completion text is too long'; end if;
 if p_input ? 'photo_file_ids' and jsonb_typeof(p_input->'photo_file_ids') is distinct from 'array' then raise exception 'Warranty completion photos must be an array'; end if;
 if jsonb_array_length(coalesce(p_input->'photo_file_ids','[]'))>20 then raise exception 'Warranty completion photos exceed limit'; end if;
 select coalesce(array_agg(distinct x::uuid order by x::uuid),'{}') into photos from jsonb_array_elements_text(coalesce(p_input->'photo_file_ids','[]')) x;
 signature:=(p_input->>'buyer_signature_file_id')::uuid;
 if exists(select 1 from unnest(array['labor_hours','labor_rate_cents','material_cents']) k where p_input ? k and p_input->k<>'null'::jsonb and jsonb_typeof(p_input->k)<>'number') then raise exception 'Warranty completion costs must be numeric'; end if;
 hours:=(p_input->>'labor_hours')::numeric; rate:=(p_input->>'labor_rate_cents')::numeric; material:=coalesce((p_input->>'material_cents')::numeric,0);
 if hours<0 or hours>24 or rate<0 or rate>100000000 or rate<>trunc(rate) or material<0 or material>100000000 or material<>trunc(material) then raise exception 'Warranty completion costs are invalid'; end if;
 if hours>0 and rate is null then raise exception 'Warranty labor rate is required when hours are recorded'; end if;
 labor:=round(coalesce(hours,0)*coalesce(rate,0))::bigint;
 normalized:=jsonb_build_object('outcome',outcome_value,'outcome_note',note_value,'buyer_signoff_name',signoff,'buyer_signature_file_id',signature,'photo_file_ids',photos,'labor_hours',hours,'labor_rate_cents',rate,'material_cents',material);
 -- Parent-first lock order. Recheck the child's ancestry after acquiring both.
 select request_id,project_id into parent_id,home_id from public.warranty_service_visits where org_id=p_org_id and id=p_visit_id;
 if not found then raise exception 'Warranty visit not found'; end if;
 perform public.assert_warranty_completion_actor(p_org_id,home_id,p_actor_id);
 select * into req from public.warranty_requests where id=parent_id and org_id=p_org_id for update;
 if not found then raise exception 'Warranty request not found'; end if;
 select * into v from public.warranty_service_visits where id=p_visit_id and org_id=p_org_id for update;
 if not found or v.request_id is distinct from req.id or v.project_id is distinct from home_id or v.project_id is distinct from req.project_id then raise exception 'Warranty visit request/home ancestry differs'; end if;
 perform 1 from public.projects where id=v.project_id and org_id=p_org_id for share;
 if not found then raise exception 'Warranty home not found'; end if;
 select * into receipt from public.warranty_visit_completion_receipts where org_id=p_org_id and visit_id=p_visit_id;
 if found then
  if receipt.input<>normalized or receipt.project_id<>v.project_id or receipt.request_id<>req.id then raise exception 'Warranty completion retry differs from original receipt'; end if;
  evidence:=jsonb_build_object('status',v.status,'outcome',v.outcome,'outcome_note',v.outcome_note,'completed_at',v.completed_at,'completed_by',v.completed_by,'buyer_signoff_name',v.buyer_signoff_name,'buyer_signoff_at',v.buyer_signoff_at,'buyer_signature_file_id',v.buyer_signature_file_id,'labor_hours',v.labor_hours,'labor_rate_cents',v.labor_rate_cents,'internal_labor_cents',v.internal_labor_cents,'internal_material_cents',v.internal_material_cents);
  if evidence<>receipt.visit_evidence then raise exception 'Recorded warranty completion evidence changed'; end if;
  perform 1 from public.events where id=receipt.event_id and org_id=p_org_id and event_type='warranty_visit_completed' and entity_type='warranty_service_visit' and entity_id=v.id
   and payload=jsonb_build_object('actor_id',receipt.actor_id,'request_id',req.id,'project_id',v.project_id,'outcome',outcome_value,'pending_verification',false,'internal_cost_cents',labor+material);
  if not found then raise exception 'Warranty completion event evidence changed'; end if;
  perform 1 from public.audit_log where id=receipt.audit_id and org_id=p_org_id and actor_user_id=receipt.actor_id and entity_type='warranty_service_visit' and entity_id=v.id and source='warranty_completion_transaction' and after_data=receipt.visit_evidence;
  if not found then raise exception 'Warranty completion audit evidence changed'; end if;
  if exists(select 1 from unnest(photos) f where not exists(select 1 from public.warranty_visit_photos p where p.org_id=p_org_id and p.visit_id=v.id and p.file_id=f)) then raise exception 'Warranty completion photo evidence changed'; end if;
  -- Never reapply original request state: legitimate follow-up work may exist.
  return jsonb_build_object('status','existing','receipt_id',receipt.id,'visit_id',v.id,'request_id',req.id,'actor_id',receipt.actor_id);
 end if;
 if p_expected_visit_at is null or p_expected_request_at is null or v.updated_at<>p_expected_visit_at or req.updated_at<>p_expected_request_at then raise exception 'Warranty completion revision changed'; end if;
 if v.status in ('completed','canceled') or req.status in ('resolved','closed') then raise exception 'Warranty visit/request cannot be completed in its current state'; end if;
 perform 1 from public.files where id=any(photos||case when signature is null then '{}'::uuid[] else array[signature] end) order by id for share;
 if exists(select 1 from unnest(photos||case when signature is null then '{}'::uuid[] else array[signature] end) f where not exists(select 1 from public.files where id=f and org_id=p_org_id and project_id=v.project_id and archived_at is null)) then raise exception 'Warranty completion files must belong to the active home'; end if;
 prior:=to_jsonb(v);
 update public.warranty_service_visits set status='completed',outcome=outcome_value,outcome_note=note_value,completed_at=now_at,completed_by=p_actor_id,
 buyer_signoff_name=signoff,buyer_signoff_at=case when signoff is not null then now_at else null end,buyer_signature_file_id=signature,
 labor_hours=hours,labor_rate_cents=rate,internal_labor_cents=labor,internal_material_cents=material,updated_at=now_at where id=v.id and org_id=p_org_id returning * into v;
 insert into public.warranty_visit_photos(org_id,visit_id,file_id,created_by) select p_org_id,v.id,f,p_actor_id from unnest(photos) f on conflict(visit_id,file_id) do nothing;
 update public.warranty_requests set status=case when outcome_value='resolved' then 'resolved' else 'in_progress' end,
 closed_at=case when outcome_value='resolved' then now_at else null end,
 metadata=coalesce(metadata,'{}')||jsonb_build_object('pending_verification',false,'completed_visit_id',v.id),updated_at=now_at
 where id=req.id and org_id=p_org_id returning * into req;
 evidence:=jsonb_build_object('status',v.status,'outcome',v.outcome,'outcome_note',v.outcome_note,'completed_at',v.completed_at,'completed_by',v.completed_by,'buyer_signoff_name',v.buyer_signoff_name,'buyer_signoff_at',v.buyer_signoff_at,'buyer_signature_file_id',v.buyer_signature_file_id,'labor_hours',v.labor_hours,'labor_rate_cents',v.labor_rate_cents,'internal_labor_cents',v.internal_labor_cents,'internal_material_cents',v.internal_material_cents);
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'warranty_visit_completed','warranty_service_visit',v.id,jsonb_build_object('actor_id',p_actor_id,'request_id',req.id,'project_id',v.project_id,'outcome',outcome_value,'pending_verification',false,'internal_cost_cents',labor+material),'activity') returning id into event_id_value;
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source) values(p_org_id,p_actor_id,'update','warranty_service_visit',v.id,prior,evidence,'warranty_completion_transaction') returning id into audit_id_value;
 insert into public.warranty_visit_completion_receipts(org_id,project_id,request_id,visit_id,actor_id,input,visit_evidence,request_evidence,event_id,audit_id)
 values(p_org_id,v.project_id,req.id,v.id,p_actor_id,normalized,evidence,to_jsonb(req),event_id_value,audit_id_value) returning * into receipt;
 return jsonb_build_object('status','created','receipt_id',receipt.id,'visit_id',v.id,'request_id',req.id,'actor_id',receipt.actor_id);
end $$;
revoke all on function public.complete_warranty_visit_atomic(uuid,uuid,uuid,timestamptz,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.complete_warranty_visit_atomic(uuid,uuid,uuid,timestamptz,timestamptz,jsonb) to service_role;
