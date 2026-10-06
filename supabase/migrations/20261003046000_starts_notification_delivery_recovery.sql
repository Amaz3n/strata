-- STAGED, UNAPPLIED. Keep both delivery and starts-recovery rollouts disabled.
-- Permanent recovery request identities survive queue retention. Replays never
-- allocate another job; source notifications must still exist and match.
create table public.notification_delivery_recoveries (
 id uuid primary key,
 org_id uuid not null,
 receipt_id uuid not null references public.notification_delivery_receipts(id),
 package_id uuid not null,
 actor_id uuid not null,
 reason text not null check(length(btrim(reason)) between 10 and 1000),
 previous_job_id bigint,
 job_id bigint not null,
 event_id uuid not null,
 audit_id bigint not null,
 consumed_at timestamptz,
 created_at timestamptz not null default clock_timestamp()
);
create index notification_delivery_recoveries_receipt_idx on public.notification_delivery_recoveries(org_id,receipt_id,created_at);
alter table public.notification_delivery_recoveries enable row level security;
create policy notification_delivery_recoveries_service_access on public.notification_delivery_recoveries for all to service_role using(true) with check(true);
revoke all on public.notification_delivery_recoveries from public,anon,authenticated;
grant select,insert on public.notification_delivery_recoveries to service_role;
grant update(consumed_at) on public.notification_delivery_recoveries to service_role;
create function public.guard_notification_delivery_recovery() returns trigger language plpgsql set search_path=public,pg_catalog as $$
begin
 if tg_op='UPDATE' and pg_trigger_depth()>=2 and old.consumed_at is null and new.consumed_at is not null
   and (to_jsonb(new)-'consumed_at')=(to_jsonb(old)-'consumed_at')
   and coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-notification-recovery-id'=new.id::text then return new;end if;
 raise exception 'Delivery recovery evidence is immutable' using errcode='42501';
end $$;
create trigger notification_delivery_recovery_guard before update or delete on public.notification_delivery_recoveries for each row execute function public.guard_notification_delivery_recovery();
revoke all on function public.guard_notification_delivery_recovery() from public,anon,authenticated;

create or replace function public.guard_notification_delivery_receipt() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_note public.notifications%rowtype; v_job public.outbox%rowtype; v_recovery public.notification_delivery_recoveries%rowtype; v_request text;
begin
 if current_user in ('anon','authenticated') then raise exception 'Delivery receipts require service role' using errcode='42501'; end if;
 if tg_op='DELETE' then raise exception 'Delivery receipts cannot be deleted' using errcode='42501'; end if;
 if tg_op='UPDATE' then
   if (to_jsonb(new)-array['status','completed_at','outbox_job_id']) is distinct from (to_jsonb(old)-array['status','completed_at','outbox_job_id'])
     then raise exception 'Delivery receipt identity is immutable' using errcode='42501'; end if;
   if old.status='completed' and (new.status is distinct from old.status or new.completed_at is distinct from old.completed_at) then raise exception 'Completed delivery receipt is immutable' using errcode='42501'; end if;
   if old.status='failed' and new.status='pending' then
     v_request:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-notification-recovery-id';
     if coalesce(v_request,'')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Failed delivery requires audited recovery' using errcode='42501'; end if;
     select * into v_recovery from public.notification_delivery_recoveries where id=v_request::uuid and org_id=old.org_id and receipt_id=old.id;
     if not found or v_recovery.previous_job_id is distinct from old.outbox_job_id or v_recovery.job_id is distinct from new.outbox_job_id or v_recovery.consumed_at is not null then
       raise exception 'Delivery recovery proof does not match the receipt' using errcode='42501'; end if;
     update public.notification_delivery_recoveries set consumed_at=clock_timestamp() where id=v_recovery.id;
   end if;
   if new.outbox_job_id is distinct from old.outbox_job_id then
     if new.outbox_job_id is null and old.status in ('completed','failed') and new.status=old.status
       and not exists(select 1 from public.outbox where id=old.outbox_job_id) then return new; end if;
     if not(old.status='failed' and new.status='pending' and old.outbox_job_id is null and v_recovery.id is not null)
       then raise exception 'Delivery receipt cannot replace its original job' using errcode='42501'; end if;
   end if;
 end if;
 if new.outbox_job_id is null then raise exception 'Delivery receipt requires its original job' using errcode='42501'; end if;
 select * into v_job from public.outbox where id=new.outbox_job_id for share;
 if not found or v_job.org_id is distinct from new.org_id or v_job.job_type is distinct from new.job_type
   or v_job.payload->>'notificationId' is distinct from new.notification_id::text
   or v_job.payload->>'deliveryReceiptId' is distinct from new.id::text or v_job.status is distinct from new.status
   then raise exception 'Delivery receipt job scope mismatch' using errcode='42501'; end if;
 if tg_op='INSERT' then
   select * into v_note from public.notifications where id=new.notification_id and org_id=new.org_id for share;
   if not found or v_note.user_id is distinct from new.notification_user_id or v_note.notification_type is distinct from new.notification_type
     or encode(sha256(convert_to(v_note.payload::text,'UTF8')),'hex') is distinct from new.payload_hash
     then raise exception 'Delivery receipt notification scope mismatch' using errcode='42501'; end if;
 end if;
 if (new.status='completed') is distinct from (new.completed_at is not null) then raise exception 'Invalid delivery completion receipt' using errcode='42501'; end if;
 return new;
