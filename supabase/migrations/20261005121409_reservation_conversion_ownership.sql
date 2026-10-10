-- STAGED / UNAPPLIED. Do not activate ARC_RESERVATION_CONVERSION_ENABLED until
-- this migration, original-owner service/UI cutover and full-schema/JWT/race QA pass.
-- Requires create_invoice_atomic and assert_agreement_signing_actor.
-- Reconcile legacy duplicate deposit invoices before approving the unique index.
-- Request/receipt tables are private; only the trusted server RPC is granted.
create table public.reservation_conversion_requests (
 id uuid primary key,
 org_id uuid not null references public.orgs(id),
 actor_id uuid not null references public.app_users(id),
 reservation_id uuid not null references public.lot_reservations(id),
 community_id uuid not null references public.communities(id),
 lot_id uuid not null references public.lots(id),
 request jsonb not null check(jsonb_typeof(request)='object'),
 bundle jsonb not null check(jsonb_typeof(bundle)='object'),
 status text not null default 'pending' check(status in ('pending','committed','cancelled')),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp()
);
create unique index reservation_conversion_pending_actor on public.reservation_conversion_requests(org_id,actor_id,reservation_id) where status='pending';
create index reservation_conversion_request_reservation on public.reservation_conversion_requests(org_id,reservation_id,created_at desc,id);
create index reservation_conversion_request_actor on public.reservation_conversion_requests(actor_id);
create index reservation_conversion_request_community on public.reservation_conversion_requests(community_id);
create index reservation_conversion_request_lot on public.reservation_conversion_requests(lot_id);
alter table public.reservation_conversion_requests enable row level security;
revoke all on public.reservation_conversion_requests from public,anon,authenticated,service_role;
create table public.reservation_conversion_receipts (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.orgs(id),
 request_id uuid not null unique references public.reservation_conversion_requests(id),
 reservation_id uuid not null references public.lot_reservations(id),
 project_id uuid not null references public.projects(id),
 invoice_id uuid references public.invoices(id),
 event_id uuid not null references public.events(id),
 audit_id bigint not null references public.audit_log(id),
 reservation_source jsonb not null,
 created_at timestamptz not null default now(),
 unique(org_id,reservation_id)
);
create index reservation_conversion_receipt_project on public.reservation_conversion_receipts(project_id);
create index reservation_conversion_receipt_invoice on public.reservation_conversion_receipts(invoice_id) where invoice_id is not null;
create index reservation_conversion_receipt_reservation on public.reservation_conversion_receipts(reservation_id);
create index reservation_conversion_receipt_event on public.reservation_conversion_receipts(event_id);
create index reservation_conversion_receipt_audit on public.reservation_conversion_receipts(audit_id);
alter table public.reservation_conversion_receipts enable row level security;
revoke all on public.reservation_conversion_receipts from public,anon,authenticated,service_role;
create function public.guard_reservation_conversion_record() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='reservation_conversion_receipts' or tg_op='DELETE' then raise exception 'Reservation conversion evidence is immutable';end if;
 if old.status<>'pending' or new.status not in ('committed','cancelled') or
  (to_jsonb(old)-'status'-'updated_at') is distinct from (to_jsonb(new)-'status'-'updated_at') then
  raise exception 'Original reservation conversion request is immutable';end if;
 new.updated_at:=clock_timestamp();return new;
end $$;
revoke all on function public.guard_reservation_conversion_record() from public,anon,authenticated,service_role;
create trigger reservation_conversion_request_guard before update or delete on public.reservation_conversion_requests for each row execute function public.guard_reservation_conversion_record();
create trigger reservation_conversion_receipt_guard before update or delete on public.reservation_conversion_receipts for each row execute function public.guard_reservation_conversion_record();
-- Includes voided earnest requests: re-reservation uses a new hold, not another
-- invoice for the same original financial operation. Existing ambiguity aborts.
create unique index invoice_reservation_deposit_owner on public.invoices(org_id,(metadata->>'source_reservation_id'))
 where metadata->>'invoice_kind'='earnest_deposit' and metadata->>'source_reservation_id' is not null;
