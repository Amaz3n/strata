create or replace function public.record_document_signature_atomic(
  p_org_id uuid,
  p_signing_request_id uuid,
  p_document_id uuid,
  p_revision integer,
  p_signer_name text,
  p_signer_email text,
  p_signer_ip text,
  p_user_agent text,
  p_consent_text text,
  p_values jsonb,
  p_audit_data jsonb,
  p_signed_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_signature_id uuid;
  v_claimed_request_id uuid;
begin
  update public.document_signing_requests
     set status = 'signed',
         signed_at = p_signed_at,
         used_count = used_count + 1
   where id = p_signing_request_id
     and org_id = p_org_id
     and status not in ('signed', 'voided', 'expired')
     and used_count < max_uses
   returning id into v_claimed_request_id;

  if v_claimed_request_id is null then
    raise exception 'Signing link has already been used or is no longer valid'
      using errcode = 'P0001';
  end if;

  insert into public.document_signatures (
    org_id,
    signing_request_id,
    document_id,
    revision,
    signer_name,
    signer_email,
    signer_ip,
    user_agent,
    consent_text,
    values,
    audit_data,
    created_at
  )
  values (
    p_org_id,
    p_signing_request_id,
    p_document_id,
    p_revision,
    nullif(btrim(p_signer_name), ''),
    nullif(btrim(p_signer_email), ''),
    nullif(btrim(p_signer_ip), '')::inet,
    p_user_agent,
    p_consent_text,
    coalesce(p_values, '{}'::jsonb),
    coalesce(p_audit_data, '{}'::jsonb),
    p_signed_at
  )
  returning id into v_signature_id;

  return v_signature_id;
end;
$$;

revoke execute on function public.record_document_signature_atomic(
  uuid,
  uuid,
  uuid,
  integer,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb,
  timestamptz
) from public, anon, authenticated;

grant execute on function public.record_document_signature_atomic(
  uuid,
  uuid,
  uuid,
  integer,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb,
  timestamptz
) to service_role;