end $$;

create function public.assert_starts_actor_permission(p_job public.outbox,p_package public.start_packages,p_permission text)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_actor uuid; v_members uuid[]; v_roles uuid[]; v_base text[]; v_grants text[]; v_denies text[]; v_effective text[];
 v_assigned boolean; v_division uuid; v_lot_community uuid; v_lot_project uuid; v_divisions uuid[];
begin
 if p_permission not in ('start.release','start.read') or p_permission is null then raise exception 'Invalid starts permission scope' using errcode='42501'; end if;
 if p_job.org_id is distinct from p_package.org_id or p_job.job_type<>'start_release' then raise exception 'Starts actor scope mismatch' using errcode='42501'; end if;
 v_actor:=(p_job.payload->>'actor_id')::uuid;
 if v_actor is null then raise exception 'Starts actor missing' using errcode='42501'; end if;
 perform 1 from public.permissions where key=p_permission for share;
 if not found then raise exception 'Starts release permission is not registered' using errcode='42501'; end if;
 -- Parent UPDATE locks also block FK-backed insertion of a new override while
 -- permission facts are being used. Existing override/role rows are share locked.
 perform 1 from public.memberships where org_id=p_job.org_id and user_id=v_actor and status='active' order by id for update;
 select array_agg(id order by id),array_agg(distinct role_id),bool_or(division_scope='assigned') into v_members,v_roles,v_assigned
   from public.memberships where org_id=p_job.org_id and user_id=v_actor and status='active';
 if v_members is null then raise exception 'Starts actor is no longer an active organization member' using errcode='42501'; end if;
 perform 1 from public.role_permissions where role_id=any(v_roles) order by role_id,permission_key for share;
 perform 1 from public.membership_permission_overrides where membership_id=any(v_members) order by membership_id,permission_key for share;
 select coalesce(array_agg(distinct permission_key),'{}') into v_base from public.role_permissions where role_id=any(v_roles);
 select coalesce(array_agg(permission_key) filter(where effect='grant'),'{}'),coalesce(array_agg(permission_key) filter(where effect='deny'),'{}') into v_grants,v_denies
   from public.membership_permission_overrides where membership_id=any(v_members);
 select coalesce(array_agg(distinct x),'{}') into v_effective from unnest(v_base||v_grants) x where not(x=any(v_denies));
 if p_permission=any(v_denies) or not(p_permission=any(v_effective) or '*'=any(v_effective)) then raise exception 'Starts actor no longer has release permission' using errcode='42501'; end if;
 -- Mirrors fetchOrgPermissions division scope: a base org.admin role bypasses
 -- assignment scope; grants/denies still govern the requested release permission.
 v_assigned:=v_assigned and not('org.admin'=any(v_base));
 if v_assigned then
   perform 1 from public.membership_divisions where membership_id=any(v_members) order by membership_id,division_id for share;
   select coalesce(array_agg(distinct division_id),'{}') into v_divisions from public.membership_divisions where membership_id=any(v_members);
 end if;
 select division_id into v_division from public.communities where org_id=p_job.org_id and id=p_package.community_id for share;
 if not found then raise exception 'Starts community not found in organization' using errcode='42501'; end if;
 if v_assigned and (v_division is null or not(v_division=any(v_divisions))) then raise exception 'Starts community is outside actor division access' using errcode='42501'; end if;
 select division_id,community_id,project_id into v_division,v_lot_community,v_lot_project from public.lots where org_id=p_job.org_id and id=p_package.lot_id for share;
 if not found or v_lot_community is distinct from p_package.community_id then raise exception 'Starts lot ancestry differs from package' using errcode='42501'; end if;
 if v_assigned and (v_division is null or not(v_division=any(v_divisions))) then raise exception 'Starts lot is outside actor division access' using errcode='42501'; end if;
 if p_package.project_id is not null then
   if v_lot_project is distinct from p_package.project_id then raise exception 'Starts lot home ancestry differs from package' using errcode='42501'; end if;
   select division_id into v_division from public.projects where org_id=p_job.org_id and id=p_package.project_id for share;
   if not found then raise exception 'Starts home not found in organization' using errcode='42501'; end if;
   if v_assigned and (v_division is null or not(v_division=any(v_divisions))) then raise exception 'Starts home is outside actor division access' using errcode='42501'; end if;
 end if;
