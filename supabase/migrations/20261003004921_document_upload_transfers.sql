-- Server-owned transfer reservations. Browser identities cannot change the scope
-- or storage key after reservation; completion is reconciled against R2 metadata.
create table public.document_upload_transfers (
  id uuid primary key,
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  created_by uuid not null references public.app_users(id),
  identity text not null check (identity ~ '^sha256-chain-v1:[0-9]+:[0-9a-f]{64}$'),
  file_name text not null,
  content_type text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 104857600),
  storage_path text not null unique,
  mode text not null check (mode in ('single', 'multipart')),
  upload_id text,
  part_size integer not null default 16777216 check (part_size > 0),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.document_upload_transfers enable row level security;
revoke all on public.document_upload_transfers from public, anon, authenticated;
grant all on public.document_upload_transfers to service_role;
create index document_upload_transfers_project_idx on public.document_upload_transfers(org_id, project_id);
create index document_upload_transfers_owner_idx on public.document_upload_transfers(created_by, created_at);
create trigger document_upload_transfers_updated_at before update on public.document_upload_transfers
for each row execute function public.tg_set_updated_at();

alter table public.document_upload_transfers add column expires_at timestamptz not null default (now() + interval '7 days');
create function public.queue_document_transfer_cleanup() returns trigger language plpgsql set search_path = public as $$
begin
  insert into public.outbox(org_id, job_type, payload, run_at, dedupe_key)
  values (new.org_id, 'cleanup_document_transfer', jsonb_build_object('transfer_id', new.id), new.expires_at,
    'cleanup_document_transfer:' || new.id::text);
  return new;
end;
$$;
revoke all on function public.queue_document_transfer_cleanup() from public, anon, authenticated;
create trigger document_transfer_cleanup after insert on public.document_upload_transfers
for each row execute function public.queue_document_transfer_cleanup();
