create table public.document_exports (
  id uuid primary key,
  org_id uuid not null references public.orgs(id),
  created_by uuid not null references public.app_users(id),
  file_ids uuid[] not null check (cardinality(file_ids) between 1 and 500),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'array'),
  status text not null default 'queued' check (status in ('queued', 'processing', 'ready', 'failed', 'expired')),
  storage_path text,
  attempt_id uuid,
  lease_until timestamptz,
  error_message text,
  expires_at timestamptz not null default (now() + interval '1 day'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.document_exports enable row level security;
revoke all on public.document_exports from public, anon, authenticated;
grant all on public.document_exports to service_role;
create index document_exports_org_owner_idx on public.document_exports(org_id, created_by, created_at);
create index document_exports_creator_idx on public.document_exports(created_by);
create trigger document_exports_updated_at before update on public.document_exports
for each row execute function public.tg_set_updated_at();
create function public.queue_document_export() returns trigger language plpgsql set search_path = public as $$
begin
  insert into public.outbox(org_id, job_type, payload, dedupe_key)
  values (new.org_id, 'export_documents', jsonb_build_object('export_id', new.id), 'export_documents:' || new.id::text);
  insert into public.outbox(org_id, job_type, payload, run_at, dedupe_key)
  values (new.org_id, 'cleanup_document_export', jsonb_build_object('export_id', new.id), new.expires_at,
    'cleanup_document_export:' || new.id::text);
  return new;
end;
$$;
revoke all on function public.queue_document_export() from public, anon, authenticated;
create trigger document_exports_queue after insert on public.document_exports
for each row execute function public.queue_document_export();

create function public.claim_document_export(p_org_id uuid, p_id uuid, p_attempt_id uuid)
returns setof public.document_exports language plpgsql set search_path = public as $$
declare claimed public.document_exports;
begin
  update public.document_exports set status = 'processing', attempt_id = p_attempt_id,
    lease_until = now() + interval '15 minutes', error_message = null
  where org_id = p_org_id and id = p_id and expires_at > now()
    and (status in ('queued', 'failed') or (status = 'processing' and lease_until < now()))
  returning * into claimed;
  if claimed.id is null then return; end if;
  -- An upload can finish after the first expiry sweep. The worker's platform
  -- deadline is 300s, below this 15-minute lease, so this sweep runs after every
  -- attempt admitted before expiry has stopped, including crashed workers.
  insert into public.outbox(org_id,job_type,payload,run_at,dedupe_key)
  values(p_org_id,'cleanup_document_export',jsonb_build_object('export_id',p_id),
    claimed.expires_at+interval '15 minutes','cleanup_document_export:'||p_id::text||':'||p_attempt_id::text)
  on conflict do nothing;
  return next claimed;
end;
$$;
revoke all on function public.claim_document_export(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_document_export(uuid,uuid,uuid) to service_role;