end $$;
revoke all on function public.assert_starts_actor_permission(public.outbox,public.start_packages,text) from public,anon,authenticated;
grant execute on function public.assert_starts_actor_permission(public.outbox,public.start_packages,text) to service_role;
create or replace function public.assert_starts_release_actor(p_job public.outbox,p_package public.start_packages)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
begin perform public.assert_starts_actor_permission(p_job,p_package,'start.release');end $$;
create function public.assert_start_notification_recipient(p_note public.notifications,p_package public.start_packages)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_job public.outbox%rowtype;v_super uuid;
begin
 select superintendent_id into v_super from public.projects where org_id=p_package.org_id and id=p_package.project_id for share;
 if not found or p_note.org_id is distinct from p_package.org_id or p_note.user_id is null then raise exception 'Notification recipient scope mismatch' using errcode='42501'; end if;
 v_job.org_id:=p_note.org_id;v_job.job_type:='start_release';v_job.payload:=jsonb_build_object('actor_id',p_note.user_id);
 perform public.assert_starts_actor_permission(v_job,p_package,case when p_note.user_id=v_super then 'start.read' else 'start.release' end);
end $$;
revoke all on function public.assert_start_notification_recipient(public.notifications,public.start_packages) from public,anon,authenticated;
grant execute on function public.assert_start_notification_recipient(public.notifications,public.start_packages) to service_role;

create function public.retry_start_notification_delivery(p_org_id uuid,p_package_id uuid,p_receipt_id uuid,p_actor_id uuid,p_request_id uuid,p_reason text)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_actor_job public.outbox%rowtype; v_note public.notifications%rowtype;
 v_receipt public.notification_delivery_receipts%rowtype; v_job public.outbox%rowtype; v_recovery public.notification_delivery_recoveries%rowtype;
 v_headers text:=current_setting('request.headers',true); v_context jsonb; v_previous bigint; v_event uuid; v_audit bigint; v_evidence jsonb; v_source jsonb;v_changed integer;
