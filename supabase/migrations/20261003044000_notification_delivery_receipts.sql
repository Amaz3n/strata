-- STAGED, UNAPPLIED. Consumers remain inactive until migration approval,
-- historical delivery reconciliation, scoped-worker and QA cutover acceptance.
-- Compact identity/hash receipts survive normal event/notification/outbox pruning.
create index outbox_notification_delivery_source_idx
 on public.outbox(org_id,job_type,(lower(payload->>'notificationId')),id)
 where job_type in ('deliver_notification','deliver_push');

create table public.notification_delivery_receipts (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 notification_id uuid not null,
 job_type text not null check(job_type in ('deliver_notification','deliver_push')),
 notification_user_id uuid not null,
 notification_type text not null,
 payload_hash text not null check(length(payload_hash)=64),
 outbox_job_id bigint references public.outbox(id) on delete set null,
 status text not null check(status in ('pending','processing','completed','failed')),
 created_at timestamptz not null default clock_timestamp(),
 completed_at timestamptz,
 unique(org_id,notification_id,job_type),
 unique(outbox_job_id)
);
alter table public.notification_delivery_receipts enable row level security;
create policy notification_delivery_service_access on public.notification_delivery_receipts
 for all to service_role using(true) with check(true);
revoke all on public.notification_delivery_receipts from public,anon,authenticated;
grant select,insert,update on public.notification_delivery_receipts to service_role;

create function public.guard_notification_delivery_receipt() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_note public.notifications%rowtype; v_job public.outbox%rowtype;
begin
 if current_user in ('anon','authenticated') then raise exception 'Delivery receipts require service role' using errcode='42501'; end if;
 if tg_op='DELETE' then raise exception 'Delivery receipts cannot be deleted' using errcode='42501'; end if;
 if tg_op='UPDATE' then
   if (to_jsonb(new)-array['status','completed_at','outbox_job_id']) is distinct from (to_jsonb(old)-array['status','completed_at','outbox_job_id'])
     then raise exception 'Delivery receipt identity is immutable' using errcode='42501'; end if;
   if old.status='completed' and (new.status is distinct from old.status or new.completed_at is distinct from old.completed_at) then raise exception 'Completed delivery receipt is immutable' using errcode='42501'; end if;
   if new.outbox_job_id is distinct from old.outbox_job_id then
     if new.outbox_job_id is null and old.status in ('completed','failed') and new.status=old.status
       and not exists(select 1 from public.outbox where id=old.outbox_job_id) then return new; end if;
     raise exception 'Delivery receipt cannot replace its original job' using errcode='42501';
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
create trigger notification_delivery_receipt_guard before insert or update or delete on public.notification_delivery_receipts
 for each row execute function public.guard_notification_delivery_receipt();

create function public.guard_receipted_notification_job() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 if exists(select 1 from public.notification_delivery_receipts where outbox_job_id=old.id) then
   if current_setting('role',true) in ('anon','authenticated') then raise exception 'Receipted delivery jobs require service role' using errcode='42501'; end if;
   if tg_op='DELETE' then
     if old.status not in ('completed','failed') then raise exception 'Active delivery jobs cannot be pruned' using errcode='42501'; end if;
     return old;
   end if;
   if new.id is distinct from old.id or new.org_id is distinct from old.org_id or new.job_type is distinct from old.job_type
     or new.payload is distinct from old.payload or new.dedupe_key is distinct from old.dedupe_key
     then raise exception 'Receipted delivery job identity is immutable' using errcode='42501'; end if;
   if old.status='completed' and new.status is distinct from 'completed' then raise exception 'Completed delivery cannot be requeued' using errcode='42501'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;return new;
end $$;
create trigger receipted_notification_job_guard before update or delete on public.outbox
 for each row execute function public.guard_receipted_notification_job();

create function public.sync_notification_delivery_receipt() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 update public.notification_delivery_receipts set status=new.status,
   completed_at=case when new.status='completed' then coalesce(completed_at,clock_timestamp()) else null end
   where outbox_job_id=new.id;
 return new;
end $$;
create trigger notification_delivery_receipt_sync after update of status on public.outbox
 for each row when(old.status is distinct from new.status) execute function public.sync_notification_delivery_receipt();

create function public.reserve_notification_delivery(p_org_id uuid,p_notification_id uuid,p_job_type text)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_note public.notifications%rowtype; v_receipt public.notification_delivery_receipts%rowtype;
 v_job public.outbox%rowtype; v_parent public.outbox%rowtype; v_pkg public.start_packages%rowtype;
 v_headers text:=current_setting('request.headers',true); v_context jsonb; v_ids bigint[]; v_hash text; v_receipt_id uuid;
