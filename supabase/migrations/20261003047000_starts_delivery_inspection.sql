-- STAGED, UNAPPLIED. Permanent source scope enables bounded operator reads
-- after notification/outbox retention. Both recovery rollout gates remain off.
alter table public.notification_delivery_receipts add column source_entity_type text,
 add column source_entity_id text,add column source_project_id text;
-- ALTER holds the table lock through the migration transaction. Remove the
-- identity guard only for verified historical scope enrichment, then restore it.
drop trigger notification_delivery_receipt_guard on public.notification_delivery_receipts;
update public.notification_delivery_receipts r set source_entity_type=n.payload->>'entity_type',
 source_entity_id=n.payload->>'entity_id',source_project_id=n.payload->>'project_id'
 from public.notifications n where n.org_id=r.org_id and n.id=r.notification_id and n.user_id=r.notification_user_id
 and n.notification_type=r.notification_type and encode(sha256(convert_to(n.payload::text,'UTF8')),'hex')=r.payload_hash;
-- Missing or altered source records remain unresolved; do not infer their home.
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
   new.source_entity_type:=v_note.payload->>'entity_type';
   new.source_entity_id:=v_note.payload->>'entity_id';
   new.source_project_id:=v_note.payload->>'project_id';
 end if;
 if (new.status='completed') is distinct from (new.completed_at is not null) then raise exception 'Invalid delivery completion receipt' using errcode='42501'; end if;
 return new;
end $$;


create trigger notification_delivery_receipt_guard before insert or update or delete on public.notification_delivery_receipts
 for each row execute function public.guard_notification_delivery_receipt();
create index notification_delivery_receipts_package_idx on public.notification_delivery_receipts(org_id,source_entity_id,id)
 where source_entity_type='start_package';
create function public.list_start_notification_deliveries(p_org_id uuid,p_package_id uuid,p_actor_id uuid,p_after uuid default null,p_failed_only boolean default true,p_limit integer default 20)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype;v_job public.outbox%rowtype;v_rows jsonb;v_next uuid;v_more boolean;
begin
 if current_user in ('anon','authenticated') then raise exception 'Delivery inspection requires service role' using errcode='42501';end if;
 if p_org_id is null or p_package_id is null or p_actor_id is null or p_limit is null or p_limit<1 or p_limit>50 or p_failed_only is null then raise exception 'Invalid delivery inspection request';end if;
 select * into v_pkg from public.start_packages where org_id=p_org_id and id=p_package_id for share;
 if not found or v_pkg.status is distinct from 'released' or v_pkg.project_id is null then raise exception 'Released package unavailable in organization' using errcode='42501';end if;
 v_job.org_id:=p_org_id;v_job.job_type:='start_release';v_job.payload:=jsonb_build_object('actor_id',p_actor_id);
 perform public.assert_starts_release_actor(v_job,v_pkg);
 if p_after is not null and not exists(select 1 from public.notification_delivery_receipts where org_id=p_org_id
   and source_entity_type='start_package' and source_entity_id=p_package_id::text and source_project_id=v_pkg.project_id::text and id=p_after) then
   raise exception 'Delivery cursor belongs to a different package' using errcode='42501';end if;
 with candidates as (
  select r.* from public.notification_delivery_receipts r where r.org_id=p_org_id and r.source_entity_type='start_package'
   and r.source_entity_id=p_package_id::text and r.source_project_id=v_pkg.project_id::text
   and (p_after is null or r.id>p_after) and (not p_failed_only or r.status='failed') order by r.id limit p_limit+1
 ), page as (select * from candidates order by id limit p_limit), items as (
  select r.id,jsonb_build_object('receipt_id',r.id,'recipient_name',coalesce(nullif(u.full_name,''),'Unavailable recipient'),
   'channel',r.job_type,'status',r.status,'job_id',r.outbox_job_id::text,'retry_count',o.retry_count,'error',o.last_error,
   'completed_at',r.completed_at,'source_available',exists(select 1 from public.notifications n where n.org_id=r.org_id and n.id=r.notification_id
     and n.user_id=r.notification_user_id and n.notification_type=r.notification_type and encode(sha256(convert_to(n.payload::text,'UTF8')),'hex')=r.payload_hash)) item
  from page r left join public.outbox o on o.org_id=r.org_id and o.id=r.outbox_job_id left join public.app_users u on u.id=r.notification_user_id
 ) select coalesce(jsonb_agg(item order by id),'[]'),(select id from page order by id desc limit 1),(select count(*)>p_limit from candidates)
   into v_rows,v_next,v_more from items;
 return jsonb_build_object('items',v_rows,'next_cursor',case when v_more then v_next else null end,'has_more',v_more);
end $$;
revoke all on function public.list_start_notification_deliveries(uuid,uuid,uuid,uuid,boolean,integer) from public,anon,authenticated;
grant execute on function public.list_start_notification_deliveries(uuid,uuid,uuid,uuid,boolean,integer) to service_role;