begin
 if current_user in ('anon','authenticated') then raise exception 'Delivery recovery requires service role' using errcode='42501'; end if;
 if p_org_id is null or p_package_id is null or p_receipt_id is null or p_actor_id is null or p_request_id is null
   or p_reason is null or length(btrim(p_reason))<10 or length(btrim(p_reason))>1000 then raise exception 'Invalid delivery recovery request'; end if;
 v_context:=coalesce(nullif(v_headers,''),'{}')::jsonb;
 if v_context->>'x-starts-job-id' is not null or v_context->>'x-starts-claim-token' is not null then raise exception 'Delivery recovery cannot run inside a worker claim' using errcode='42501'; end if;
 select * into v_pkg from public.start_packages where org_id=p_org_id and id=p_package_id for update;
 if not found or v_pkg.status is distinct from 'released' or v_pkg.project_id is null or v_pkg.released_by is null
   or v_pkg.released_at is null or v_pkg.actual_start_date is null then raise exception 'Delivery recovery requires original released-home evidence' using errcode='42501'; end if;
 v_actor_job.org_id:=p_org_id;v_actor_job.job_type:='start_release';v_actor_job.payload:=jsonb_build_object('start_package_id',p_package_id,'actor_id',p_actor_id);
 perform public.assert_starts_release_actor(v_actor_job,v_pkg);
 v_source:=jsonb_build_object('project_id',v_pkg.project_id,'community_id',v_pkg.community_id,'lot_id',v_pkg.lot_id,'released_by',v_pkg.released_by,'released_at',v_pkg.released_at,'actual_start_date',v_pkg.actual_start_date);
 -- Read identity without locking. Take notification -> job -> receipt locks in
 -- the same order as delivery reservation, completion and retention.
 select * into v_receipt from public.notification_delivery_receipts where org_id=p_org_id and id=p_receipt_id;
 if not found then raise exception 'Delivery receipt unavailable in organization' using errcode='42501'; end if;
 select * into v_note from public.notifications where org_id=p_org_id and id=v_receipt.notification_id for update;
 if not found or v_note.notification_type is distinct from 'start_released' or v_note.payload->>'entity_type' is distinct from 'start_package'
   or v_note.payload->>'entity_id' is distinct from p_package_id::text or v_note.payload->>'project_id' is distinct from v_pkg.project_id::text then
   raise exception 'Original package notification is unavailable' using errcode='42501'; end if;
 if v_receipt.outbox_job_id is not null then perform 1 from public.outbox where id=v_receipt.outbox_job_id and org_id=p_org_id for update; end if;
 select * into v_receipt from public.notification_delivery_receipts where org_id=p_org_id and id=p_receipt_id for update;
 if v_receipt.notification_user_id is distinct from v_note.user_id or v_receipt.notification_type is distinct from v_note.notification_type
   or v_receipt.payload_hash is distinct from encode(sha256(convert_to(v_note.payload::text,'UTF8')),'hex') then raise exception 'Notification differs from its delivery receipt' using errcode='42501'; end if;
 perform public.assert_start_notification_recipient(v_note,v_pkg);
 -- A lost response reuses the durable request proof even if the delivery has
 -- completed or its queue row has since been pruned. Authorization still applies.
 select * into v_recovery from public.notification_delivery_recoveries where id=p_request_id;
 if found then
   if v_recovery.consumed_at is null then raise exception 'Recovery proof was not consumed' using errcode='42501'; end if;
   if v_recovery.org_id is distinct from p_org_id or v_recovery.receipt_id is distinct from p_receipt_id or v_recovery.package_id is distinct from p_package_id
     or v_recovery.actor_id is distinct from p_actor_id or v_recovery.reason is distinct from btrim(p_reason) then raise exception 'Recovery request identity belongs to different evidence' using errcode='42501'; end if;
   return jsonb_build_object('request_id',v_recovery.id,'receipt_id',v_recovery.receipt_id,'job_id',v_recovery.job_id::text,'event_id',v_recovery.event_id,'audit_id',v_recovery.audit_id::text,'status',v_receipt.status,'replayed',true);
 end if;
 if v_receipt.status is distinct from 'failed' then raise exception 'Only failed deliveries can be recovered' using errcode='40001'; end if;
 v_previous:=v_receipt.outbox_job_id;
 if v_previous is not null then
   select * into v_job from public.outbox where org_id=p_org_id and id=v_previous for update;
   if not found or v_job.status is distinct from 'failed' or v_job.job_type is distinct from v_receipt.job_type
     or v_job.payload->>'deliveryReceiptId' is distinct from v_receipt.id::text
     or v_job.payload->>'notificationId' is distinct from v_note.id::text then raise exception 'Failed delivery job differs from its receipt' using errcode='42501'; end if;
 else
   if exists(select 1 from public.outbox where org_id=p_org_id and job_type=v_receipt.job_type and lower(payload->>'notificationId')=v_note.id::text) then
     raise exception 'Unreceipted delivery history requires reconciliation' using errcode='42501'; end if;
   insert into public.outbox(org_id,job_type,payload,dedupe_key)
     values(p_org_id,v_receipt.job_type,jsonb_build_object('notificationId',v_note.id,'deliveryReceiptId',v_receipt.id),
       'notification-delivery:v1:'||v_receipt.job_type||':'||v_note.id) returning * into v_job;
 end if;
 v_evidence:=jsonb_build_object('request_id',p_request_id,'receipt_id',p_receipt_id,'previous_job_id',v_previous::text,'job_id',v_job.id::text,
   'actor_id',p_actor_id,'reason',btrim(p_reason),'project_id',v_pkg.project_id,'notification_id',v_note.id,'channel',v_receipt.job_type,'release_evidence',v_source);
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
   values(p_org_id,p_actor_id,'update','start_package',p_package_id,jsonb_build_object('status','failed','receipt_id',p_receipt_id),v_evidence,'starts.notification_delivery_recovery') returning id into v_audit;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
   values(p_org_id,'start.notification_delivery_retried','start_package',p_package_id,v_evidence,'activity') returning id into v_event;
 insert into public.notification_delivery_recoveries(id,org_id,receipt_id,package_id,actor_id,reason,previous_job_id,job_id,event_id,audit_id)
   values(p_request_id,p_org_id,p_receipt_id,p_package_id,p_actor_id,btrim(p_reason),v_previous,v_job.id,v_event,v_audit);
 perform set_config('request.headers',(v_context||jsonb_build_object('x-notification-recovery-id',p_request_id))::text,true);
 if v_previous is not null then
   update public.outbox set status='pending',retry_count=0,last_error=null,run_at=clock_timestamp(),updated_at=clock_timestamp() where id=v_previous and status='failed';
   get diagnostics v_changed=row_count;
   if v_changed<>1 then raise exception 'Failed delivery job changed during recovery' using errcode='40001'; end if;
 else
   update public.notification_delivery_receipts set status='pending',outbox_job_id=v_job.id,completed_at=null where id=p_receipt_id;
 end if;
 perform set_config('request.headers',coalesce(v_headers,''),true);
 select * into v_pkg from public.start_packages where org_id=p_org_id and id=p_package_id for update;
 if not found or v_pkg.status is distinct from 'released' or jsonb_build_object('project_id',v_pkg.project_id,'community_id',v_pkg.community_id,'lot_id',v_pkg.lot_id,'released_by',v_pkg.released_by,'released_at',v_pkg.released_at,'actual_start_date',v_pkg.actual_start_date) is distinct from v_source then raise exception 'Released home changed during delivery recovery' using errcode='40001'; end if;
 perform public.assert_starts_release_actor(v_actor_job,v_pkg);
 select * into v_note from public.notifications where org_id=p_org_id and id=v_note.id for update;
 if not found or v_note.user_id is distinct from v_receipt.notification_user_id or v_note.notification_type is distinct from v_receipt.notification_type
   or encode(sha256(convert_to(v_note.payload::text,'UTF8')),'hex') is distinct from v_receipt.payload_hash then raise exception 'Notification changed during recovery' using errcode='40001'; end if;
 perform public.assert_start_notification_recipient(v_note,v_pkg);
 select * into v_receipt from public.notification_delivery_receipts where id=p_receipt_id for update;
 if v_receipt.status is distinct from 'pending' or v_receipt.outbox_job_id is distinct from v_job.id then raise exception 'Delivery intent changed during recovery' using errcode='40001'; end if;
 if not exists(select 1 from public.notification_delivery_recoveries where id=p_request_id and consumed_at is not null) then raise exception 'Recovery proof was not consumed' using errcode='40001'; end if;
 return jsonb_build_object('request_id',p_request_id,'receipt_id',p_receipt_id,'job_id',v_job.id::text,'event_id',v_event,'audit_id',v_audit::text,'status','pending','replayed',false);
end $$;
revoke all on function public.retry_start_notification_delivery(uuid,uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.retry_start_notification_delivery(uuid,uuid,uuid,uuid,uuid,text) to service_role;
