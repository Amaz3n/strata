-- Replacement invitations are a single transaction; accepted evidence belongs
-- permanently to the prior document, never to the replacement.
create function public.resend_esign_envelope(
  p_org_id uuid, p_envelope_id uuid, p_actor_id uuid, p_source jsonb default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  old_envelope public.envelopes;
  old_document public.documents;
  source_manifest jsonb;
  recipient_payload jsonb;
  new_document_id uuid;
  replacement_id uuid;
  expiry_days integer;
begin
  select * into old_envelope from public.envelopes
    where id=p_envelope_id and org_id=p_org_id for update;
  if not found then raise exception 'Envelope not found'; end if;
  if old_envelope.status='executed' then raise exception 'Executed envelopes cannot be resent'; end if;
  replacement_id := nullif(old_envelope.metadata->>'replacement_envelope_id','')::uuid;
  if replacement_id is not null then
    if not exists(select 1 from public.envelopes where id=replacement_id and org_id=p_org_id) then
      raise exception 'Replacement envelope is unavailable';
    end if;
    return replacement_id;
  end if;
  select * into old_document from public.documents
    where id=old_envelope.document_id and org_id=p_org_id for update;
  if not found then raise exception 'Document not found'; end if;
  if old_document.status='signed' or old_document.executed_file_id is not null then
    raise exception 'Executed documents cannot be resent';
  end if;
  source_manifest := nullif(old_document.metadata->'esign_source','null'::jsonb);
  if source_manifest is null then
    if old_envelope.status<>'draft' or old_document.status<>'draft'
      or exists(select 1 from public.document_signatures where org_id=p_org_id and document_id=old_document.id) then
      raise exception 'This legacy envelope has no frozen source; prepare a new document revision';
    end if;
    source_manifest := p_source;
  end if;
  if source_manifest is null or jsonb_typeof(source_manifest)<>'object'
    or coalesce(source_manifest->>'sha256','') !~ '^[a-f0-9]{64}$'
    or coalesce(source_manifest->>'storage_path','')=''
    or source_manifest->>'file_id' is distinct from old_document.source_file_id::text then
    raise exception 'A valid frozen signing source is required';
  end if;
  select jsonb_agg(jsonb_build_object(
    'type',r.recipient_type,'contact_id',r.contact_id,'user_id',r.user_id,
    'name',r.name,'email',r.email,'role',r.role,'signer_role',r.signer_role,
    'sequence',r.sequence,'required',r.required,
    'access_code_hash',(select q.access_code_hash from public.document_signing_requests q
      where q.org_id=p_org_id and q.envelope_id=old_envelope.id
      and (q.envelope_recipient_id=r.id or (q.envelope_recipient_id is null and q.signer_role=r.signer_role))
      order by q.created_at desc limit 1)
  ) order by r.sequence,r.id) into recipient_payload
    from public.envelope_recipients r where r.org_id=p_org_id and r.envelope_id=old_envelope.id;
  if recipient_payload is null or not exists(select 1 from jsonb_array_elements(recipient_payload) r where r->>'role'='signer') then
    raise exception 'Envelope has no signer recipients to resend';
  end if;
  expiry_days := case when old_envelope.expires_at is null then 14 else
    greatest(1,least(180,ceil(extract(epoch from (old_envelope.expires_at-coalesce(old_envelope.sent_at,old_envelope.created_at)))/86400)::integer)) end;
  perform public.cancel_esign_envelope(p_org_id,old_envelope.id,'Superseded by new signature copy',null,p_actor_id);
  insert into public.documents(org_id,project_id,prospect_id,document_type,title,status,source_file_id,
    current_revision,source_entity_type,source_entity_id,metadata,created_by)
  values(p_org_id,old_document.project_id,old_document.prospect_id,old_document.document_type,old_document.title,
    'draft',old_document.source_file_id,1,old_document.source_entity_type,old_document.source_entity_id,
    (old_document.metadata - 'envelope_recipients' - 'execution' - 'executed_file_id' - 'replacement_envelope_id') ||
      jsonb_build_object('esign_source',source_manifest,'resend_of_document_id',old_document.id,'resend_of_envelope_id',old_envelope.id),p_actor_id)
  returning id into new_document_id;
  insert into public.document_fields(org_id,document_id,revision,page_index,field_type,label,required,signer_role,x,y,w,h,sort_order,metadata)
  select p_org_id,new_document_id,1,page_index,field_type,label,required,signer_role,x,y,w,h,sort_order,metadata
    from public.document_fields where org_id=p_org_id and document_id=old_document.id and revision=old_envelope.document_revision;
  replacement_id := public.send_esign_document(p_org_id,new_document_id,p_actor_id,source_manifest,recipient_payload,
    (old_envelope.metadata - 'replacement_envelope_id' - 'void_reason' - 'declined_by_request_id' - 'voided_by_user_id') ||
      jsonb_build_object('resend_of_envelope_id',old_envelope.id,'resend_requested_at',now(),'resend_requested_by',p_actor_id),
    old_envelope.subject,old_envelope.message,now()+make_interval(days=>expiry_days));
  update public.envelope_recipients n set metadata=o.metadata
    from public.envelope_recipients o where n.org_id=p_org_id and n.envelope_id=replacement_id
    and o.org_id=p_org_id and o.envelope_id=old_envelope.id and n.role=o.role
    and n.signer_role is not distinct from o.signer_role and n.email is not distinct from o.email;
  update public.envelopes set metadata=metadata||jsonb_build_object('replacement_envelope_id',replacement_id),updated_at=now()
    where id=old_envelope.id and org_id=p_org_id;
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
    values(p_org_id,'envelope_replaced','envelope',old_envelope.id,
      jsonb_build_object('replacement_envelope_id',replacement_id,'replacement_document_id',new_document_id,'actor_id',p_actor_id),'activity');
  return replacement_id;
end $$;
revoke all on function public.resend_esign_envelope(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.resend_esign_envelope(uuid,uuid,uuid,jsonb) to service_role;
