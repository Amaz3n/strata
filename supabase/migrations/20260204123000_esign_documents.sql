-- E-sign documents foundation (BYO docs + field placement)

-- Documents
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  document_type text not null check (document_type in ('proposal','contract','change_order','other')),
  title text not null,
  status text not null default 'draft' check (status in ('draft','sent','signed','voided','expired')),
  source_file_id uuid not null references files(id) on delete restrict,
  executed_file_id uuid references files(id) on delete set null,
  current_revision integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists documents_org_project_created_idx on documents (org_id, project_id, created_at desc);
create index if not exists documents_org_status_created_idx on documents (org_id, status, created_at desc);
create index if not exists documents_project_id_idx on documents (project_id);
create index if not exists documents_source_file_id_idx on documents (source_file_id);
create index if not exists documents_executed_file_id_idx on documents (executed_file_id) where executed_file_id is not null;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'documents_set_updated_at') then
    create trigger documents_set_updated_at
      before update on documents
      for each row
      execute function public.tg_set_updated_at();
  end if;
end$$;

-- Document fields (field placement per revision)
create table if not exists document_fields (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  revision integer not null default 1,
  page_index integer not null check (page_index >= 0),
  field_type text not null check (field_type in ('signature','initials','text','date','checkbox','name')),
  label text,
  required boolean not null default true,
  signer_role text not null default 'client',
  x numeric not null check (x >= 0 and x <= 1),
  y numeric not null check (y >= 0 and y <= 1),
  w numeric not null check (w > 0 and w <= 1),
  h numeric not null check (h > 0 and h <= 1),
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists document_fields_doc_rev_idx on document_fields (org_id, document_id, revision);
create index if not exists document_fields_document_id_idx on document_fields (document_id);

-- Signing requests (tokenized public links)
create table if not exists document_signing_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  revision integer not null,
  token_hash text not null,
  status text not null default 'draft' check (status in ('draft','sent','viewed','signed','voided','expired')),
  recipient_contact_id uuid references contacts(id) on delete set null,
  sent_to_email citext,
  sent_at timestamptz,
  viewed_at timestamptz,
  signed_at timestamptz,
  expires_at timestamptz,
  max_uses integer not null default 1,
  used_count integer not null default 0,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists document_signing_requests_token_hash_idx
  on document_signing_requests (token_hash) where token_hash is not null;
create index if not exists document_signing_requests_org_doc_created_idx
  on document_signing_requests (org_id, document_id, created_at desc);
create index if not exists document_signing_requests_document_id_idx on document_signing_requests (document_id);
create index if not exists document_signing_requests_recipient_contact_id_idx
  on document_signing_requests (recipient_contact_id) where recipient_contact_id is not null;

-- Signatures (field values + signer metadata)
create table if not exists document_signatures (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  signing_request_id uuid not null references document_signing_requests(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  revision integer not null,
  signer_name text,
  signer_email citext,
  signer_ip inet,
  user_agent text,
  consent_text text not null,
  values jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists document_signatures_org_doc_created_idx on document_signatures (org_id, document_id, created_at desc);
create index if not exists document_signatures_signing_request_id_idx on document_signatures (signing_request_id);
create index if not exists document_signatures_document_id_idx on document_signatures (document_id);

-- RLS
alter table documents enable row level security;
alter table document_fields enable row level security;
alter table document_signing_requests enable row level security;
alter table document_signatures enable row level security;

-- Policies (org-scoped; public signing handled via service role)
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'documents' and policyname = 'documents_access') then
    create policy documents_access on documents
      for all using (auth.role() = 'service_role' or is_org_member(org_id))
      with check (auth.role() = 'service_role' or is_org_member(org_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'document_fields' and policyname = 'document_fields_access') then
    create policy document_fields_access on document_fields
      for all using (auth.role() = 'service_role' or is_org_member(org_id))
      with check (auth.role() = 'service_role' or is_org_member(org_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'document_signing_requests' and policyname = 'document_signing_requests_access') then
    create policy document_signing_requests_access on document_signing_requests
      for all using (auth.role() = 'service_role' or is_org_member(org_id))
      with check (auth.role() = 'service_role' or is_org_member(org_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'document_signatures' and policyname = 'document_signatures_access') then
    create policy document_signatures_access on document_signatures
      for all using (auth.role() = 'service_role' or is_org_member(org_id))
      with check (auth.role() = 'service_role' or is_org_member(org_id));
  end if;
end$$;