create function public.assert_reservation_conversion_community_actor(p_org_id uuid,p_actor_id uuid,p_community_id uuid,p_permission text default 'sales.manage') returns void
language plpgsql security definer set search_path='' as $$
declare members uuid[]; org_roles uuid[]; platform_roles uuid[]; all_roles uuid[]; base_permissions text[]; platform_permissions text[];
 grants text[]; denies text[]; effective text[]; assigned boolean; community_division uuid; divisions uuid[];
begin
 if p_permission <> 'sales.manage' or p_permission is null then raise exception 'Invalid reservation permission';end if;
 if p_org_id is null or p_actor_id is null then raise exception 'Reservation publication authorization required' using errcode='42501';end if;
 perform 1 from public.app_users where id=p_actor_id for update;
 if not found then raise exception 'Reservation publication actor is unavailable' using errcode='42501';end if;
 perform 1 from public.permissions where key=p_permission for share;
 if not found then raise exception 'Reservation management permission is not registered' using errcode='42501';end if;
 if p_community_id is not null then
  select division_id into community_division from public.communities where id=p_community_id and org_id=p_org_id for share;
  if not found then raise exception 'Reservation community belongs to another organization or is unavailable' using errcode='42501';end if;
 end if;
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id order by id for update;
 perform 1 from public.platform_memberships where user_id=p_actor_id order by id for update;
 select coalesce(array_agg(id),'{}'),coalesce(array_agg(distinct role_id),'{}'),coalesce(bool_or(division_scope='assigned'),false)
 into members,org_roles,assigned from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active';
 select coalesce(array_agg(distinct role_id),'{}') into platform_roles from public.platform_memberships where user_id=p_actor_id and status='active';
 all_roles:=org_roles||platform_roles;
 perform 1 from public.roles where id=any(all_roles) order by id for share;
 perform 1 from public.role_permissions where role_id=any(all_roles) order by role_id,permission_key for share;
 perform 1 from public.membership_permission_overrides where membership_id=any(members) order by membership_id,permission_key for share;
 select coalesce(array_agg(distinct permission_key),'{}') into base_permissions from public.role_permissions where role_id=any(org_roles);
 select coalesce(array_agg(distinct rp.permission_key),'{}') into platform_permissions from public.platform_memberships pm join public.role_permissions rp on rp.role_id=pm.role_id
 where pm.user_id=p_actor_id and pm.status='active' and (pm.expires_at is null or pm.expires_at>clock_timestamp());
 if '*'=any(platform_permissions) or 'platform.org.access'=any(platform_permissions) then return;end if;
 select coalesce(array_agg(permission_key) filter(where effect='grant'),'{}'),coalesce(array_agg(permission_key) filter(where effect='deny'),'{}') into grants,denies
 from public.membership_permission_overrides where membership_id=any(members);
 select coalesce(array_agg(distinct x),'{}') into effective from unnest(base_permissions||grants||platform_permissions) x where not(x=any(denies));
 if p_permission=any(denies) or not(p_permission=any(effective) or '*'=any(effective)) then raise exception 'Reservation actor lacks organization management permission' using errcode='42501';end if;
 if assigned and not('org.admin'=any(base_permissions)) and p_community_id is not null then
  perform 1 from public.membership_divisions where membership_id=any(members) order by membership_id,division_id for share;
  select coalesce(array_agg(distinct division_id),'{}') into divisions from public.membership_divisions where membership_id=any(members);
  if p_community_id is null or community_division is null or not(community_division=any(divisions)) then raise exception 'Reservation publication is outside actor division access' using errcode='42501';end if;
 end if;
