-- STAGED / UNAPPLIED. Requires the durable e-sign lifecycle migration.
-- Preserve agreement-bound contact identity and reject changed replays before adopting this RPC for purchase agreements.
create or replace function public.send_esign_document(p_org_id uuid,p_document_id uuid,p_actor_id uuid,p_source jsonb,p_recipients jsonb,p_metadata jsonb,p_subject text,p_message text,p_expires_at timestamptz)
returns uuid language plpgsql security definer set search_path='' as $$
declare d public.documents; e public.envelopes; recipient jsonb; recipient_id uuid; role_name text; expected_recipients jsonb; actual_recipients jsonb; begin
 -- Owned agreement packets may publish only after their parent transaction
 -- has locked and verified sale ownership and actor/home/source evidence.
 if exists(select 1 from public.documents where id=p_document_id and org_id=p_org_id and metadata ? 'agreement_signing_input')
   and current_setting('arc.agreement_signing_publication',true) is distinct from p_document_id::text then
   raise exception 'Use purchase agreement signing recovery to publish this owned packet';
 end if;
 -- One send operation owns recipient preparation and publication for a document.
 perform pg_advisory_xact_lock(hashtextextended('esign-send:'||p_document_id,0));
 select * into d from public.documents where id=p_document_id and org_id=p_org_id for update;
 if not found then raise exception 'Document not found'; end if;
 if d.metadata ? 'agreement_signing_input' and current_setting('arc.agreement_signing_publication',true) is distinct from d.id::text then raise exception 'Agreement signing ownership changed; use signing recovery'; end if;
 if jsonb_typeof(p_source) is distinct from 'object' or coalesce(p_source->>'sha256','') !~ '^[0-9a-f]{64}$'
   or coalesce(length(btrim(p_source->>'storage_path')),0)=0 or jsonb_typeof(p_source->'size_bytes') is distinct from 'number'
   or (p_source->>'size_bytes')::numeric<=0 or (p_source->>'size_bytes')::numeric<>trunc((p_source->>'size_bytes')::numeric)
   or d.source_file_id::text is distinct from p_source->>'file_id' then raise exception 'Valid frozen signing source required'; end if;
 if jsonb_typeof(p_recipients) is distinct from 'array' or jsonb_array_length(p_recipients)>100 or jsonb_array_length(p_recipients)=0 then raise exception 'Invalid recipients'; end if;
 if exists(select 1 from jsonb_array_elements(p_recipients) r where jsonb_typeof(r) is distinct from 'object'
   or coalesce(r->>'type','external_email') not in ('contact','internal_user','external_email')
   or coalesce(r->>'role','') not in ('signer','cc')
   or coalesce(r->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
   or (r->>'role'='signer' and coalesce(length(btrim(r->>'signer_role')),0)=0)
   or coalesce((r->>'sequence')::integer,1)<1
   or (coalesce(r->>'type','external_email')='contact' and r->>'contact_id' is null)
   or (coalesce(r->>'type','external_email')='internal_user' and r->>'user_id' is null)
   or (coalesce(r->>'type','external_email')<>'contact' and r->>'contact_id' is not null)
   or (coalesce(r->>'type','external_email')<>'internal_user' and r->>'user_id' is not null)) then raise exception 'Invalid signing recipient identity'; end if;
 select jsonb_agg(identity order by identity::text) into expected_recipients from (
   select jsonb_build_object('type',coalesce(r->>'type','external_email'),'name',r->>'name','email',r->>'email','role',r->>'role',
     'signer_role',r->>'signer_role','sequence',coalesce((r->>'sequence')::integer,1),'required',coalesce((r->>'required')::boolean,true),
     'contact_id',r->>'contact_id','user_id',r->>'user_id','access_code_hash',case when r->>'role'='signer' then r->>'access_code_hash' else null end) identity
   from jsonb_array_elements(p_recipients) r
 ) normalized;
 if d.status<>'draft' then
   select * into e from public.envelopes where document_id=d.id and org_id=p_org_id and status in ('sent','partially_signed','executed') order by created_at desc limit 1;
   if found then
     select jsonb_agg(identity order by identity::text) into actual_recipients from (
       select jsonb_build_object('type',r.recipient_type,'name',r.name,'email',r.email::text,'role',r.role,
         'signer_role',r.signer_role,'sequence',r.sequence,'required',r.required,'contact_id',r.contact_id::text,'user_id',r.user_id::text,
         'access_code_hash',q.access_code_hash) identity
       from public.envelope_recipients r left join public.document_signing_requests q
         on q.envelope_recipient_id=r.id and q.envelope_id=e.id and q.org_id=p_org_id
       where r.org_id=p_org_id and r.envelope_id=e.id
     ) normalized;
     if actual_recipients is distinct from expected_recipients or e.document_revision<>d.current_revision
       or d.metadata->'esign_source'->>'sha256' is distinct from p_source->>'sha256'
       or d.metadata->'esign_source'->>'file_id' is distinct from p_source->>'file_id'
       or d.metadata->'esign_source'->>'size_bytes' is distinct from p_source->>'size_bytes'
       or e.subject is distinct from p_subject or e.message is distinct from p_message or e.expires_at is distinct from p_expires_at
       or e.metadata is distinct from p_metadata
       or (select count(*) from public.document_signing_requests where envelope_id=e.id) <>
          (select count(*) from public.envelope_recipients where envelope_id=e.id and org_id=p_org_id and role='signer')
       or exists(select 1 from public.envelope_recipients r where r.envelope_id=e.id and r.org_id=p_org_id and r.role='signer'
          and (select count(*) from public.document_signing_requests q where q.envelope_id=e.id and q.org_id=p_org_id and q.envelope_recipient_id=r.id)<>1)
       or exists(select 1 from public.document_signing_requests q left join public.envelope_recipients r on r.id=q.envelope_recipient_id
         where q.envelope_id=e.id and (r.id is null or r.role<>'signer' or q.group_id is distinct from e.id or coalesce(length(q.token_hash),0)=0 or q.org_id is distinct from p_org_id or q.document_id is distinct from d.id or q.revision<>d.current_revision
           or q.recipient_contact_id is distinct from r.contact_id or q.sent_to_email is distinct from r.email
           or q.signer_role is distinct from r.signer_role or q.sequence is distinct from r.sequence or q.required is distinct from r.required)) then
       raise exception 'Signing send retry differs from the published packet; reconcile the existing envelope';
     end if;
     return e.id;
   end if;
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
 insert into public.document_signing_requests(org_id,document_id,revision,token_hash,status,sent_to_email,expires_at,signer_role,sequence,required,group_id,envelope_id,envelope_recipient_id,created_by,access_code_hash,recipient_contact_id)
 values(p_org_id,d.id,d.current_revision,gen_random_uuid()::text||gen_random_uuid()::text,'draft',recipient->>'email',p_expires_at,role_name,coalesce((recipient->>'sequence')::integer,1),coalesce((recipient->>'required')::boolean,true),e.id,e.id,recipient_id,p_actor_id,recipient->>'access_code_hash',(recipient->>'contact_id')::uuid);
 end if;
 end loop;
 update public.envelopes set subject=p_subject,message=p_message,expires_at=p_expires_at,metadata=p_metadata where id=e.id;
 perform public.start_esign_envelope(p_org_id,e.id,p_source,jsonb_build_object('envelope_recipients',(select jsonb_agg(r-'access_code_hash') from jsonb_array_elements(p_recipients) r)));
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'envelope_sent','envelope',e.id,jsonb_build_object('document_id',d.id,'actor_id',p_actor_id),'activity');
 return e.id;
end $$;
revoke all on function public.send_esign_document(uuid,uuid,uuid,jsonb,jsonb,jsonb,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.send_esign_document(uuid,uuid,uuid,jsonb,jsonb,jsonb,text,text,timestamptz) to service_role;