begin
 if current_user in ('anon','authenticated') then raise exception 'Delivery reservation requires service role' using errcode='42501'; end if;
 if p_org_id is null or p_notification_id is null or p_job_type is null or p_job_type not in ('deliver_notification','deliver_push') then raise exception 'Invalid delivery reservation'; end if;
 v_context:=coalesce(nullif(v_headers,''),'{}')::jsonb;
 -- For the future claim-scoped starts consumer, validate job then package
 -- before the notification lock; use the same order as release write fences.
 if v_context->>'x-starts-job-id' is not null or v_context->>'x-starts-claim-token' is not null then
   if coalesce(v_context->>'x-starts-job-id','')!~'^[1-9][0-9]{0,18}$'
     or coalesce(v_context->>'x-starts-claim-token','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid starts confirmation context' using errcode='42501'; end if;
   select * into v_parent from public.outbox where id=(v_context->>'x-starts-job-id')::bigint and org_id=p_org_id
     and job_type='start_release' and status='processing' and start_claim_token=(v_context->>'x-starts-claim-token')::uuid
     and start_job_lease_expires_at>clock_timestamp() for update;
   if not found then raise exception 'Starts confirmation claim lost' using errcode='40001'; end if;
   select * into v_pkg from public.start_packages where org_id=p_org_id and id=(v_parent.payload->>'start_package_id')::uuid for update;
   if not found or v_pkg.status is distinct from 'released' then raise exception 'Starts confirmation requires a released package' using errcode='42501'; end if;
   perform public.assert_starts_release_actor(v_parent,v_pkg);
 end if;
 select * into v_note from public.notifications where org_id=p_org_id and id=p_notification_id for update;
 if not found then raise exception 'Notification unavailable in organization' using errcode='42501'; end if;
 if v_pkg.id is not null and (v_note.notification_type is distinct from 'start_released'
   or v_note.payload->>'entity_type' is distinct from 'start_package' or v_note.payload->>'entity_id' is distinct from v_pkg.id::text
   or v_note.payload->>'project_id' is distinct from v_pkg.project_id::text) then raise exception 'Starts confirmation notification scope mismatch' using errcode='42501'; end if;
 v_hash:=encode(sha256(convert_to(v_note.payload::text,'UTF8')),'hex');
 -- The notification lock serializes competing reservations. Outbox locks come
 -- before receipt locks, matching completion and retention triggers.
 select * into v_receipt from public.notification_delivery_receipts
   where org_id=p_org_id and notification_id=p_notification_id and job_type=p_job_type;
 if found then
   if v_receipt.outbox_job_id is not null then perform 1 from public.outbox where id=v_receipt.outbox_job_id for update; end if;
   select * into v_receipt from public.notification_delivery_receipts where id=v_receipt.id for update;
   if v_receipt.notification_user_id is distinct from v_note.user_id or v_receipt.notification_type is distinct from v_note.notification_type
     or v_receipt.payload_hash is distinct from v_hash then raise exception 'Notification differs from its delivery receipt' using errcode='42501'; end if;
   if v_receipt.outbox_job_id is null and v_receipt.status not in ('completed','failed') then raise exception 'Active delivery receipt has lost its job' using errcode='42501'; end if;
 else
   select array_agg(id) into v_ids from (select id from public.outbox where org_id=p_org_id and job_type=p_job_type
     and lower(payload->>'notificationId')=p_notification_id::text order by id limit 2 for update) existing;
   if cardinality(v_ids)>1 then raise exception 'Multiple historical delivery jobs require reconciliation' using errcode='42501'; end if;
   v_receipt_id:=gen_random_uuid();
   -- Header suppression is limited to this already-authorized delivery intent.
   perform set_config('request.headers','{}',true);
   if cardinality(v_ids)=1 then
     update public.outbox set payload=payload||jsonb_build_object('notificationId',p_notification_id,'deliveryReceiptId',v_receipt_id) where id=v_ids[1] returning * into v_job;
   else
     insert into public.outbox(org_id,job_type,payload,dedupe_key)
       values(p_org_id,p_job_type,jsonb_build_object('notificationId',p_notification_id,'deliveryReceiptId',v_receipt_id),'notification-delivery:v1:'||p_job_type||':'||p_notification_id)
       returning * into v_job;
   end if;
   insert into public.notification_delivery_receipts(id,org_id,notification_id,job_type,notification_user_id,notification_type,payload_hash,outbox_job_id,status,completed_at)
     values(v_receipt_id,p_org_id,p_notification_id,p_job_type,v_note.user_id,v_note.notification_type,v_hash,v_job.id,v_job.status,
       case when v_job.status='completed' then clock_timestamp() else null end) returning * into v_receipt;
   perform set_config('request.headers',coalesce(v_headers,''),true);
 end if;
 if v_parent.id is not null then
   select * into v_parent from public.outbox where id=v_parent.id and org_id=p_org_id and job_type='start_release'
     and status='processing' and start_claim_token=(v_context->>'x-starts-claim-token')::uuid
     and start_job_lease_expires_at>clock_timestamp() for update;
   if not found then raise exception 'Starts confirmation claim lost during reservation' using errcode='40001'; end if;
   select * into v_pkg from public.start_packages where org_id=p_org_id and id=v_pkg.id for update;
   if not found or v_pkg.status is distinct from 'released' or v_note.payload->>'project_id' is distinct from v_pkg.project_id::text then
     raise exception 'Starts confirmation package changed during reservation' using errcode='42501'; end if;
   perform public.assert_starts_release_actor(v_parent,v_pkg);
 end if;
 return jsonb_build_object('receipt_id',v_receipt.id,'job_id',v_receipt.outbox_job_id::text,'status',v_receipt.status);
end $$;
revoke all on function public.reserve_notification_delivery(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.reserve_notification_delivery(uuid,uuid,text) to service_role;
revoke all on function public.guard_notification_delivery_receipt(),public.guard_receipted_notification_job(),public.sync_notification_delivery_receipt() from public,anon,authenticated;
