-- STAGED / UNAPPLIED. Protect the sources sealed by completion receipts.
-- This guards database evidence identity, not underlying storage object bytes.
create function public.guard_recorded_warranty_completion_evidence() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
declare sealed boolean:=false; old_doc jsonb; new_doc jsonb; fields text[]; old_proof jsonb; new_proof jsonb;
begin
 if tg_op<>'INSERT' then old_doc:=to_jsonb(old); end if;
 if tg_op<>'DELETE' then new_doc:=to_jsonb(new); end if;
 if tg_table_name='warranty_service_visits' then
  select exists(select 1 from public.warranty_visit_completion_receipts where visit_id=old.id) into sealed;
  fields:=array['id','org_id','project_id','request_id','visit_number','assignee_kind','assigned_user_id','assigned_company_id','window_start','window_end','confirmed_at','status','outcome','outcome_note','completed_at','completed_by','buyer_signoff_name','buyer_signoff_at','buyer_signature_file_id','labor_hours','labor_rate_cents','internal_labor_cents','internal_material_cents','created_at'];
 elsif tg_table_name='warranty_visit_photos' then
  if tg_op='INSERT' then
   if exists(select 1 from public.warranty_visit_completion_receipts where visit_id=new.visit_id) then raise exception 'Recorded warranty completion photo evidence is immutable'; end if;
   return new;
  end if;
  select exists(select 1 from public.warranty_visit_completion_receipts where visit_id=old.visit_id) into sealed;
  if tg_op='UPDATE' and not sealed and exists(select 1 from public.warranty_visit_completion_receipts where visit_id=new.visit_id) then raise exception 'Recorded warranty completion photo evidence is immutable'; end if;
  fields:=array['id','org_id','visit_id','file_id','created_by','created_at'];
 elsif tg_table_name='events' then
  select exists(select 1 from public.warranty_visit_completion_receipts where event_id=old.id) into sealed;
 elsif tg_table_name='audit_log' then
  select exists(select 1 from public.warranty_visit_completion_receipts where audit_id=old.id) into sealed;
 elsif tg_table_name='files' then
  select exists(select 1 from public.warranty_visit_photos p join public.warranty_visit_completion_receipts r on r.visit_id=p.visit_id where p.file_id=old.id)
    or exists(select 1 from public.warranty_service_visits v join public.warranty_visit_completion_receipts r on r.visit_id=v.id where v.buyer_signature_file_id=old.id) into sealed;
  fields:=array['id','org_id','project_id','storage_path','mime_type','size_bytes','checksum','uploaded_by','created_at','archived_at','source','current_version_id'];
 end if;
 if sealed then
  if tg_op='DELETE' then raise exception 'Recorded warranty completion evidence cannot be deleted'; end if;
  if fields is null then
   old_proof:=old_doc; new_proof:=new_doc;
  else
   select jsonb_object_agg(k,old_doc->k),jsonb_object_agg(k,new_doc->k) into old_proof,new_proof from unnest(fields) k;
  end if;
  if old_proof is distinct from new_proof then raise exception 'Recorded warranty completion evidence is immutable'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
revoke all on function public.guard_recorded_warranty_completion_evidence() from public,anon,authenticated,service_role;
create trigger warranty_completed_visit_evidence_guard before update or delete on public.warranty_service_visits for each row execute function public.guard_recorded_warranty_completion_evidence();
create trigger warranty_completed_photo_evidence_guard before insert or update or delete on public.warranty_visit_photos for each row execute function public.guard_recorded_warranty_completion_evidence();
create trigger warranty_completed_event_evidence_guard before update or delete on public.events for each row execute function public.guard_recorded_warranty_completion_evidence();
create trigger warranty_completed_audit_evidence_guard before update or delete on public.audit_log for each row execute function public.guard_recorded_warranty_completion_evidence();
create trigger warranty_completed_file_evidence_guard before update or delete on public.files for each row execute function public.guard_recorded_warranty_completion_evidence();
-- Existing photo(file_id) and receipt(visit_id/event_id/audit_id) indexes support
-- the other reference probes. Freeze signature file identity without a desk scan.
create index warranty_completed_signature_file_idx on public.warranty_service_visits(buyer_signature_file_id) where buyer_signature_file_id is not null;
