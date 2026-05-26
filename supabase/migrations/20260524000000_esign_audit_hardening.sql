alter table public.document_signatures
  add column if not exists audit_data jsonb not null default '{}'::jsonb;

comment on column public.document_signatures.audit_data is
  'Signer audit evidence captured at signature time, including consent version, signer attribution context, request identifiers, and device/network metadata.';
