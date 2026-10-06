-- STAGED, UNAPPLIED. Reauthorize receipted jobs immediately before provider send.
-- A database check cannot hold authorization atomic across the external network.
create function public.authorize_start_notification_delivery(p_org_id uuid,p_job_id bigint,p_receipt_id uuid)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_receipt public.notification_delivery_receipts%rowtype;v_note public.notifications%rowtype;v_job public.outbox%rowtype;v_pkg public.start_packages%rowtype;
begin
 if current_user in ('anon','authenticated') then raise exception 'Delivery authorization requires service role' using errcode='42501';end if;
 if p_org_id is null or p_job_id is null or p_job_id<=0 or p_receipt_id is null then raise exception 'Invalid delivery authorization request';end if;
 select * into v_receipt from public.notification_delivery_receipts where org_id=p_org_id and id=p_receipt_id;
 if not found or v_receipt.source_entity_type is distinct from 'start_package' or v_receipt.source_entity_id is null then raise exception 'Verified starts delivery scope unavailable' using errcode='42501';end if;
 -- Match recovery's package -> notification -> job -> receipt order. Source
 -- identities are immutable; the final locked receipt must still own this job.
 select * into v_pkg from public.start_packages where org_id=p_org_id and id=v_receipt.source_entity_id::uuid for share;
 if not found or v_pkg.status is distinct from 'released' or v_pkg.project_id::text is distinct from v_receipt.source_project_id then raise exception 'Released home delivery scope changed' using errcode='42501';end if;
 select * into v_note from public.notifications where org_id=p_org_id and id=v_receipt.notification_id for share;
 if not found then raise exception 'Original notification unavailable' using errcode='42501';end if;
 select * into v_job from public.outbox where org_id=p_org_id and id=p_job_id for update;
 if not found or v_job.status is distinct from 'processing' or v_job.job_type is distinct from v_receipt.job_type
   or v_job.payload->>'notificationId' is distinct from v_note.id::text or v_job.payload->>'deliveryReceiptId' is distinct from p_receipt_id::text then raise exception 'Delivery job is no longer owned by receipt' using errcode='40001';end if;
 select * into v_receipt from public.notification_delivery_receipts where org_id=p_org_id and id=p_receipt_id for share;
 if v_receipt.outbox_job_id is distinct from p_job_id or v_receipt.status is distinct from 'processing'
   or v_note.user_id is distinct from v_receipt.notification_user_id or v_note.notification_type is distinct from 'start_released'
   or v_note.notification_type is distinct from v_receipt.notification_type or v_note.payload->>'entity_type' is distinct from 'start_package'
   or v_note.payload->>'entity_id' is distinct from v_pkg.id::text or v_note.payload->>'project_id' is distinct from v_pkg.project_id::text
   or encode(sha256(convert_to(v_note.payload::text,'UTF8')),'hex') is distinct from v_receipt.payload_hash then raise exception 'Notification differs from authorized delivery evidence' using errcode='42501';end if;
 perform public.assert_start_notification_recipient(v_note,v_pkg);
 return jsonb_build_object('id',v_note.id,'org_id',v_note.org_id,'user_id',v_note.user_id,'notification_type',v_note.notification_type,'payload',v_note.payload,'created_at',v_note.created_at);
end $$;
revoke all on function public.authorize_start_notification_delivery(uuid,bigint,uuid) from public,anon,authenticated;
grant execute on function public.authorize_start_notification_delivery(uuid,bigint,uuid) to service_role;
