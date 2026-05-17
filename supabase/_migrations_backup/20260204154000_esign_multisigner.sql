-- Phase 4: multi-signer routing for e-sign documents

alter table document_signing_requests
  add column if not exists group_id uuid,
  add column if not exists signer_role text not null default 'client',
  add column if not exists sequence integer not null default 1,
  add column if not exists required boolean not null default true;

-- Backfill group_id for existing rows
update document_signing_requests
set group_id = id
where group_id is null;

create index if not exists document_signing_requests_group_idx
  on document_signing_requests (org_id, document_id, group_id, sequence);

create index if not exists document_signing_requests_group_status_idx
  on document_signing_requests (org_id, group_id, status, sequence);
