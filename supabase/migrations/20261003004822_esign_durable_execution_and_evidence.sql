-- Signing acceptance and the durable work it creates commit together.
-- Apply only through the separately approved production migration rollout.
alter table public.document_signing_requests add column if not exists delivery_enqueued_at timestamptz;
create table public.esign_executions (
  envelope_id uuid primary key,
  org_id uuid not null references public.orgs(id),
  document_id uuid not null references public.documents(id),
  revision integer not null,
  file_id uuid not null default gen_random_uuid(),
  version_id uuid not null default gen_random_uuid(),
  status text not null default 'pending' check(status in ('pending','processing','completed')),
  lease_token uuid,
  lease_until timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index esign_executions_org_document_idx on public.esign_executions(org_id,document_id);
alter table public.esign_executions enable row level security;
revoke all on public.esign_executions from anon,authenticated;
grant all on public.esign_executions to service_role;

-- Keep the existing read policy, but remove every client mutation privilege.
revoke insert,update,delete,truncate,references,trigger on public.document_signatures from anon,authenticated;
revoke all on public.document_signatures from anon;
create function public.esign_evidence_immutable() returns trigger language plpgsql set search_path=public as $$
begin raise exception 'Signature evidence is append-only'; end $$;
create trigger esign_signature_immutable before update or delete on public.document_signatures
for each row execute function public.esign_evidence_immutable();

-- Restrictive policies compose with existing broad activity policies. Signing
-- events remain readable, but only a service writer can add them; nobody edits them.
create policy esign_events_client_insert_guard on public.events as restrictive for insert to authenticated
with check (entity_type is distinct from 'envelope' and coalesce(event_type,'') not in ('recipient_signed','envelope_executed','recipient_declined'));
create policy esign_events_client_update_guard on public.events as restrictive for update to authenticated
using (entity_type is distinct from 'envelope' and coalesce(event_type,'') not in ('recipient_signed','envelope_executed','recipient_declined'))
with check (entity_type is distinct from 'envelope' and coalesce(event_type,'') not in ('recipient_signed','envelope_executed','recipient_declined'));
create policy esign_events_client_delete_guard on public.events as restrictive for delete to authenticated
using (entity_type is distinct from 'envelope' and coalesce(event_type,'') not in ('recipient_signed','envelope_executed','recipient_declined'));
create function public.guard_esign_field_revision() returns trigger language plpgsql set search_path=public as $$
declare d public.documents; doc_id uuid; begin
 doc_id := case when tg_op='DELETE' then old.document_id else new.document_id end;
 select * into d from public.documents where id=doc_id for update;
 if d.status <> 'draft' or exists(select 1 from public.document_signing_requests r where r.document_id=doc_id and r.status <> 'draft') then
   raise exception 'Sent signing fields are immutable; create a new document revision';
 end if;
 if tg_op <> 'DELETE' and (new.org_id<>d.org_id or new.x+new.w>1.000001 or new.y+new.h>1.000001) then raise exception 'Invalid document field'; end if;
 if tg_op='UPDATE' and (new.document_id<>old.document_id or new.org_id<>old.org_id) then raise exception 'Cannot move a signing field'; end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger esign_fields_frozen before insert or update or delete on public.document_fields for each row execute function public.guard_esign_field_revision();
create function public.guard_esign_document_source() returns trigger language plpgsql set search_path=public as $$
begin
 if old.status <> 'draft' and (new.source_file_id is distinct from old.source_file_id or new.current_revision<>old.current_revision
 or (old.metadata ? 'esign_source' and new.metadata->'esign_source' is distinct from old.metadata->'esign_source')) then
 raise exception 'Sent source documents are immutable'; end if;
 return new;
end $$;
create trigger esign_source_frozen before update on public.documents for each row execute function public.guard_esign_document_source();

create function public.replace_draft_signing_fields(p_org_id uuid,p_document_id uuid,p_revision integer,p_fields jsonb)
returns setof public.document_fields language plpgsql security invoker set search_path=public as $$
declare d public.documents; begin
 select * into d from public.documents where id=p_document_id and org_id=p_org_id for update;
 if not found or d.status<>'draft' then raise exception 'Only draft signing fields may be edited'; end if;
 if jsonb_typeof(p_fields)<>'array' or jsonb_array_length(p_fields)>1000 then raise exception 'Invalid signing fields'; end if;
 delete from public.document_fields where document_id=p_document_id and org_id=p_org_id and revision=p_revision;
 return query insert into public.document_fields(org_id,document_id,revision,page_index,field_type,label,required,signer_role,x,y,w,h,sort_order,metadata)
 select p_org_id,p_document_id,p_revision,f.page_index,f.field_type,f.label,coalesce(f.required,true),coalesce(f.signer_role,'client'),f.x,f.y,f.w,f.h,coalesce(f.sort_order,0),coalesce(f.metadata,'{}'::jsonb)
 from jsonb_to_recordset(p_fields) as f(page_index integer,field_type text,label text,required boolean,signer_role text,x numeric,y numeric,w numeric,h numeric,sort_order integer,metadata jsonb)
 returning *;
end $$;
revoke all on function public.replace_draft_signing_fields(uuid,uuid,integer,jsonb) from public,anon;
grant execute on function public.replace_draft_signing_fields(uuid,uuid,integer,jsonb) to authenticated,service_role;

create function public.queue_esign_recipients(p_org_id uuid,p_envelope_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare next_sequence integer; r record; begin
 select min(sequence) into next_sequence from public.document_signing_requests
 where org_id=p_org_id and coalesce(envelope_id,group_id,id)=p_envelope_id and required and status not in ('signed','voided','expired');
 for r in select * from public.document_signing_requests where org_id=p_org_id and coalesce(envelope_id,group_id,id)=p_envelope_id
 and sequence=next_sequence and status in ('draft','sent','viewed') and delivery_enqueued_at is null for update loop
   insert into public.outbox(org_id,job_type,payload,dedupe_key) values(p_org_id,'send_esign_invitation',jsonb_build_object('signing_request_id',r.id),'esign-invite:'||r.id)
   on conflict(org_id,dedupe_key) where status='pending' and dedupe_key is not null do nothing;
   update public.document_signing_requests set delivery_enqueued_at=now(),status=case when status='draft' then 'sent' else status end,sent_at=coalesce(sent_at,now()) where id=r.id;
 end loop;
end $$;
revoke all on function public.queue_esign_recipients(uuid,uuid) from public,anon,authenticated;
grant execute on function public.queue_esign_recipients(uuid,uuid) to service_role;

create function public.start_esign_envelope(p_org_id uuid,p_envelope_id uuid,p_source jsonb,p_metadata jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare e public.envelopes; begin
 select * into e from public.envelopes where id=p_envelope_id and org_id=p_org_id for update;
 if not found then raise exception 'Envelope not found'; end if;
 perform 1 from public.documents where id=e.document_id and org_id=p_org_id for update;
 if e.status<>'draft' then raise exception 'Only a draft envelope may be sent'; end if;
 if not exists(select 1 from public.document_signing_requests where envelope_id=e.id and required) then raise exception 'At least one required signer is required'; end if;
 if not (p_source ? 'sha256' and p_source ? 'storage_path') then raise exception 'Frozen source required'; end if;
 update public.documents set status='sent',metadata=metadata||p_metadata||jsonb_build_object('esign_source',p_source),updated_at=now() where id=e.document_id;
 update public.envelopes set status='sent',sent_at=now(),updated_at=now() where id=e.id;
 perform public.queue_esign_recipients(p_org_id,e.id);
end $$;
revoke all on function public.start_esign_envelope(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.start_esign_envelope(uuid,uuid,jsonb,jsonb) to service_role;

create or replace function public.record_document_signature_atomic(
 p_org_id uuid,p_signing_request_id uuid,p_document_id uuid,p_revision integer,p_signer_name text,p_signer_email text,
 p_signer_ip text,p_user_agent text,p_consent_text text,p_values jsonb,p_audit_data jsonb,p_signed_at timestamptz)
returns uuid language plpgsql security definer set search_path=public as $$
declare r public.document_signing_requests; d public.documents; e public.envelopes; signature_id uuid; envelope_key uuid; native_estimate boolean; begin
 -- Envelope lock first, shared with cancellation and finalization.
 select * into r from public.document_signing_requests where id=p_signing_request_id and org_id=p_org_id;
 if not found then raise exception 'Signing request not found'; end if;
 envelope_key:=coalesce(r.envelope_id,r.group_id,r.id);
 select * into e from public.envelopes where id=envelope_key and org_id=p_org_id for update;
 select * into d from public.documents where id=r.document_id and org_id=p_org_id for update;
 select * into r from public.document_signing_requests where id=p_signing_request_id for update;
 if r.document_id<>p_document_id or r.revision<>p_revision then raise exception 'Signature document mismatch'; end if;
 if d.status in ('voided','expired') or e.status in ('voided','expired') then raise exception 'Envelope is no longer active'; end if;
 if r.status='signed' then
   select id into signature_id from public.document_signatures where signing_request_id=r.id order by created_at limit 1;
   return signature_id;
 end if;
 if d.status='signed' or e.status='executed' then raise exception 'This document is already completed; no further signatures can be accepted'; end if;
 if exists(select 1 from public.esign_executions where envelope_id=envelope_key and status='processing' and lease_until>now()) then
   raise exception 'This document is being finalized; no further signatures can be accepted';
 end if;
 if r.status in ('voided','expired') or r.used_count>=r.max_uses or r.expires_at<=now() or e.expires_at<=now() then raise exception 'Signing request is no longer active'; end if;
 if exists(select 1 from public.document_signing_requests where org_id=p_org_id and coalesce(envelope_id,group_id,id)=envelope_key and required and sequence<r.sequence and status<>'signed') then raise exception 'This signer is not yet authorized to sign'; end if;
 if length(btrim(p_signer_name))=0 or length(btrim(p_signer_email))=0 or length(btrim(p_consent_text))=0 then raise exception 'Signer identity and consent are required'; end if;
 if jsonb_typeof(p_values)<>'object' or octet_length(p_values::text)>4000000 then raise exception 'Invalid signature values'; end if;
 native_estimate := p_audit_data->>'source'='estimate_native_builder_signing' and d.source_entity_type='estimate';
 if not coalesce(native_estimate,false) and exists(select 1 from jsonb_object_keys(p_values) key where not exists(
 select 1 from public.document_fields f where f.id::text=key and f.org_id=p_org_id and f.document_id=r.document_id and f.revision=r.revision and f.signer_role=r.signer_role)) then raise exception 'Values include unassigned fields'; end if;
 if not coalesce(native_estimate,false) and exists(select 1 from public.document_fields f where f.document_id=r.document_id and f.revision=r.revision and f.signer_role=r.signer_role and f.required and
 (not(p_values ? f.id::text) or (f.field_type='checkbox' and p_values->f.id::text<>'true'::jsonb) or (f.field_type<>'checkbox' and coalesce(length(btrim(p_values->>f.id::text)),0)=0))) then raise exception 'Complete required fields'; end if;
 insert into public.document_signatures(org_id,signing_request_id,document_id,revision,signer_name,signer_email,signer_ip,user_agent,consent_text,values,audit_data,created_at)
 values(p_org_id,r.id,r.document_id,r.revision,btrim(p_signer_name),btrim(p_signer_email),nullif(p_signer_ip,'')::inet,p_user_agent,p_consent_text,p_values,
 coalesce(p_audit_data,'{}'::jsonb)||jsonb_build_object('source_sha256',d.metadata->'esign_source'->>'sha256'),now()) returning id into signature_id;
 update public.document_signing_requests set status='signed',signed_at=now(),used_count=used_count+1 where id=r.id;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'recipient_signed','envelope',envelope_key,
 jsonb_build_object('document_id',r.document_id,'signing_request_id',r.id,'signer_name',p_signer_name,'signed_at',now()),'activity');
 insert into public.esign_executions(envelope_id,org_id,document_id,revision) values(envelope_key,p_org_id,r.document_id,r.revision) on conflict do nothing;
 insert into public.outbox(org_id,job_type,payload,dedupe_key) values(p_org_id,'finalize_document_signing',
 jsonb_build_object('document_id',r.document_id,'signing_request_id',r.id,'envelope_id',envelope_key),'esign-finalize:'||r.id)
 on conflict(org_id,dedupe_key) where status='pending' and dedupe_key is not null do nothing;
 perform public.queue_esign_recipients(p_org_id,envelope_key);
 update public.envelopes set status='partially_signed',updated_at=now() where id=envelope_key and status='sent';
 return signature_id;
end $$;
revoke all on function public.record_document_signature_atomic(uuid,uuid,uuid,integer,text,text,text,text,text,jsonb,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.record_document_signature_atomic(uuid,uuid,uuid,integer,text,text,text,text,text,jsonb,jsonb,timestamptz) to service_role;

create function public.claim_esign_execution(p_org_id uuid,p_envelope_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare x public.esign_executions; e public.envelopes; begin
 select * into e from public.envelopes where id=p_envelope_id and org_id=p_org_id for update;
 if e.status in ('voided','expired') then return null; end if;
 if exists(select 1 from public.document_signing_requests where org_id=p_org_id and coalesce(envelope_id,group_id,id)=p_envelope_id and required and status<>'signed') then return null; end if;
 select * into x from public.esign_executions where envelope_id=p_envelope_id and org_id=p_org_id for update;
 if not found or x.status='completed' then return null; end if;
 if x.status='processing' and x.lease_until>now() then raise exception 'Execution already in progress'; end if;
 update public.esign_executions set status='processing',lease_token=p_lease_token,lease_until=now()+interval '5 minutes' where envelope_id=p_envelope_id returning * into x;
 return to_jsonb(x);
end $$;
revoke all on function public.claim_esign_execution(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_esign_execution(uuid,uuid,uuid) to service_role;

create function public.complete_esign_execution(p_org_id uuid,p_envelope_id uuid,p_lease_token uuid,p_artifact jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare x public.esign_executions; d public.documents; e public.envelopes; recipient record; begin
 select * into e from public.envelopes where id=p_envelope_id and org_id=p_org_id for update;
 select * into x from public.esign_executions where envelope_id=p_envelope_id and org_id=p_org_id for update;
 if x.status='completed' then return x.file_id; end if;
 if x.lease_token is distinct from p_lease_token or x.lease_until<=now() or e.status in ('voided','expired') then raise exception 'Execution claim no longer valid'; end if;
 select * into d from public.documents where id=x.document_id and org_id=p_org_id for update;
 insert into public.files(id,org_id,project_id,prospect_id,file_name,storage_path,mime_type,size_bytes,visibility,category,source,uploaded_by,metadata)
 values(x.file_id,p_org_id,d.project_id,d.prospect_id,p_artifact->>'file_name',p_artifact->>'storage_path','application/pdf',(p_artifact->>'size_bytes')::bigint,'private','contracts','generated',d.created_by,p_artifact->'metadata');
 insert into public.doc_versions(id,org_id,file_id,version_number,label,storage_path,file_name,mime_type,size_bytes,created_by)
 values(x.version_id,p_org_id,x.file_id,1,'Executed',p_artifact->>'storage_path',p_artifact->>'file_name','application/pdf',(p_artifact->>'size_bytes')::bigint,d.created_by);
 update public.files set current_version_id=x.version_id where id=x.file_id;
 update public.documents set status='signed',executed_file_id=x.file_id,updated_at=now() where id=d.id;
 update public.envelopes set status='executed',executed_at=now(),updated_at=now() where id=p_envelope_id;
 update public.esign_executions set status='completed',completed_at=now(),lease_until=null where envelope_id=p_envelope_id;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'envelope_executed','envelope',p_envelope_id,jsonb_build_object('document_id',d.id,'executed_file_id',x.file_id,'source_sha256',p_artifact->'metadata'->>'source_sha256','executed_sha256',p_artifact->'metadata'->>'executed_sha256'),'activity');
 insert into public.outbox(org_id,job_type,payload,dedupe_key) values(p_org_id,'process_esign_execution_side_effects',jsonb_build_object('document_id',d.id,'envelope_id',p_envelope_id,'executed_file_id',x.file_id)||coalesce(p_artifact->'signer','{}'::jsonb),'esign-effects:'||p_envelope_id);
 for recipient in select distinct lower(email::text) email,name from public.envelope_recipients where envelope_id=p_envelope_id and org_id=p_org_id and email is not null union select lower(d.metadata->'estimate_signature_data'->'client'->>'signer_email'),d.metadata->'estimate_signature_data'->'client'->>'signer_name' where d.metadata->'estimate_signature_data'->'client'->>'signer_email' is not null loop
 insert into public.outbox(org_id,job_type,payload,dedupe_key) values(p_org_id,'send_esign_executed_email',jsonb_build_object('document_id',d.id,'document_title',d.title,'executed_file_id',x.file_id,'recipient_name',recipient.name,'recipient_email',recipient.email),'esign-copy:'||x.file_id||':'||recipient.email)
 on conflict(org_id,dedupe_key) where status='pending' and dedupe_key is not null do nothing;
 end loop;
 return x.file_id;
end $$;
revoke all on function public.complete_esign_execution(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.complete_esign_execution(uuid,uuid,uuid,jsonb) to service_role;

alter table public.document_signing_requests add column if not exists access_code_hash text;
alter table public.document_signing_requests add column if not exists access_attempt_count integer not null default 0;
alter table public.document_signing_requests add column if not exists access_attempt_window timestamptz;
create function public.claim_esign_access_attempt(p_org_id uuid,p_request_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare r public.document_signing_requests; begin
 select * into r from public.document_signing_requests where org_id=p_org_id and id=p_request_id for update;
 if not found or r.status in ('voided','expired') or r.expires_at<=now() then raise exception 'Inactive request'; end if;
 if r.access_attempt_window>now()-interval '15 minutes' and r.access_attempt_count>=10 then raise exception 'Too many attempts'; end if;
 update public.document_signing_requests set access_attempt_count=case when r.access_attempt_window>now()-interval '15 minutes' then r.access_attempt_count+1 else 1 end,
 access_attempt_window=case when r.access_attempt_window>now()-interval '15 minutes' then r.access_attempt_window else now() end where id=r.id;
end $$;
revoke all on function public.claim_esign_access_attempt(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_esign_access_attempt(uuid,uuid) to service_role;

create function public.correct_esign_recipient(p_org_id uuid,p_envelope_id uuid,p_request_id uuid,p_name text,p_email text,p_token_hash text,p_actor_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare e public.envelopes; r public.document_signing_requests; begin
 select * into e from public.envelopes where id=p_envelope_id and org_id=p_org_id for update;
 if not found or e.status not in ('sent','partially_signed') then raise exception 'Only active envelopes may be corrected'; end if;
 select * into r from public.document_signing_requests where id=p_request_id and envelope_id=e.id and org_id=p_org_id for update;
 if not found or r.status not in ('draft','sent','viewed') then raise exception 'A signed recipient cannot be corrected'; end if;
 update public.document_signing_requests set sent_to_email=p_email,token_hash=p_token_hash,viewed_at=null,delivery_enqueued_at=null,status='draft',access_attempt_count=0,access_attempt_window=null where id=r.id;
 update public.envelope_recipients set name=p_name,email=p_email where id=r.envelope_recipient_id and org_id=p_org_id;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'recipient_corrected','envelope',e.id,
 jsonb_build_object('request_id',r.id,'previous_email',r.sent_to_email,'email',p_email,'actor_id',p_actor_id),'activity');
 perform public.queue_esign_recipients(p_org_id,e.id);
end $$;
revoke all on function public.correct_esign_recipient(uuid,uuid,uuid,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.correct_esign_recipient(uuid,uuid,uuid,text,text,text,uuid) to service_role;

create function public.guard_esign_activity_update() returns trigger language plpgsql set search_path=public as $$
begin
 if old.entity_type='envelope' or old.event_type in ('recipient_signed','envelope_executed','recipient_declined') then raise exception 'Signing activity is append-only'; end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger esign_activity_immutable before update or delete on public.events for each row execute function public.guard_esign_activity_update();

-- Cancellation uses the same envelope lock as acceptance and publication.
create function public.cancel_esign_envelope(p_org_id uuid,p_envelope_id uuid,p_reason text,p_request_id uuid default null,p_actor_id uuid default null)
returns void language plpgsql security definer set search_path=public as $$
declare e public.envelopes; begin
 select * into e from public.envelopes where id=p_envelope_id and org_id=p_org_id for update;
 if not found then raise exception 'Envelope not found'; end if;
 if e.status='executed' then raise exception 'Executed envelopes cannot be voided'; end if;
 if e.status='voided' then return; end if;
 if p_request_id is not null and not exists(select 1 from public.document_signing_requests where id=p_request_id and org_id=p_org_id and envelope_id=e.id and status in ('draft','sent','viewed') and (expires_at is null or expires_at>now())) then raise exception 'Request cannot decline this envelope'; end if;
 update public.envelopes set status='voided',voided_at=now(),updated_at=now(),metadata=metadata||jsonb_build_object('void_reason',p_reason,'declined_by_request_id',p_request_id,'voided_by_user_id',p_actor_id) where id=e.id;
 update public.documents set status='voided',updated_at=now() where id=e.document_id and org_id=p_org_id and status<>'signed';
 update public.document_signing_requests set status='voided' where envelope_id=e.id and org_id=p_org_id and status in ('draft','sent','viewed');
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,case when p_request_id is null then 'envelope_voided' else 'recipient_declined' end,'envelope',e.id,jsonb_build_object('reason',p_reason,'request_id',p_request_id,'actor_id',p_actor_id),'activity');
end $$;
revoke all on function public.cancel_esign_envelope(uuid,uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.cancel_esign_envelope(uuid,uuid,text,uuid,uuid) to service_role;

create function public.guard_executed_signing_file() returns trigger language plpgsql set search_path=public as $$
begin
 if old.metadata ? 'executed_sha256' then
   if tg_op='DELETE' then raise exception 'Executed signing evidence cannot be deleted'; end if;
   if new.storage_path is distinct from old.storage_path or new.metadata->'executed_sha256' is distinct from old.metadata->'executed_sha256'
      or new.metadata->'evidence_manifest' is distinct from old.metadata->'evidence_manifest' or new.metadata->'source_sha256' is distinct from old.metadata->'source_sha256' then
     raise exception 'Executed signing evidence is immutable'; end if;
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger esign_artifact_immutable before update or delete on public.files for each row execute function public.guard_executed_signing_file();

create function public.complete_esign_offline(p_org_id uuid,p_envelope_id uuid,p_actor_id uuid,p_artifact jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare e public.envelopes; x public.esign_executions; lease uuid:=gen_random_uuid(); file_id uuid; begin
 select * into e from public.envelopes where id=p_envelope_id and org_id=p_org_id for update;
 if not found or e.status in ('voided','expired') then raise exception 'Envelope cannot be completed offline'; end if;
 if e.status='executed' then select executed_file_id into file_id from public.documents where id=e.document_id; return file_id; end if;
 select * into x from public.esign_executions where envelope_id=e.id for update;
 if x.status='processing' and x.lease_until>now() then raise exception 'Electronic execution is already in progress'; end if;
 insert into public.esign_executions(envelope_id,org_id,document_id,revision,status,lease_token,lease_until)
 values(e.id,p_org_id,e.document_id,e.document_revision,'processing',lease,now()+interval '5 minutes')
 on conflict(envelope_id) do update set status='processing',lease_token=lease,lease_until=now()+interval '5 minutes';
 update public.document_signing_requests set status='signed',signed_at=coalesce(signed_at,now()) where envelope_id=e.id and org_id=p_org_id and status not in ('signed','voided','expired');
 file_id := public.complete_esign_execution(p_org_id,e.id,lease,p_artifact);
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'offline_executed','envelope',e.id,jsonb_build_object('executed_file_id',file_id,'actor_id',p_actor_id,'note',p_artifact->'metadata'->>'note'),'activity');
 return file_id;
end $$;
revoke all on function public.complete_esign_offline(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.complete_esign_offline(uuid,uuid,uuid,jsonb) to service_role;

-- Legacy links acquire a source snapshot before their first preview. Never
-- manufacture source evidence for signatures that predate that snapshot.
create function public.freeze_legacy_esign_source(p_org_id uuid,p_document_id uuid,p_source_file_id uuid,p_source jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare d public.documents; begin
 select * into d from public.documents where id=p_document_id and org_id=p_org_id for update;
 if not found then raise exception 'Signing document not found'; end if;
 if d.metadata ? 'esign_source' and d.metadata->'esign_source'<>'null'::jsonb then return d.metadata->'esign_source'; end if;
 if d.status not in ('draft','sent') or exists(select 1 from public.document_signatures where document_id=d.id and org_id=p_org_id) then
   raise exception 'This legacy document has signatures without a frozen source. Ask the sender to create a new revision; existing signed copies remain available';
 end if;
 if d.source_file_id is distinct from p_source_file_id then raise exception 'Signing source changed; reload before signing'; end if;
 if jsonb_typeof(p_source)<>'object' or not(p_source ? 'sha256' and p_source ? 'storage_path') then raise exception 'Frozen source required'; end if;
 update public.documents set metadata=metadata||jsonb_build_object('esign_source',p_source) where id=d.id;
 return p_source;
end $$;
revoke all on function public.freeze_legacy_esign_source(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.freeze_legacy_esign_source(uuid,uuid,uuid,jsonb) to service_role;

create function public.send_esign_document(p_org_id uuid,p_document_id uuid,p_actor_id uuid,p_source jsonb,p_recipients jsonb,p_metadata jsonb,p_subject text,p_message text,p_expires_at timestamptz)
returns uuid language plpgsql security definer set search_path=public as $$
declare d public.documents; e public.envelopes; recipient jsonb; recipient_id uuid; role_name text; begin
 -- One send operation owns recipient preparation and publication for a document.
 perform pg_advisory_xact_lock(hashtextextended('esign-send:'||p_document_id,0));
 select * into d from public.documents where id=p_document_id and org_id=p_org_id for update;
 if not found then raise exception 'Document not found'; end if;
 if d.status<>'draft' then
   select * into e from public.envelopes where document_id=d.id and org_id=p_org_id and status in ('sent','partially_signed','executed') order by created_at desc limit 1;
   if found then return e.id; end if;
   raise exception 'Only draft documents can be sent';
 end if;
 if d.source_file_id::text is distinct from p_source->>'file_id' then raise exception 'The source changed; review it before sending'; end if;
 if jsonb_typeof(p_recipients)<>'array' or jsonb_array_length(p_recipients)>100 or jsonb_array_length(p_recipients)=0 then raise exception 'Invalid recipients'; end if;
 if p_expires_at is not null and p_expires_at<=now() then raise exception 'Expiration must be in the future'; end if;
 if exists(select 1 from jsonb_array_elements(p_recipients) r where r->>'role'='signer' and coalesce((r->>'required')::boolean,true)=false and not exists(select 1 from jsonb_array_elements(p_recipients) stage where stage->>'role'='signer' and coalesce((stage->>'required')::boolean,true) and coalesce((stage->>'sequence')::integer,1)=coalesce((r->>'sequence')::integer,1))) then raise exception 'Optional signers must share a routing stage with a required signer'; end if;
 if exists(select 1 from jsonb_array_elements(p_recipients) r where r->>'role'='signer' group by r->>'signer_role' having count(*)>1) then raise exception 'Each signer needs a unique role'; end if;
 if exists(select 1 from public.document_fields f where f.document_id=d.id and f.revision=d.current_revision and f.required and not exists(select 1 from jsonb_array_elements(p_recipients) r where r->>'role'='signer' and r->>'signer_role'=f.signer_role)) then raise exception 'Every required field must be assigned to a recipient'; end if;
 select * into e from public.envelopes where document_id=d.id and org_id=p_org_id and status='draft' order by created_at desc limit 1 for update;
 if not found then
 insert into public.envelopes(org_id,project_id,document_id,document_revision,source_entity_type,source_entity_id,created_by)
 values(p_org_id,d.project_id,d.id,d.current_revision,d.source_entity_type,d.source_entity_id,p_actor_id) returning * into e;
 end if;
 if exists(select 1 from public.document_signing_requests where envelope_id=e.id and status<>'draft') then raise exception 'Signing has already started'; end if;
 delete from public.document_signing_requests where envelope_id=e.id;
 delete from public.envelope_recipients where envelope_id=e.id;
 for recipient in select value from jsonb_array_elements(p_recipients) loop
 if coalesce(recipient->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Valid recipient email is required'; end if;
 if recipient->>'contact_id' is not null and not exists(select 1 from public.contacts where id=(recipient->>'contact_id')::uuid and org_id=p_org_id) then raise exception 'Contact does not belong to this organization'; end if;
 if recipient->>'user_id' is not null and not exists(select 1 from public.memberships where user_id=(recipient->>'user_id')::uuid and org_id=p_org_id and status='active') then raise exception 'Recipient is not an active organization member'; end if;
 role_name:=recipient->>'signer_role';
 insert into public.envelope_recipients(org_id,envelope_id,recipient_type,name,email,role,signer_role,sequence,required,contact_id,user_id,metadata)
 values(p_org_id,e.id,coalesce(recipient->>'type','external_email'),recipient->>'name',recipient->>'email',recipient->>'role',role_name,coalesce((recipient->>'sequence')::integer,1),coalesce((recipient->>'required')::boolean,true),(recipient->>'contact_id')::uuid,(recipient->>'user_id')::uuid,'{}') returning id into recipient_id;
 if recipient->>'role'='signer' then
 insert into public.document_signing_requests(org_id,document_id,revision,token_hash,status,sent_to_email,expires_at,signer_role,sequence,required,group_id,envelope_id,envelope_recipient_id,created_by,access_code_hash)
 values(p_org_id,d.id,d.current_revision,gen_random_uuid()::text||gen_random_uuid()::text,'draft',recipient->>'email',p_expires_at,role_name,coalesce((recipient->>'sequence')::integer,1),coalesce((recipient->>'required')::boolean,true),e.id,e.id,recipient_id,p_actor_id,recipient->>'access_code_hash');
 end if;
 end loop;
 update public.envelopes set subject=p_subject,message=p_message,expires_at=p_expires_at,metadata=p_metadata where id=e.id;
 perform public.start_esign_envelope(p_org_id,e.id,p_source,jsonb_build_object('envelope_recipients',(select jsonb_agg(r-'access_code_hash') from jsonb_array_elements(p_recipients) r)));
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'envelope_sent','envelope',e.id,jsonb_build_object('document_id',d.id,'actor_id',p_actor_id),'activity');
 return e.id;
end $$;
revoke all on function public.send_esign_document(uuid,uuid,uuid,jsonb,jsonb,jsonb,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.send_esign_document(uuid,uuid,uuid,jsonb,jsonb,jsonb,text,text,timestamptz) to service_role;

-- Browser clients may author drafts, but cannot impersonate the trusted lifecycle
-- writers by issuing table mutations directly through PostgREST. SECURITY DEFINER
-- RPCs and service workers run as their database owner/service_role, not a JWT claim.
create function public.guard_esign_client_mutation() returns trigger language plpgsql set search_path=public as $$
declare doc_id uuid; envelope_key uuid; doc_status text; envelope_status text; begin
 if current_user not in ('anon','authenticated') then
   if tg_op='DELETE' then return old; end if; return new;
 end if;
 if tg_table_name='documents' then
   if tg_op='DELETE' then
     if old.status<>'draft' then raise exception 'Issued signing documents require a trusted lifecycle writer'; end if;
     return old;
   end if;
   if tg_op='INSERT' then
     if new.status<>'draft' or new.executed_file_id is not null or new.metadata ? 'esign_source' then raise exception 'Signing lifecycle evidence requires a trusted writer'; end if;
   else
     if old.status<>'draft' then raise exception 'Issued signing documents require a trusted lifecycle writer'; end if;
     if new.status is distinct from old.status or new.executed_file_id is distinct from old.executed_file_id
       or new.metadata->'esign_source' is distinct from old.metadata->'esign_source' then raise exception 'Signing lifecycle evidence requires a trusted writer'; end if;
     if old.status<>'draft' and (new.org_id is distinct from old.org_id or new.source_file_id is distinct from old.source_file_id
        or new.current_revision is distinct from old.current_revision) then raise exception 'Issued signing documents are immutable'; end if;
   end if;
 elsif tg_table_name='envelopes' then
   if tg_op<>'INSERT' then
     if old.status<>'draft' then raise exception 'Issued envelopes require a trusted lifecycle writer'; end if;
     select status into doc_status from public.documents where id=old.document_id for update;
     if doc_status is distinct from 'draft' then raise exception 'Issued envelopes require a trusted lifecycle writer'; end if;
   end if;
   if tg_op='DELETE' then return old; end if;
   if new.status<>'draft' or new.sent_at is not null or new.executed_at is not null or new.voided_at is not null then raise exception 'Envelope lifecycle requires a trusted writer'; end if;
   select status into doc_status from public.documents where id=new.document_id for update;
   if doc_status is distinct from 'draft' then raise exception 'Issued envelopes require a trusted lifecycle writer'; end if;
 elsif tg_table_name='document_signing_requests' then
   if tg_op<>'INSERT' then
     if old.status<>'draft' then raise exception 'Issued signing requests require a trusted lifecycle writer'; end if;
     select status into doc_status from public.documents where id=old.document_id for update;
     select status into envelope_status from public.envelopes where id=old.envelope_id for update;
     if doc_status is distinct from 'draft' or (envelope_status is not null and envelope_status<>'draft') then raise exception 'Issued signing requests require a trusted lifecycle writer'; end if;
   end if;
   doc_id:=case when tg_op='DELETE' then old.document_id else new.document_id end;
   envelope_key:=case when tg_op='DELETE' then old.envelope_id else new.envelope_id end;
   select status into doc_status from public.documents where id=doc_id for update;
   select status into envelope_status from public.envelopes where id=envelope_key for update;
   if doc_status is distinct from 'draft' or (envelope_status is not null and envelope_status<>'draft') then raise exception 'Issued signing requests require a trusted lifecycle writer'; end if;
   if tg_op='DELETE' then return old; end if;
   if new.status<>'draft' or new.used_count<>0 or new.signed_at is not null or new.sent_at is not null or new.viewed_at is not null or new.delivery_enqueued_at is not null then raise exception 'Signature state requires a trusted writer'; end if;
 elsif tg_table_name='envelope_recipients' then
   envelope_key:=case when tg_op='DELETE' then old.envelope_id else new.envelope_id end;
   select status into envelope_status from public.envelopes where id=envelope_key for update;
   if envelope_status is distinct from 'draft' then raise exception 'Issued recipients require a trusted lifecycle writer'; end if;
   if tg_op='UPDATE' and new.envelope_id is distinct from old.envelope_id then
     select status into envelope_status from public.envelopes where id=old.envelope_id for update;
     if envelope_status is distinct from 'draft' then raise exception 'Issued recipients require a trusted lifecycle writer'; end if;
   end if;
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger esign_documents_client_guard before insert or update or delete on public.documents for each row execute function public.guard_esign_client_mutation();
create trigger esign_envelopes_client_guard before insert or update or delete on public.envelopes for each row execute function public.guard_esign_client_mutation();
create trigger esign_requests_client_guard before insert or update or delete on public.document_signing_requests for each row execute function public.guard_esign_client_mutation();
create trigger esign_recipients_client_guard before insert or update or delete on public.envelope_recipients for each row execute function public.guard_esign_client_mutation();