end $$;
revoke all on function public.assert_reservation_conversion_community_actor(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;


-- Caller holds the domain rows. Exact projected source, not an entire customer row.
create function public.reservation_conversion_source(p_org uuid,p_reservation uuid) returns jsonb
language sql set search_path='' as $$
 select jsonb_build_object(
 'reservation',jsonb_build_object('id',r.id,'org_id',r.org_id,'community_id',r.community_id,'lot_id',r.lot_id,
  'buyer_contact_id',r.buyer_contact_id,'co_buyer_contact_id',r.co_buyer_contact_id,'prospect_id',r.prospect_id,
  'status',r.status,'expires_at',r.expires_at,'updated_at',r.updated_at,'deposit_invoice_id',r.deposit_invoice_id,'contract_id',r.contract_id),
 'lot',jsonb_build_object('id',l.id,'org_id',l.org_id,'community_id',l.community_id,'division_id',l.division_id,'lot_number',l.lot_number,'status',l.status,'project_id',l.project_id,'updated_at',l.updated_at),
 'community',jsonb_build_object('id',c.id,'division_id',c.division_id,'name',c.name,'updated_at',c.updated_at),
 'home',case when h.id is null then null else jsonb_build_object('id',h.id,'name',h.name,'property_type',h.property_type,'division_id',h.division_id,'client_id',h.client_id,'updated_at',h.updated_at) end,
 'buyers',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'full_name',b.full_name,'email',b.email,'updated_at',b.updated_at) order by b.id)
   from public.contacts b where b.org_id=r.org_id and b.id in(r.buyer_contact_id,r.co_buyer_contact_id)),'[]'),
 'organization',jsonb_build_object('name',o.name,'email',o.billing_email,'phone',null,'address',o.address),
 'accountingDefault',case when h.id is not null then null else (select to_jsonb(m) from public.accounting_entity_map m where m.org_id=r.org_id and m.project_id is null and m.community_id is null and m.division_id is null) end)
 from public.lot_reservations r join public.lots l on l.id=r.lot_id and l.org_id=r.org_id
 join public.communities c on c.id=r.community_id and c.org_id=r.org_id join public.orgs o on o.id=r.org_id
 left join public.projects h on h.id=l.project_id and h.org_id=r.org_id where r.org_id=p_org and r.id=p_reservation;
$$;
revoke all on function public.reservation_conversion_source(uuid,uuid) from public,anon,authenticated,service_role;
-- Normalize timestamp representations without discarding microseconds.
create function public.normalize_reservation_conversion_source(p_source jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare result jsonb:=p_source; part text; buyers jsonb;
begin
 foreach part in array array['reservation','lot','community','home'] loop
  if result->part is not null and result->part<>'null'::jsonb then
   result:=jsonb_set(result,array[part,'updated_at'],to_jsonb((result->part->>'updated_at')::timestamptz));
  end if;
 end loop;
 if result->'reservation'->>'expires_at' is not null then
  result:=jsonb_set(result,'{reservation,expires_at}',to_jsonb((result->'reservation'->>'expires_at')::timestamptz));end if;
 select coalesce(jsonb_agg(jsonb_set(b,'{updated_at}',to_jsonb((b->>'updated_at')::timestamptz)) order by b->>'id'),'[]') into buyers from jsonb_array_elements(result->'buyers') b;
 return jsonb_set(result,'{buyers}',buyers);
end $$;
revoke all on function public.normalize_reservation_conversion_source(jsonb) from public,anon,authenticated,service_role;
create function public.reservation_conversion_reply(p_request public.reservation_conversion_requests,p_current jsonb) returns jsonb
language sql set search_path='' as $$
 select jsonb_build_object('scope',jsonb_build_object('orgId',p_request.org_id,'actorId',p_request.actor_id,'reservationId',p_request.reservation_id),
 'requestKey',p_request.id,'input',p_request.request,'review',p_request.bundle->'review',
 'status',case when p_request.status='pending' and public.normalize_reservation_conversion_source(p_request.bundle->'expected') is distinct from p_current then 'changed' else p_request.status end,
 'receipt',(select jsonb_build_object('receiptId',rc.id,'projectId',rc.project_id,'invoiceId',rc.invoice_id) from public.reservation_conversion_receipts rc where rc.org_id=p_request.org_id and rc.request_id=p_request.id));
$$;
revoke all on function public.reservation_conversion_reply(public.reservation_conversion_requests,jsonb) from public,anon,authenticated,service_role;

create function public.reservation_conversion(p_org_id uuid,p_actor_id uuid,p_reservation_id uuid,p_action text,p_request_key uuid default null,p_input jsonb default null,p_bundle jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 q public.reservation_conversion_requests; receipt public.reservation_conversion_receipts;
 r public.lot_reservations; l public.lots; c public.communities; h public.projects;
 current_source jsonb; first_lot uuid; first_community uuid; first_home uuid; home_id uuid;
 deposit bigint; invoice_id uuid; invoice_result jsonb; event_id uuid; audit_id bigint; contract_id uuid; role_id uuid;
 value jsonb; before_reservation jsonb;
begin
 if p_org_id is null or p_actor_id is null or p_reservation_id is null or p_action not in ('inspect','register','commit','cancel') or p_action is null then raise exception 'Valid reservation conversion identity required';end if;
 if (select auth.uid()) is not null and (select auth.uid())<>p_actor_id then raise exception 'Reservation conversion actor mismatch' using errcode='42501';end if;
 -- All actions, actors and request keys for one original hold share the lock.
 perform pg_advisory_xact_lock(hashtextextended('reservation-convert:'||p_org_id::text||':'||p_reservation_id::text,0));
 select r0.lot_id,r0.community_id,l0.project_id into first_lot,first_community,first_home from public.lot_reservations r0 join public.lots l0 on l0.id=r0.lot_id and l0.org_id=r0.org_id where r0.org_id=p_org_id and r0.id=p_reservation_id;
 if not found then raise exception 'Reservation conversion source is unavailable';end if;
 -- Authority facts are held through the commit. Existing homes use the original
 -- signing authority owner; new homes require current organization/division sales.
 if first_home is not null then perform public.assert_agreement_signing_actor(p_org_id,first_home,p_actor_id);end if;
 perform public.assert_reservation_conversion_community_actor(p_org_id,p_actor_id,first_community);
 -- New-home defaults include an optional org mapping. FOR UPDATE fences insertion
 -- of a previously absent FK-backed default. Measure this contention in E13 QA.
 if first_home is null then perform 1 from public.orgs where id=p_org_id for update;
 else perform 1 from public.orgs where id=p_org_id for share;end if;
 select * into c from public.communities where org_id=p_org_id and id=first_community for share;
 select * into l from public.lots where org_id=p_org_id and id=first_lot for update;
 select * into r from public.lot_reservations where org_id=p_org_id and id=p_reservation_id for update;
 if r.lot_id<>first_lot or r.community_id<>first_community or l.community_id<>c.id or l.project_id is distinct from first_home or (l.division_id is not null and l.division_id is distinct from c.division_id) then raise exception 'Reservation source ancestry changed';end if;
 if first_home is not null then
  select * into h from public.projects where org_id=p_org_id and id=first_home for update;
  if not found or h.property_type<>'production' or h.division_id is distinct from c.division_id then raise exception 'Reservation home ancestry changed';end if;
 end if;
 perform 1 from public.contacts where org_id=p_org_id and id in(r.buyer_contact_id,r.co_buyer_contact_id) order by id for share;
 if first_home is null then perform 1 from public.accounting_entity_map where org_id=p_org_id and project_id is null and community_id is null and division_id is null order by id for share;end if;
 current_source:=public.reservation_conversion_source(p_org_id,p_reservation_id);
 if p_request_key is not null then
  select * into q from public.reservation_conversion_requests where id=p_request_key for update;
  if found and (q.org_id<>p_org_id or q.actor_id<>p_actor_id or q.reservation_id<>p_reservation_id) then raise exception 'Original reservation request belongs to another context' using errcode='42501';end if;
 else
  select * into q from public.reservation_conversion_requests where org_id=p_org_id and actor_id=p_actor_id and reservation_id=p_reservation_id order by created_at desc,id desc limit 1 for update;
 end if;
 if p_action='inspect' then
  return jsonb_build_object('scope',jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'reservationId',p_reservation_id),'latest',case when q.id is null then null else public.reservation_conversion_reply(q,current_source) end);
 end if;
 if p_request_key is null or jsonb_typeof(p_input) is distinct from 'object' or p_input->>'reservationId' is distinct from p_reservation_id::text then raise exception 'Original reviewed request is required';end if;
 if q.id is not null then
  if q.request is distinct from p_input then raise exception 'Changed inputs cannot reuse the original reservation request';end if;
  if p_action='register' or q.status='committed' then return public.reservation_conversion_reply(q,current_source);end if;
  if q.status='cancelled' then raise exception 'Cancelled reservation review cannot be committed or reused';end if;
 elsif p_action<>'register' then raise exception 'Saved reservation review not found';end if;
 if p_action='cancel' then
  update public.reservation_conversion_requests set status='cancelled' where id=q.id returning * into q;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,'update','lot_reservation',r.id,jsonb_build_object('cancelled_conversion_request',q.id),'reservation_conversion');
  return public.reservation_conversion_reply(q,current_source);
 end if;
 if p_action='register' then
  if jsonb_typeof(p_bundle) is distinct from 'object' or public.normalize_reservation_conversion_source(p_bundle->'expected') is distinct from current_source then raise exception 'Reservation review source changed';end if;
  if exists(select 1 from public.reservation_conversion_requests where org_id=p_org_id and actor_id=p_actor_id and reservation_id=p_reservation_id and status='pending') then raise exception 'Inspect or cancel the existing reservation review before preparing another';end if;
 else p_bundle:=q.bundle;end if;
 if public.normalize_reservation_conversion_source(p_bundle->'expected') is distinct from current_source then raise exception 'Reviewed reservation source changed; inspect and cancel this review';end if;
 if r.status<>'hold' or (r.expires_at is not null and r.expires_at<=clock_timestamp()) or r.deposit_invoice_id is not null or r.contract_id is not null or l.status not in ('owned','developed','assigned','started') then raise exception 'Live sellable hold is required';end if;
 if not exists(select 1 from public.contacts where org_id=p_org_id and id=r.buyer_contact_id) or (r.co_buyer_contact_id is not null and (r.co_buyer_contact_id=r.buyer_contact_id or not exists(select 1 from public.contacts where org_id=p_org_id and id=r.co_buyer_contact_id))) then raise exception 'Reservation buyers are unavailable';end if;
 if first_home is not null and (h.client_id is not null and h.client_id<>r.buyer_contact_id or exists(select 1 from public.contracts where org_id=p_org_id and project_id=first_home and contract_type='purchase_agreement' and status in ('draft','active'))) then raise exception 'Home belongs to another sale';end if;
 if exists(select 1 from public.invoices where org_id=p_org_id and metadata->>'invoice_kind'='earnest_deposit' and metadata->>'source_reservation_id'=r.id::text) then raise exception 'Inspect the existing deposit before conversion';end if;
 deposit:=(p_input->>'depositCents')::bigint;
 if deposit is null or deposit<0 or deposit>2147483647 then raise exception 'Supported integer deposit required';end if;
 home_id:=coalesce(first_home,(p_bundle->>'projectId')::uuid);
 if home_id is null or p_bundle->>'projectId' is distinct from home_id::text then raise exception 'Prepared home identity mismatch';end if;
 if p_action='register' then
  insert into public.reservation_conversion_requests(id,org_id,actor_id,reservation_id,community_id,lot_id,request,bundle) values(p_request_key,p_org_id,p_actor_id,r.id,c.id,l.id,p_input,p_bundle) returning * into q;
  return public.reservation_conversion_reply(q,current_source);
 end if;
 before_reservation:=to_jsonb(r);
 if first_home is null then
  value:=p_bundle->'project';
  if value->>'org_id' is distinct from p_org_id::text or value->>'created_by' is distinct from p_actor_id::text or value->>'client_id' is distinct from r.buyer_contact_id::text or value->>'property_type'<>'production' or value->>'status'<>'planning' or value->>'prospect_id' is distinct from r.prospect_id::text then raise exception 'Prepared project ownership mismatch';end if;
  value:=value||jsonb_build_object('id',home_id,'division_id',c.division_id);
  insert into public.projects(id,org_id,name,status,phase,start_date,end_date,location,client_id,property_type,project_type,description,retainage_percent,total_value,created_by,prospect_id,division_id) select v.id,v.org_id,v.name,v.status,v.phase,v.start_date,v.end_date,v.location,v.client_id,v.property_type,v.project_type,v.description,v.retainage_percent,v.total_value,v.created_by,v.prospect_id,v.division_id from jsonb_populate_record(null::public.projects,value) v returning * into h;
  -- A production home earns through its purchase agreement, so the bundle carries no contract unless the service opened one.
  value:=p_bundle->'billingContract';
  if value is not null and jsonb_typeof(value)<>'null' then
    if value->>'org_id' is distinct from p_org_id::text or value->>'project_id' is distinct from home_id::text then raise exception 'Prepared billing ownership mismatch';end if;
    insert into public.contracts(org_id,project_id,title,status,contract_type,total_cents,currency,markup_percent,gmp_cents,contingency_cents,fixed_fee_cents,fee_presentation,savings_split_owner_pct,savings_split_builder_pct,labor_burden_multiplier,rate_schedule_id,requires_client_cost_approval,open_book,retainage_percent,retainage_applies_to_fee,retainage_schedule,stored_materials_retainage_percent,snapshot) select v.org_id,v.project_id,v.title,v.status,v.contract_type,v.total_cents,v.currency,v.markup_percent,v.gmp_cents,v.contingency_cents,v.fixed_fee_cents,v.fee_presentation,v.savings_split_owner_pct,v.savings_split_builder_pct,v.labor_burden_multiplier,v.rate_schedule_id,v.requires_client_cost_approval,v.open_book,v.retainage_percent,v.retainage_applies_to_fee,v.retainage_schedule,v.stored_materials_retainage_percent,v.snapshot from jsonb_populate_record(null::public.contracts,value) v returning id into contract_id;
    insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,'insert','contract',contract_id,value,'project_settings');
  end if;
  value:=p_bundle->'financialSettings';
  if value->>'org_id' is distinct from p_org_id::text or value->>'project_id' is distinct from home_id::text or value->>'created_by' is distinct from p_actor_id::text then raise exception 'Prepared financial settings ownership mismatch';end if;
  insert into public.project_financial_settings(org_id,project_id,billing_model,fixed_price_billing_basis,paid_costs_required,proof_required,client_cost_approval_required,open_book_required,cost_codes_enabled,setup_completed_at,setup_completed_by,updated_by,created_by,metadata) select v.org_id,v.project_id,v.billing_model,v.fixed_price_billing_basis,v.paid_costs_required,v.proof_required,v.client_cost_approval_required,v.open_book_required,v.cost_codes_enabled,v.setup_completed_at,v.setup_completed_by,v.updated_by,v.created_by,v.metadata from jsonb_populate_record(null::public.project_financial_settings,value) v ;
  if current_source->'accountingDefault'<>'null'::jsonb then
   insert into public.accounting_entity_map(org_id,connection_id,project_id,dimensions,created_by) values(p_org_id,(current_source->'accountingDefault'->>'connection_id')::uuid,home_id,p_bundle->'accountingDimensions',p_actor_id);
  end if;
  -- A creator already authorized for this community retains access when the
  -- organization uses assigned homes; copy one of their existing active roles.
  select m.role_id into role_id from public.memberships m where m.org_id=p_org_id and m.user_id=p_actor_id and m.status='active' order by m.id limit 1;
  if role_id is not null then insert into public.project_members(org_id,project_id,user_id,role_id,status) values(p_org_id,home_id,p_actor_id,role_id,'active');end if;
  insert into public.events(org_id,event_type,entity_type,entity_id,payload) values(p_org_id,'project_created','project',home_id,jsonb_build_object('name',h.name,'actor_id',p_actor_id));
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,'insert','project',home_id,to_jsonb(h),'reservation_conversion');
 else
  value:=to_jsonb(h);
  update public.projects set client_id=r.buyer_contact_id where org_id=p_org_id and id=home_id returning * into h;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source) values(p_org_id,p_actor_id,'update','project',home_id,value,to_jsonb(h),'reservation_conversion');
 end if;
 value:=to_jsonb(l);
 update public.lots set project_id=home_id,status=case when status='started' then status else 'assigned' end where org_id=p_org_id and id=l.id returning * into l;
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source) values(p_org_id,p_actor_id,'update','lot',l.id,value,to_jsonb(l),'reservation_conversion');
 if deposit>0 then
  value:=p_bundle->'invoice'->'invoice';
  if value->>'org_id' is distinct from p_org_id::text or value->>'project_id' is distinct from home_id::text or value->>'product_posture'<>'production' or value->>'approval_status'<>'not_required' or value->'metadata'->>'customer_id' is distinct from r.buyer_contact_id::text or value->'metadata'->>'source_reservation_id' is distinct from r.id::text or value->'metadata'->>'invoice_kind'<>'earnest_deposit' or (value->>'total_cents')::bigint is distinct from deposit or (value->>'subtotal_cents')::bigint is distinct from deposit or (value->>'balance_due_cents')::bigint is distinct from deposit or (value->>'tax_cents')::bigint is distinct from 0::bigint or jsonb_array_length(p_bundle->'invoice'->'lines')<>1 or (p_bundle->'invoice'->'lines'->0->>'unit_price_cents')::bigint is distinct from deposit or (p_bundle->'invoice'->'lines'->0->>'quantity')::numeric is distinct from 1::numeric then raise exception 'Prepared earnest invoice evidence mismatch';end if;
  invoice_result:=public.create_invoice_atomic(p_org_id,value,p_bundle->'invoice'->'lines');invoice_id:=(invoice_result->'invoice'->>'id')::uuid;
  if invoice_id is null then raise exception 'Invoice owner did not return its committed identity';end if;
  insert into public.events(org_id,event_type,entity_type,entity_id,payload) values(p_org_id,'invoice_created','invoice',invoice_id,jsonb_build_object('invoice_number',value->>'invoice_number','project_id',home_id,'total_cents',deposit,'actor_id',p_actor_id));
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,'insert','invoice',invoice_id,value,'reservation_conversion');
  -- Existing issuance owner consumes the frozen recipients. No provider call is
  -- made inside this transaction or by recovery/replay.
  insert into public.outbox(org_id,job_type,payload,dedupe_key) values(p_org_id,'issue_invoice',jsonb_build_object('invoice_id',invoice_id,'invoice_number',value->>'invoice_number','project_id',home_id,'total_cents',deposit,'due_date',value->>'due_date','sent_to_emails',value->'sent_to_emails','actor_id',p_actor_id,'reservation_conversion_request_id',q.id),'issue_invoice:invoice_id:'||invoice_id::text);
  insert into public.outbox(org_id,job_type,payload) values(p_org_id,'reindex_search',jsonb_build_object('entity_type','invoice','entity_id',invoice_id));
 end if;
 update public.lot_reservations set status='reserved',deposit_required_cents=deposit,deposit_invoice_id=invoice_id where org_id=p_org_id and id=r.id returning * into r;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload) values(p_org_id,'lot_reserved','lot_reservation',r.id,jsonb_build_object('project_id',home_id,'deposit_invoice_id',invoice_id,'actor_id',p_actor_id,'request_id',q.id)) returning id into event_id;
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source) values(p_org_id,p_actor_id,'update','lot_reservation',r.id,before_reservation,to_jsonb(r),'reservation_conversion') returning id into audit_id;
 insert into public.outbox(org_id,job_type,payload) values(p_org_id,'reindex_search',jsonb_build_object('entity_type','project','entity_id',home_id));
 insert into public.reservation_conversion_receipts(org_id,request_id,reservation_id,project_id,invoice_id,event_id,audit_id,reservation_source) values(p_org_id,q.id,r.id,home_id,invoice_id,event_id,audit_id,to_jsonb(r)) returning * into receipt;
 update public.reservation_conversion_requests set status='committed' where id=q.id returning * into q;
 return public.reservation_conversion_reply(q,current_source);
end $$;
revoke all on function public.reservation_conversion(uuid,uuid,uuid,text,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.reservation_conversion(uuid,uuid,uuid,text,uuid,jsonb,jsonb) to service_role;
